/**
 * Agent — the core LLM agent loop.
 *
 * Orchestrates multi-turn, tool-calling conversations via any LanguageModel
 * (from the ai SDK). Manages conversation state, tool execution,
 * steering queue, and abort handling.
 *
 * No Workers-specific globals. No gateway or session concepts.
 * Suitable for use inside Durable Objects or any async context.
 *
 * The caller (piccolo-core AgentSessionDO) is responsible for constructing
 * the LanguageModel (via createModel() from gateway.ts or a mock in tests).
 *
 * Spec ref: specs/core.md §Agent Loop
 */

import type { AgentEvent, ISession, ITool } from "@piccolo/api";
import type { FinishReason, ImagePart, LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import { toAiSdkTools } from "./agent-tools.ts";

// ─── AgentTurn ────────────────────────────────────────────────────────────────

/**
 * A handle to the currently active agent turn.
 * Returned synchronously by Agent.prompt().
 * Internal to piccolo-core — not part of the JSRPC API surface.
 * The JSRPC-facing turn is ITurn (in @piccolo/api), which wraps this stream.
 *
 * Spec ref: specs/core.md §Agent Loop §AgentTurn
 */
export interface AgentTurn {
  /** The AgentEvent stream for this turn. Single-consumer. */
  readonly stream: ReadableStream<AgentEvent>;
  /** Abort this turn immediately. No-op after the turn completes. */
  abort(): void;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_STEERING_MODE = "one-at-a-time" as const;

export class Agent {
  private readonly _maxSteps: number;
  private readonly _steeringMode: "one-at-a-time" | "all";

  // ── Agent state fields (no separate AgentState interface) ──────────────────
  private _model: LanguageModel;
  private _systemPrompt: string;
  private _tools: ITool[];
  private _messages: ModelMessage[];
  private _isStreaming: boolean;
  private _error: string | undefined;

  private _steeringQueue: ModelMessage[] = [];
  private _currentTurn: AgentTurn | null = null;

  /**
   * Session context threaded into every tool execute() call.
   * piccolo-core sets this to the live ISession before each prompt().
   * Spec ref: specs/core.md §Agent Loop §setContext
   */
  private _ctx: ISession | null = null;

  constructor(options: {
    model: LanguageModel;
    systemPrompt: string;
    tools?: ITool[];
    maxSteps?: number;
    steeringMode?: "one-at-a-time" | "all";
  }) {
    this._maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this._steeringMode = options.steeringMode ?? DEFAULT_STEERING_MODE;
    this._model = options.model;
    this._systemPrompt = options.systemPrompt;
    this._tools = options.tools ?? [];
    this._messages = [];
    this._isStreaming = false;
  }

  // ─── State accessors ──────────────────────────────────────────────────────

  get state(): {
    model: LanguageModel;
    systemPrompt: string;
    tools: ITool[];
    messages: ModelMessage[];
    isStreaming: boolean;
    error?: string;
  } {
    return {
      model: this._model,
      systemPrompt: this._systemPrompt,
      tools: this._tools,
      messages: this._messages,
      isStreaming: this._isStreaming,
      ...(this._error !== undefined ? { error: this._error } : {}),
    };
  }

  // ─── Synchronous state mutations ──────────────────────────────────────────

  setModel(model: LanguageModel): void {
    this._model = model;
  }

  setTools(tools: ITool[]): void {
    this._tools = tools;
  }

  /**
   * Set the session context threaded into tool execute() calls.
   * piccolo-core calls this with the live ISession before each prompt().
   * Spec ref: specs/core.md §Agent Loop §setContext
   */
  setContext(ctx: ISession): void {
    this._ctx = ctx;
  }

  setSystemPrompt(prompt: string): void {
    this._systemPrompt = prompt;
  }

  appendMessages(messages: ModelMessage[]): void {
    this._messages = [...this._messages, ...messages];
  }

  replaceMessages(messages: ModelMessage[]): void {
    this._messages = messages;
  }

  // ─── Steering queue ───────────────────────────────────────────────────────

  /**
   * Inject a message mid-turn (after the next tool batch, before the next LLM call).
   */
  steer(message: ModelMessage): void {
    this._steeringQueue.push(message);
  }

  clearSteering(): ModelMessage[] {
    const msgs = this._steeringQueue;
    this._steeringQueue = [];
    return msgs;
  }

  // ─── Abort ────────────────────────────────────────────────────────────────

  /**
   * Abort the currently streaming turn. Delegates to the current AgentTurn.
   * No-op if idle.
   */
  abort(): void {
    this._currentTurn?.abort();
  }

  // ─── Turn lifecycle ───────────────────────────────────────────────────────

  /**
   * Return the active AgentTurn, or null if idle. Synchronous.
   * Spec ref: specs/core.md §Agent Loop §getCurrentTurn
   */
  getCurrentTurn(): AgentTurn | null {
    return this._currentTurn;
  }

  /**
   * Start a new agent turn with user text (and optional images).
   * Throws if a turn is already in progress.
   * Returns an AgentTurn synchronously — the stream starts filling immediately.
   */
  prompt(text: string, images?: ImagePart[]): AgentTurn;
  /**
   * Start a new agent turn with pre-built messages.
   * Throws if a turn is already in progress.
   */
  prompt(messages: ModelMessage[]): AgentTurn;
  prompt(input: string | ModelMessage[], images?: ImagePart[]): AgentTurn {
    if (this._currentTurn !== null) {
      throw new Error("A turn is already in progress. Call abort() first.");
    }

    let newMessages: ModelMessage[];
    if (typeof input === "string") {
      if (images && images.length > 0) {
        newMessages = [{ role: "user", content: [{ type: "text", text: input }, ...images] }];
      } else {
        newMessages = [{ role: "user", content: input }];
      }
    } else {
      newMessages = input;
    }

    if (newMessages.length > 0) {
      this._messages.push(...newMessages);
    }

    return this._startTurn();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private _startTurn(): AgentTurn {
    const ac = new AbortController();

    let controller!: ReadableStreamDefaultController<AgentEvent>;
    const stream = new ReadableStream<AgentEvent>({
      start(c) {
        controller = c;
      },
    });

    const turn: AgentTurn = {
      stream,
      abort: () => ac.abort(),
    };
    this._currentTurn = turn;

    // Kick off async — the stream fills via controller.enqueue()
    void this._runStream(controller, ac.signal);

    return turn;
  }

  private async _runStream(
    controller: ReadableStreamDefaultController<AgentEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    this._isStreaming = true;
    this._error = undefined;

    // ── Debug logging ──────────────────────────────────────────────────────────
    console.debug(
      "[agent] _runStream start — model=%s systemPrompt=%d chars messages=%d",
      typeof this._model === "object" && this._model !== null && "modelId" in this._model
        ? String((this._model as { modelId: string }).modelId)
        : String(this._model),
      this._systemPrompt.length,
      this._messages.length,
    );
    for (let i = 0; i < this._messages.length; i++) {
      const msg = this._messages[i];
      if (msg === undefined) continue;
      const contentPreview =
        typeof msg.content === "string"
          ? msg.content.slice(0, 120)
          : JSON.stringify(msg.content).slice(0, 120);
      console.debug("[agent]   msg[%d] role=%s content=%s", i, msg.role, contentPreview);
    }
    // ──────────────────────────────────────────────────────────────────────────

    const emit = (event: AgentEvent) => {
      console.debug("[agent] emit", JSON.stringify(event));
      controller.enqueue(event);
    };

    emit({ type: "agent_start" });

    const ctx = this._ctx;
    if (ctx === null) {
      throw new Error("Agent context not set. Call setContext() before prompt().");
    }
    const toolSet = toAiSdkTools(this._tools, ctx);
    let aborted = false;
    let finalUsage: LanguageModelUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
    };

    try {
      const result = streamText({
        model: this._model,
        system: this._systemPrompt,
        messages: this._messages,
        tools: toolSet,
        stopWhen: stepCountIs(this._maxSteps),
        abortSignal: signal,

        prepareStep: ({ stepNumber, messages }) => {
          if (stepNumber > 0 && this._steeringQueue.length > 0) {
            const steering = this._dequeueSteer();
            return Promise.resolve({ messages: [...messages, ...steering] });
          }
          return Promise.resolve(undefined);
        },

        onChunk: ({ chunk }) => {
          console.debug("[agent] onChunk type=%s", chunk.type);
          switch (chunk.type) {
            case "text-delta":
              emit({ type: "text_delta", delta: chunk.text });
              break;
            case "reasoning-delta":
              emit({ type: "reasoning_delta", delta: chunk.text });
              break;
            case "tool-call":
              emit({
                type: "tool_start",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              });
              break;
            case "tool-result":
              emit({
                type: "tool_end",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                output: chunk.output,
                isError: false,
              });
              break;
          }
        },

        onStepFinish: ({ stepNumber, finishReason, usage, content }) => {
          console.debug("[agent] onStepFinish step=%d reason=%s", stepNumber, finishReason);
          for (const part of content) {
            if (part.type === "tool-error") {
              const errMsg = part.error instanceof Error ? part.error.message : String(part.error);
              emit({
                type: "tool_end",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: errMsg,
                isError: true,
              });
            }
          }
          emit({
            type: "turn_end",
            stepNumber,
            finishReason: finishReason as FinishReason,
            usage,
          });
        },

        onFinish: ({ totalUsage, response }) => {
          console.debug("[agent] onFinish messages=%d", response.messages.length);
          finalUsage = totalUsage;
          this._messages.push(...response.messages);
        },

        onError: ({ error }) => {
          const message = error instanceof Error ? error.message : String(error);
          console.debug("[agent] onError message=%s", message);
          this._error = message;
          emit({ type: "error", message });
        },

        onAbort: () => {
          console.debug("[agent] onAbort");
          aborted = true;
        },
      });

      console.debug("[agent] consumeStream starting");
      await result.consumeStream();
      console.debug("[agent] consumeStream done");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.debug("[agent] consumeStream catch: %s", message);
      if (!aborted) {
        this._error = message;
        emit({ type: "error", message });
      }
    } finally {
      console.debug("[agent] finally aborted=%s", aborted);
      this._isStreaming = false;
      if (!aborted) {
        emit({ type: "agent_end", totalUsage: finalUsage });
      }
      this._currentTurn = null;
      controller.close();
    }
  }

  private _dequeueSteer(): ModelMessage[] {
    if (this._steeringMode === "all") {
      const msgs = this._steeringQueue;
      this._steeringQueue = [];
      return msgs;
    }
    const msg = this._steeringQueue.shift();
    return msg !== undefined ? [msg] : [];
  }
}
