/**
 * Context compaction helpers.
 *
 * Compaction is triggered by piccolo-core when context usage exceeds a threshold.
 * The agent loop itself does not trigger compaction — that is the DO's responsibility.
 *
 * agentCompact() uses generateText (non-streaming) with the same LanguageModel
 * that is passed to the Agent, summarising older messages so they can be replaced
 * with a single compact summary entry.
 */

import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Heuristic characters-per-token ratio used for token estimation.
 * Real tokenisation is model-specific; this approximation is sufficient for
 * deciding the compaction split point.
 */
const CHARS_PER_TOKEN = 4;

/**
 * System prompt used for the LLM summarisation call.
 * The LLM receives the serialised conversation and returns a compact summary.
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summariser. Your task is to produce a concise, complete summary of the conversation you are given.

Rules:
- Preserve all decisions made, facts established, and tool results obtained.
- Preserve the user's original goals and any open tasks.
- Do NOT invent information not present in the conversation.
- Write in past tense from the perspective of an observer.
- Output plain prose only — no bullet lists, no headings, no markdown.
- Be thorough but concise. Aim for under 500 words unless the conversation demands more.`;

// ─── Split ────────────────────────────────────────────────────────────────────

export interface CompactionSplit {
  /** Messages to summarise (older). May be empty if all messages fit in keepRecentTokens. */
  toSummarize: ModelMessage[];
  /** Messages to keep verbatim (newest). Always non-empty. */
  toKeep: ModelMessage[];
}

/**
 * Split a message array into a portion to summarise and a portion to keep.
 *
 * Walks messages from newest to oldest, accumulating an estimated token count.
 * Messages within keepRecentTokens are kept verbatim; older messages are
 * candidates for summarisation.
 *
 * At least one message is always kept to ensure the conversation is not empty.
 */
export function splitForCompaction(
  messages: ModelMessage[],
  keepRecentTokens: number,
): CompactionSplit {
  if (messages.length === 0) {
    return { toSummarize: [], toKeep: [] };
  }

  let tokenCount = 0;
  let splitIndex = messages.length; // index of first message to keep

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined) continue;
    const chars = estimateMessageChars(msg);
    const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
    tokenCount += tokens;

    if (tokenCount > keepRecentTokens) {
      // This message would push us over the budget — stop before it.
      // But always keep at least one message.
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

// ─── Serialisation ────────────────────────────────────────────────────────────

/**
 * Serialise a message array to a human-readable string for the summarisation LLM.
 */
export function serializeConversation(messages: ModelMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.role.toUpperCase();
      const content = serializeMessageContent(msg);
      return `[${role}]\n${content}`;
    })
    .join("\n\n");
}

// ─── Compaction ───────────────────────────────────────────────────────────────

/**
 * Compact a message array by summarising older messages with an LLM call.
 *
 * Accepts the same LanguageModel used by the Agent — no separate gateway
 * construction needed.
 *
 * Returns the summary text and the messages that were kept verbatim.
 * The caller (piccolo-core AgentSessionDO) is responsible for persisting the
 * CompactionEntry and updating the agent's message history.
 */
export async function agentCompact(
  messages: ModelMessage[],
  keepRecentTokens: number,
  model: LanguageModel,
): Promise<{ summary: string; keptMessages: ModelMessage[] }> {
  const { toSummarize, toKeep } = splitForCompaction(messages, keepRecentTokens);

  if (toSummarize.length === 0) {
    // Nothing to summarise — return empty summary.
    return { summary: "", keptMessages: toKeep };
  }

  const conversationText = serializeConversation(toSummarize);

  const { text: summary } = await generateText({
    model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: conversationText }],
  });

  return { summary, keptMessages: toKeep };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function estimateMessageChars(msg: ModelMessage): number {
  if (typeof msg.content === "string") {
    return msg.content.length;
  }
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, part) => {
      if (typeof part === "object" && part !== null && "type" in part) {
        if (part.type === "text" && "text" in part && typeof part.text === "string") {
          return sum + part.text.length;
        }
        if (part.type === "tool-result" && "content" in part && typeof part.content === "string") {
          return sum + part.content.length;
        }
      }
      return sum + 50; // rough estimate for non-text parts
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
      .map((part) => {
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
