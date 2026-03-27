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
 * Agent extends ObservableImpl<AgentEvent> — it IS the observable. Subscribers
 * receive all AgentEvents for all turns for the agent's lifetime. The DO
 * subscribes once in _init and forwards events to the session observable.
 *
 * The caller (piccolo-core AgentSessionDO) is responsible for constructing
 * the LanguageModel (via createModel() from gateway.ts or a mock in tests).
 *
 * Spec ref: specs/core.md §Agent Loop
 */

import type { AgentEvent, ISession, ITool } from "@piccolo/api";
import type { FinishReason, ImagePart, LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { modelMessageSchema, stepCountIs, streamText } from "ai";
import { toAiSdkTools } from "./agent-tools.ts";
import { ObservableImpl } from "./observable-impl.ts";

// ─── AgentTurn ────────────────────────────────────────────────────────────────

/**
 * A handle to the currently active agent turn.
 * Returned synchronously by Agent.prompt().
 * Internal to piccolo-core — not part of the JSRPC API surface.
 *
 * Spec ref: specs/core.md §Agent Loop §AgentTurn
 */
export interface AgentTurn {
  /** Abort this turn immediately. No-op after the turn completes. */
  abort(): void;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_STEERING_MODE = "one-at-a-time" as const;

export class Agent extends ObservableImpl<AgentEvent> {
  private readonly _maxSteps: number;
  private readonly _steeringMode: "one-at-a-time" | "all";

  // ── Agent state fields (no separate AgentState interface) ──────────────────
  private _model: LanguageModel;
  private _systemPrompt: string;
  private _tools: ITool[];
  private _messages: ModelMessage[];
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
    super();
    this._maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this._steeringMode = options.steeringMode ?? DEFAULT_STEERING_MODE;
    this._model = options.model;
    this._systemPrompt = options.systemPrompt;
    this._tools = options.tools ?? [];
    this._messages = [];
  }

  // ─── State accessors ──────────────────────────────────────────────────────

  get state(): {
    model: LanguageModel;
    systemPrompt: string;
    tools: ITool[];
    messages: ModelMessage[];
    error?: string;
  } {
    return {
      model: this._model,
      systemPrompt: this._systemPrompt,
      tools: this._tools,
      messages: this._messages,
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
    const turn: AgentTurn = { abort: () => ac.abort() };
    this._currentTurn = turn;

    // Kick off async — events emitted via this.emit()
    void this._runStream(ac.signal);

    return turn;
  }

  private async _runStream(signal: AbortSignal): Promise<void> {
    this._error = undefined;

    this.emit({ type: "start" });

    const ctx = this._ctx;
    if (ctx === null) {
      throw new Error("Agent context not set. Call setContext() before prompt().");
    }
    const toolSet = await toAiSdkTools(this._tools, ctx);
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
      for (let i = 0; i < this._messages.length; i++) {
        const check = modelMessageSchema.safeParse(this._messages[i]);
        if (!check.success) {
          const msg = `[agent] invalid ModelMessage at index ${i}: ${JSON.stringify(this._messages[i])} — ${JSON.stringify(check.error.issues)}`;
          console.error(msg);
          this.emit({ type: "error", message: msg });
        }
      }
      const result = streamText({
        model: this._model,
        system: this._systemPrompt,
        messages: this._messages,
        tools: toolSet,
        stopWhen: stepCountIs(this._maxSteps),
        abortSignal: signal,

        prepareStep: ({ stepNumber, messages }) => {
          this.emit({ type: "step-start", stepNumber });
          if (stepNumber > 0 && this._steeringQueue.length > 0) {
            const steering = this._dequeueSteer();
            return Promise.resolve({ messages: [...messages, ...steering] });
          }
          return Promise.resolve(undefined);
        },

        onChunk: ({ chunk }) => {
          switch (chunk.type) {
            case "text-delta":
              this.emit({ type: "text-delta", delta: chunk.text });
              break;
            case "reasoning-delta":
              this.emit({ type: "reasoning-delta", delta: chunk.text });
              break;
            case "tool-call":
              this.emit({
                type: "tool-call",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              });
              break;
            case "tool-result":
              this.emit({
                type: "tool-result",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                output: chunk.output,
                isError: false,
              });
              break;
          }
        },

        onStepFinish: ({ stepNumber, finishReason, usage, content }) => {
          for (const part of content) {
            if (part.type === "tool-error") {
              const errMsg = part.error instanceof Error ? part.error.message : String(part.error);
              this.emit({
                type: "tool-result",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: errMsg,
                isError: true,
              });
            }
          }
          this.emit({
            type: "step-finish",
            stepNumber,
            finishReason: finishReason as FinishReason,
            usage,
          });
        },

        onFinish: ({ totalUsage, response }) => {
          finalUsage = totalUsage;
          this._messages.push(...response.messages);
        },

        onError: ({ error }) => {
          const message = error instanceof Error ? error.message : String(error);
          this._error = message;
          this._currentTurn = null;
          this.emit({ type: "error", message });
        },

        onAbort: () => {
          aborted = true;
        },
      });

      await result.consumeStream();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!aborted) {
        this._error = message;
        this._currentTurn = null;
        this.emit({ type: "error", message });
      }
    } finally {
      this._currentTurn = null;
      if (!aborted) {
        this.emit({ type: "finish", totalUsage: finalUsage });
      }
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
