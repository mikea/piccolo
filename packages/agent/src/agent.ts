/**
 * Agent — the core LLM agent loop.
 *
 * Orchestrates multi-turn, tool-calling conversations via any LanguageModel
 * (from the ai SDK). Manages conversation state, tool execution,
 * steering/follow-up queues, and abort handling.
 *
 * No Workers-specific globals. No gateway or session concepts.
 * Suitable for use inside Durable Objects or any async context.
 *
 * The caller (piccolo-core) is responsible for constructing the LanguageModel
 * (via createModel() from gateway.ts or a mock in tests).
 */

import type { FinishReason, ImagePart, LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import { toAiSdkTools } from "./tools.ts";
import type { AgentEvent, AgentOptions, AgentState, IAgentTool } from "./types.ts";

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_STEERING_MODE = "one-at-a-time" as const;
const DEFAULT_FOLLOW_UP_MODE = "one-at-a-time" as const;

export class Agent {
  private readonly _maxSteps: number;
  private readonly _steeringMode: "one-at-a-time" | "all";
  private readonly _followUpMode: "one-at-a-time" | "all";

  private _state: AgentState;
  private _steeringQueue: ModelMessage[] = [];
  private _followUpQueue: ModelMessage[] = [];
  private _abortController: AbortController | null = null;
  private _listeners: Set<(event: AgentEvent) => void> = new Set();

  constructor(options: AgentOptions) {
    this._maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this._steeringMode = options.steeringMode ?? DEFAULT_STEERING_MODE;
    this._followUpMode = options.followUpMode ?? DEFAULT_FOLLOW_UP_MODE;

    this._state = {
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: options.tools ?? [],
      messages: [],
      isStreaming: false,
    };
  }

  // ─── State access ─────────────────────────────────────────────────────────

  get state(): AgentState {
    return this._state;
  }

  // ─── Subscription ─────────────────────────────────────────────────────────

  /**
   * Subscribe to agent events. Returns an unsubscribe function.
   */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  // ─── Synchronous state mutations ──────────────────────────────────────────

  setModel(model: LanguageModel): void {
    this._state = { ...this._state, model };
  }

  setTools(tools: IAgentTool[]): void {
    this._state = { ...this._state, tools };
  }

  setSystemPrompt(prompt: string): void {
    this._state = { ...this._state, systemPrompt: prompt };
  }

  appendMessages(messages: ModelMessage[]): void {
    this._state = { ...this._state, messages: [...this._state.messages, ...messages] };
  }

  replaceMessages(messages: ModelMessage[]): void {
    this._state = { ...this._state, messages };
  }

  // ─── Steering / Follow-up queues ──────────────────────────────────────────

  /**
   * Inject a message mid-turn (after the next tool batch, before the next LLM call).
   * If no turn is active the message will be dequeued on the next prompt()'s first step.
   */
  steer(message: ModelMessage): void {
    this._steeringQueue.push(message);
  }

  /**
   * Queue a message to be sent when the current turn finishes naturally.
   * Triggers agent.continue() after onFinish fires.
   */
  followUp(message: ModelMessage): void {
    this._followUpQueue.push(message);
  }

  /**
   * Return and clear all pending steering messages.
   */
  clearSteering(): ModelMessage[] {
    const msgs = this._steeringQueue;
    this._steeringQueue = [];
    return msgs;
  }

  /**
   * Return and clear all pending follow-up messages.
   */
  clearFollowUp(): ModelMessage[] {
    const msgs = this._followUpQueue;
    this._followUpQueue = [];
    return msgs;
  }

  // ─── Abort ────────────────────────────────────────────────────────────────

  /**
   * Abort the currently streaming turn immediately.
   * The AI SDK propagates the signal to the model and to all tool execute() calls.
   */
  abort(): void {
    this._abortController?.abort();
  }

  // ─── Conversation ─────────────────────────────────────────────────────────

  /**
   * Start a new agent turn with user text (and optional images).
   */
  async prompt(text: string, images?: ImagePart[]): Promise<void>;
  /**
   * Start a new agent turn with pre-built messages (e.g. from the core after
   * rehydration or when forwarding structured content).
   */
  async prompt(messages: ModelMessage[]): Promise<void>;
  async prompt(input: string | ModelMessage[], images?: ImagePart[]): Promise<void> {
    // Build user message(s) to append
    let newMessages: ModelMessage[];
    if (typeof input === "string") {
      if (images && images.length > 0) {
        newMessages = [
          {
            role: "user",
            content: [{ type: "text", text: input }, ...images],
          },
        ];
      } else {
        newMessages = [{ role: "user", content: input }];
      }
    } else {
      newMessages = input;
    }

    this._state.messages.push(...newMessages);
    await this._runStream();
  }

  /**
   * Resume streaming without new user input.
   * Called after onFinish when the follow-up queue is non-empty, or by the DO
   * after compaction to continue with the updated message history.
   */
  async continue(): Promise<void> {
    const followUp = this._dequeueFollowUp();
    if (followUp.length > 0) {
      this._state.messages.push(...followUp);
    }
    await this._runStream();
  }

  // ─── Internal streaming ───────────────────────────────────────────────────

  private async _runStream(): Promise<void> {
    this._abortController = new AbortController();
    // Reset streaming state; omit the error key to satisfy exactOptionalPropertyTypes.
    const { error: _discarded, ...stateWithoutError } = this._state;
    this._state = { ...stateWithoutError, isStreaming: true };
    this._emit({ type: "agent_start" });

    const toolSet = toAiSdkTools(this._state.tools);
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
        model: this._state.model,
        system: this._state.systemPrompt,
        messages: this._state.messages,
        tools: toolSet,
        stopWhen: stepCountIs(this._maxSteps),
        abortSignal: this._abortController.signal,

        prepareStep: ({ stepNumber, messages }) => {
          // After the first step, inject any pending steering messages.
          if (stepNumber > 0 && this._steeringQueue.length > 0) {
            const steering = this._dequeueSteer();
            return Promise.resolve({ messages: [...messages, ...steering] });
          }
          return Promise.resolve(undefined);
        },

        onChunk: ({ chunk }) => {
          switch (chunk.type) {
            case "text-delta":
              this._emit({ type: "text_delta", delta: chunk.text });
              break;
            case "reasoning-delta":
              this._emit({ type: "reasoning_delta", delta: chunk.text });
              break;
            case "tool-call":
              this._emit({
                type: "tool_start",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              });
              break;
            case "tool-result":
              this._emit({
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
          // Emit tool_end for any tool errors — these do not appear in onChunk in ai v6.
          for (const part of content) {
            if (part.type === "tool-error") {
              const errMsg = part.error instanceof Error ? part.error.message : String(part.error);
              this._emit({
                type: "tool_end",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: errMsg,
                isError: true,
              });
            }
          }
          this._emit({
            type: "turn_end",
            stepNumber,
            finishReason: finishReason as FinishReason,
            usage,
          });
        },

        onFinish: ({ totalUsage, response }) => {
          finalUsage = totalUsage;
          // Append all response messages (assistant + tool) to state history.
          this._state.messages.push(...response.messages);
        },

        onError: ({ error }) => {
          const message = error instanceof Error ? error.message : String(error);
          this._state = { ...this._state, error: message };
          this._emit({ type: "error", message });
        },

        onAbort: () => {
          aborted = true;
        },
      });

      await result.consumeStream();
    } catch (e) {
      // consumeStream() rejects if the stream itself throws (e.g. network error
      // not caught by onError). Surface as an error event.
      const message = e instanceof Error ? e.message : String(e);
      if (!aborted) {
        this._state = { ...this._state, error: message };
        this._emit({ type: "error", message });
      }
    } finally {
      this._state = { ...this._state, isStreaming: false };
      if (!aborted) {
        this._emit({ type: "agent_end", totalUsage: finalUsage });
      }
      this._abortController = null;
    }

    // If not aborted and follow-up queue has items, trigger a continuation turn.
    if (!aborted && this._followUpQueue.length > 0) {
      await this.continue();
    }
  }

  // ─── Queue helpers ────────────────────────────────────────────────────────

  private _dequeueSteer(): ModelMessage[] {
    if (this._steeringMode === "all") {
      const msgs = this._steeringQueue;
      this._steeringQueue = [];
      return msgs;
    }
    // one-at-a-time
    const msg = this._steeringQueue.shift();
    return msg !== undefined ? [msg] : [];
  }

  private _dequeueFollowUp(): ModelMessage[] {
    if (this._followUpMode === "all") {
      const msgs = this._followUpQueue;
      this._followUpQueue = [];
      return msgs;
    }
    // one-at-a-time
    const msg = this._followUpQueue.shift();
    return msg !== undefined ? [msg] : [];
  }

  // ─── Event emission ───────────────────────────────────────────────────────

  private _emit(event: AgentEvent): void {
    for (const listener of this._listeners) {
      listener(event);
    }
  }
}
