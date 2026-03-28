import type { HistoryEntry } from "@piccolo/api";
import type { ModelMessage } from "ai";
import { modelMessageSchema } from "ai";

export interface CompactMessagesResult {
  firstKeptEntryId: string;
  summaryMessage: ModelMessage;
  messages: Messages;
}

export class Messages {
  #sessionId: string;
  #messages: ModelMessage[];
  #messageToEntryId: Map<ModelMessage, string>;

  constructor(
    sessionId: string,
    messages: ModelMessage[] = [],
    messageToEntryId?: Map<ModelMessage, string>,
  ) {
    this.#sessionId = sessionId;
    this.#messages = messages;
    this.#messageToEntryId = messageToEntryId ?? new Map<ModelMessage, string>();
  }

  static compact(
    sessionId: string,
    messages: Messages,
    summary: string,
    keptMessages: ModelMessage[],
  ): CompactMessagesResult {
    const firstKeptMessage = keptMessages[0];
    const firstKeptEntryId =
      firstKeptMessage !== undefined ? (messages.getEntryId(firstKeptMessage) ?? "") : "";
    const summaryMessage: ModelMessage = {
      role: "user",
      content: `[Conversation Summary]\n\n${summary}`,
    };

    const next = new Messages(sessionId, [summaryMessage, ...keptMessages]);
    for (const kept of keptMessages) {
      const entryId = messages.getEntryId(kept);
      if (entryId !== undefined) {
        next.setEntryId(kept, entryId);
      }
    }
    return { firstKeptEntryId, summaryMessage, messages: next };
  }

  static toHistory(
    messages: ModelMessage[],
    messageToEntryId: Map<ModelMessage, string>,
    streaming: {
      isStreaming: boolean;
      assistantText: string;
      toolCalls: Map<string, { toolName: string; input: unknown }>;
    },
  ): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    const toolEntryIndex = new Map<string, number>();

    for (const msg of messages) {
      const id = messageToEntryId.get(msg) ?? Math.random().toString(36).slice(2);
      if (msg.role === "user") {
        const content = typeof msg.content === "string" ? msg.content : "[attachment]";
        entries.push({ type: "user", id, content });
      } else if (msg.role === "assistant") {
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part === "object" && part !== null && "type" in part) {
              if (part.type === "text" && "text" in part) {
                text += String(part.text);
              } else if (
                part.type === "tool-call" &&
                "toolName" in part &&
                "input" in part &&
                "toolCallId" in part
              ) {
                const toolCallId = String(part.toolCallId);
                const toolIdx = entries.length;
                toolEntryIndex.set(toolCallId, toolIdx);
                entries.push({
                  type: "tool",
                  id: toolCallId,
                  toolName: String(part.toolName),
                  input: part.input,
                  output: undefined,
                  isError: false,
                  isStreaming: false,
                });
              }
            }
          }
        }
        if (text.length > 0) {
          entries.push({ type: "assistant", id, content: text, isStreaming: false });
        }
      } else if (msg.role === "tool") {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "tool-result" &&
              "toolCallId" in part
            ) {
              const toolCallId = String(part.toolCallId);
              const idx = toolEntryIndex.get(toolCallId);
              if (idx !== undefined) {
                const existing = entries[idx];
                if (existing?.type === "tool") {
                  const isError = "isError" in part ? Boolean(part.isError) : false;
                  const output = "result" in part ? part.result : undefined;
                  entries[idx] = { ...existing, output, isError };
                }
              }
            }
          }
        }
      }
    }

    if (streaming.isStreaming) {
      for (const [toolCallId, tc] of streaming.toolCalls) {
        entries.push({
          type: "tool",
          id: toolCallId,
          toolName: tc.toolName,
          input: tc.input,
          output: undefined,
          isError: false,
          isStreaming: true,
        });
      }
      if (streaming.assistantText.length > 0) {
        entries.push({
          type: "assistant",
          id: "streaming",
          content: streaming.assistantText,
          isStreaming: true,
        });
      }
    }

    return entries;
  }

  static fromHistory(entries: HistoryEntry[]): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (const entry of entries) {
      if (entry.type === "user") {
        messages.push({ role: "user", content: entry.content });
      } else if (entry.type === "assistant") {
        messages.push({ role: "assistant", content: entry.content });
      } else if (entry.type === "tool") {
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: entry.id,
              toolName: entry.toolName,
              input: entry.input,
            },
          ],
        });
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: entry.id,
              toolName: entry.toolName,
              result: entry.output,
              ...(entry.isError ? { isError: true } : {}),
            },
          ],
        });
      } else if (entry.type === "error") {
        messages.push({ role: "assistant", content: `[Error] ${entry.message}` });
      }
    }
    return messages;
  }

  list(): ModelMessage[] {
    return this.#messages;
  }

  size(): number {
    return this.#messages.length;
  }

  slice(start?: number): ModelMessage[] {
    return this.#messages.slice(start);
  }

  push(msgs: ModelMessage[], source: string): void {
    this.#validateMany(msgs, source);
    this.#messages.push(...msgs);
  }

  replace(msgs: ModelMessage[], source: string): void {
    this.#validateMany(msgs, source);
    this.#messages = msgs;
  }

  clear(): void {
    this.#messages = [];
    this.#messageToEntryId = new Map<ModelMessage, string>();
  }

  setEntryId(msg: ModelMessage, entryId: string): void {
    this.#messageToEntryId.set(msg, entryId);
  }

  getEntryId(msg: ModelMessage): string | undefined {
    return this.#messageToEntryId.get(msg);
  }

  hasEntryId(msg: ModelMessage): boolean {
    return this.#messageToEntryId.has(msg);
  }

  entryMap(): Map<ModelMessage, string> {
    return this.#messageToEntryId;
  }

  #validateMany(msgs: ModelMessage[], source: string): void {
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg !== undefined) {
        this.#validateMessage(msg, source, i);
      }
    }
  }

  #validateMessage(msg: ModelMessage, source: string, index?: number): void {
    const check = modelMessageSchema.safeParse(msg);
    if (!check.success) {
      const loc = index !== undefined ? ` at index ${index}` : "";
      console.error(
        `[session:${this.#sessionId}] invalid ModelMessage${loc} from ${source}: ${JSON.stringify(msg)} — ${JSON.stringify(check.error.issues)}`,
      );
    }
  }
}
