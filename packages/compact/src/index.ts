import type { CompactResult, IExtension, IMessage, ISession } from "@piccolo/api";
import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";

const CHARS_PER_TOKEN = 4;

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summariser. Your task is to produce a concise, complete summary of the conversation you are given.

Rules:
- Preserve all decisions made, facts established, and tool results obtained.
- Preserve the user's original goals and any open tasks.
- Do NOT invent information not present in the conversation.
- Write in past tense from the perspective of an observer.
- Output plain prose only - no bullet lists, no headings, no markdown.
- Be thorough but concise. Aim for under 500 words unless the conversation demands more.`;

export function splitForCompaction(
  messages: IMessage[],
  keepRecentTokens: number,
): {
  toSummarize: IMessage[];
  toKeep: IMessage[];
} {
  if (messages.length === 0) {
    return { toSummarize: [], toKeep: [] };
  }

  let tokenCount = 0;
  let splitIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined) continue;
    const chars = estimateMessageChars(msg);
    const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
    tokenCount += tokens;

    if (tokenCount > keepRecentTokens) {
      splitIndex = Math.min(i + 1, messages.length - 1);
      break;
    }
    splitIndex = i;
  }

  return {
    toSummarize: messages.slice(0, splitIndex),
    toKeep: messages.slice(splitIndex),
  };
}

export function serializeConversation(messages: IMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.role.toUpperCase();
      const content = serializeMessageContent(msg);
      return `[${role}]\n${content}`;
    })
    .join("\n\n");
}

export async function agentCompact(
  messages: IMessage[],
  keepRecentTokens: number,
  model: LanguageModel,
): Promise<{ summary: string; toKeep: IMessage[] }> {
  const { toSummarize, toKeep } = splitForCompaction(messages, keepRecentTokens);

  if (toSummarize.length === 0) {
    return { summary: "", toKeep };
  }

  const conversationText = serializeConversation(toSummarize);

  const { text: summary } = await generateText({
    model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: conversationText }],
  });

  return { summary, toKeep };
}

export class CompactExtension implements IExtension {
  readonly #getModel: () => LanguageModel;

  constructor(getModel: () => LanguageModel) {
    this.#getModel = getModel;
  }

  async compact(
    _ctx: ISession,
    messages: IMessage[],
    keepRecentTokens: number,
  ): Promise<CompactResult | undefined> {
    const { summary, toKeep } = await agentCompact(messages, keepRecentTokens, this.#getModel());
    if (summary === "") return undefined;
    return {
      compaction: {
        summary,
        firstKeptEntryId: toKeep[0]?.id,
      },
    };
  }
}

function estimateMessageChars(msg: ModelMessage): number {
  if (typeof msg.content === "string") {
    return msg.content.length;
  }
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum: number, part: unknown) => {
      if (typeof part === "object" && part !== null && "type" in part) {
        if (part.type === "text" && "text" in part && typeof part.text === "string") {
          return sum + part.text.length;
        }
        if (part.type === "tool-result" && "content" in part && typeof part.content === "string") {
          return sum + part.content.length;
        }
      }
      return sum + 50;
    }, 0);
  }
  return 50;
}

function serializeMessageContent(msg: ModelMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part: unknown) => {
        if (typeof part === "object" && part !== null && "type" in part) {
          if (part.type === "text" && "text" in part) {
            return String(part.text);
          }
          if (part.type === "tool-call" && "toolName" in part && "input" in part) {
            return `[TOOL CALL: ${String(part.toolName)}]\n${JSON.stringify(part.input, null, 2)}`;
          }
          if (part.type === "tool-result" && "toolCallId" in part && "content" in part) {
            return `[TOOL RESULT: ${String(part.toolCallId)}]\n${typeof part.content === "string" ? part.content : JSON.stringify(part.content)}`;
          }
          if (part.type === "reasoning" && "text" in part) {
            return `[REASONING]\n${String(part.text)}`;
          }
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return String(msg.content);
}
