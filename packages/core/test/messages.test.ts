import type { HistoryEntry } from "@piccolo/api";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Messages } from "../src/messages.ts";

describe("Messages", () => {
  it("validates on push/replace but keeps messages", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const messages = new Messages("s-1");

    const valid: ModelMessage = { role: "user", content: "hello" };
    const invalid = { role: "unknown", content: 123 } as unknown as ModelMessage;

    messages.push([valid, invalid], "test-push");
    expect(messages.size()).toBe(2);
    expect(spy).toHaveBeenCalled();

    messages.replace([valid], "test-replace");
    expect(messages.size()).toBe(1);
    spy.mockRestore();
  });

  it("converts model messages to history entries (including tool/result + streaming)", () => {
    const user: ModelMessage = { role: "user", content: "question" };
    const assistantToolCall: ModelMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call-1", toolName: "fetch", input: { q: "x" } },
        { type: "text", text: "done" },
      ],
    };
    const toolResult: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-1", toolName: "fetch", result: "ok" }],
    };

    const idMap = new Map<ModelMessage, string>([
      [user, "u-1"],
      [assistantToolCall, "a-1"],
      [toolResult, "t-1"],
    ]);

    const history = Messages.toHistory([user, assistantToolCall, toolResult], idMap, {
      isStreaming: true,
      assistantText: "streaming now",
      toolCalls: new Map([["call-live", { toolName: "search", input: { q: "live" } }]]),
    });

    expect(history).toEqual([
      { type: "user", id: "u-1", content: "question" },
      {
        type: "tool",
        id: "call-1",
        toolName: "fetch",
        input: { q: "x" },
        output: "ok",
        isError: false,
        isStreaming: false,
      },
      { type: "assistant", id: "a-1", content: "done", isStreaming: false },
      {
        type: "tool",
        id: "call-live",
        toolName: "search",
        input: { q: "live" },
        output: undefined,
        isError: false,
        isStreaming: true,
      },
      { type: "assistant", id: "streaming", content: "streaming now", isStreaming: true },
    ]);
  });

  it("converts history entries to model messages", () => {
    const history: HistoryEntry[] = [
      { type: "user", id: "u-1", content: "hi" },
      { type: "assistant", id: "a-1", content: "hello", isStreaming: false },
      {
        type: "tool",
        id: "tool-1",
        toolName: "lookup",
        input: { id: 1 },
        output: { ok: true },
        isError: false,
        isStreaming: false,
      },
      { type: "error", id: "e-1", message: "boom" },
    ];

    const messages = Messages.fromHistory(history);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tool-1", toolName: "lookup", input: { id: 1 } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "lookup",
            result: { ok: true },
          },
        ],
      },
      { role: "assistant", content: "[Error] boom" },
    ]);
  });

  it("compacts statelessly and returns first kept entry id + new Messages", () => {
    const prior = new Messages("s-1");
    const m1: ModelMessage = { role: "user", content: "one" };
    const m2: ModelMessage = { role: "assistant", content: "two" };
    prior.push([m1, m2], "seed");
    prior.setEntryId(m1, "e-1");
    prior.setEntryId(m2, "e-2");

    const result = Messages.compact("s-1", prior, "summary text", [m2]);

    expect(result.firstKeptEntryId).toBe("e-2");
    expect(result.messages.list()).toEqual([
      { role: "user", content: "[Conversation Summary]\n\nsummary text" },
      m2,
    ]);
    expect(result.messages.getEntryId(m2)).toBe("e-2");
    expect(prior.list()).toEqual([m1, m2]);
  });
});
