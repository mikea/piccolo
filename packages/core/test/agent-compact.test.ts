/**
 * Unit tests for agent-compact.ts.
 *
 * Spec ref: specs/core.md §Agent Loop §agentCompact
 */

import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  agentCompact,
  SUMMARIZATION_SYSTEM_PROMPT,
  serializeConversation,
  splitForCompaction,
} from "../src/agent-compact.ts";
import { createMockModel } from "./do/mock-model.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantMsg(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function longMsg(chars: number): ModelMessage {
  return userMsg("x".repeat(chars));
}

// ─── splitForCompaction ───────────────────────────────────────────────────────

describe("splitForCompaction", () => {
  it("returns empty arrays for empty input", () => {
    const result = splitForCompaction([], 1000);
    expect(result.toSummarize).toEqual([]);
    expect(result.toKeep).toEqual([]);
  });

  it("keeps all messages when they fit within keepRecentTokens", () => {
    const msgs: ModelMessage[] = [userMsg("hello"), assistantMsg("world")];
    const result = splitForCompaction(msgs, 1000);
    expect(result.toSummarize).toEqual([]);
    expect(result.toKeep).toHaveLength(2);
  });

  it("splits when messages exceed keepRecentTokens", () => {
    const msgs: ModelMessage[] = [longMsg(1000), longMsg(1000), longMsg(1000)];
    const result = splitForCompaction(msgs, 300);
    expect(result.toKeep.length).toBeGreaterThanOrEqual(1);
    expect(result.toSummarize.length).toBeGreaterThanOrEqual(1);
    expect(result.toSummarize.length + result.toKeep.length).toBe(3);
  });

  it("always keeps at least the newest message", () => {
    const msgs: ModelMessage[] = [longMsg(10000)];
    const result = splitForCompaction(msgs, 1);
    expect(result.toKeep).toHaveLength(1);
    expect(result.toSummarize).toHaveLength(0);
  });

  it("keeps exact boundary messages correctly", () => {
    // 4 chars per token, budget 10 tokens = 40 chars
    const msgs: ModelMessage[] = [userMsg("a".repeat(40)), userMsg("b".repeat(40))];
    const result = splitForCompaction(msgs, 10);
    expect(result.toKeep).toHaveLength(1);
    expect(result.toSummarize).toHaveLength(1);
  });

  it("preserves message order", () => {
    const msgs: ModelMessage[] = [userMsg("first"), assistantMsg("second"), userMsg("third")];
    const result = splitForCompaction(msgs, 5);
    const allMsgs = [...result.toSummarize, ...result.toKeep];
    expect(allMsgs).toEqual(msgs);
  });
});

// ─── serializeConversation ────────────────────────────────────────────────────

describe("serializeConversation", () => {
  it("serialises user messages with [USER] prefix", () => {
    const result = serializeConversation([userMsg("hello world")]);
    expect(result).toContain("[USER]");
    expect(result).toContain("hello world");
  });

  it("serialises assistant messages with [ASSISTANT] prefix", () => {
    const result = serializeConversation([assistantMsg("hi there")]);
    expect(result).toContain("[ASSISTANT]");
    expect(result).toContain("hi there");
  });

  it("serialises multiple messages separated by blank lines", () => {
    const result = serializeConversation([userMsg("q"), assistantMsg("a")]);
    expect(result.split("\n\n")).toHaveLength(2);
  });

  it("returns empty string for empty messages array", () => {
    expect(serializeConversation([])).toBe("");
  });

  it("serialises tool-call parts", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "my_tool", input: { key: "val" } },
        ],
      },
    ];
    const result = serializeConversation(msgs);
    expect(result).toContain("TOOL CALL: my_tool");
    expect(result).toContain('"key": "val"');
  });

  it("serialises tool-result parts", () => {
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "my_tool",
            content: "result text",
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const result = serializeConversation(msgs);
    expect(result).toContain("[TOOL]");
    expect(result).toContain("TOOL RESULT: call_1");
  });

  it("serialises reasoning parts", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "reasoning", text: "I need to think" }] },
    ] as unknown as ModelMessage[];
    const result = serializeConversation(msgs);
    expect(result).toContain("REASONING");
    expect(result).toContain("I need to think");
  });

  it("handles unknown part types via JSON fallback", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "unknown-type", data: "x" }] },
    ] as unknown as ModelMessage[];
    expect(serializeConversation(msgs)).toContain("[ASSISTANT]");
  });
});

// ─── agentCompact ────────────────────────────────────────────────────────────

describe("agentCompact", () => {
  it("returns empty summary when nothing to summarise", async () => {
    const msgs: ModelMessage[] = [userMsg("hi")];
    const { MockLanguageModelV3 } = await import("ai/test");
    const unusedModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("should not be called");
      },
    });
    const result = await agentCompact(msgs, 10_000, unusedModel);
    expect(result.summary).toBe("");
    expect(result.keptMessages).toEqual(msgs);
  });

  it("calls generateText and returns summary + kept messages", async () => {
    const msgs: ModelMessage[] = [longMsg(5000), longMsg(5000), userMsg("recent message")];
    const model = createMockModel({ response: "This is a summary of the conversation." });

    const result = await agentCompact(msgs, 200, model);

    expect(result.summary).toBeTruthy();
    expect(result.keptMessages.length).toBeGreaterThanOrEqual(1);
    expect(result.keptMessages[result.keptMessages.length - 1]).toEqual(userMsg("recent message"));
  });

  it("SUMMARIZATION_SYSTEM_PROMPT is non-empty and mentions summariser role", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT.length).toBeGreaterThan(50);
    expect(SUMMARIZATION_SYSTEM_PROMPT.toLowerCase()).toContain("summar");
  });
});

// Suppress unused import warning
void vi;
