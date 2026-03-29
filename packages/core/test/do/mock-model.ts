/**
 * Mock language model for AgentSessionDO tests.
 *
 * Mirrors packages/agent/test/mock-gateway.ts but is kept separate so
 * packages/agent's test helpers do not need to be part of its public API.
 *
 * The `AgentSessionDO` constructor calls an internal `createModel(env, modelId)`
 * helper that uses ai-gateway-provider. Tests bypass the real gateway because
 * overriding `createModel` is not viable inside a Durable Object context.
 *
 * Instead, tests use `runInDurableObject` to reach directly into the DO
 * instance and replace `state.agent.setModel(mockModel)` after construction
 * (before the first prompt). The DO initialises with `createModel` pointing
 * to a non-existent gateway; tests swap the model before any real LLM call.
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

export interface MockToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface MockModelOptions {
  response?: string;
  toolCalls?: MockToolCall[];
  contextOverflow?: boolean;
  error?: string;
}

export function createMockModel(options: MockModelOptions = {}): LanguageModel {
  if (options.error) {
    const errMsg = options.error;
    return new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock-model",
      doStream: async () => {
        throw new Error(errMsg);
      },
      doGenerate: async () => {
        throw new Error(errMsg);
      },
    });
  }

  const finishReason = options.contextOverflow
    ? ({ unified: "length", raw: undefined } as const)
    : ({ unified: "stop", raw: undefined } as const);
  const responseText = options.response ?? "";
  const wordCount = responseText ? responseText.split(" ").length : 0;

  const mockUsage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: wordCount, text: wordCount, reasoning: undefined },
  };

  return new MockLanguageModelV3({
    provider: "mock",
    modelId: "mock-model",

    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV3StreamPart>({
        chunkDelayInMs: 0,
        chunks: buildStreamChunks(options, finishReason, mockUsage),
      }),
    }),

    doGenerate: async () => ({
      content: [{ type: "text", text: responseText }],
      finishReason,
      usage: mockUsage,
      warnings: [],
    }),
  });
}

// ─── Internal ────────────────────────────────────────────────────────────────

type FinishReasonObj = { unified: "stop" | "length" | "tool-calls"; raw: undefined };
type MockUsage = {
  inputTokens: { total: number; noCache: number; cacheRead: undefined; cacheWrite: undefined };
  outputTokens: { total: number; text: number; reasoning: undefined };
};

function buildStreamChunks(
  options: MockModelOptions,
  finishReason: FinishReasonObj,
  usage: MockUsage,
): LanguageModelV3StreamPart[] {
  const chunks: LanguageModelV3StreamPart[] = [];

  if (options.toolCalls && options.toolCalls.length > 0) {
    for (let i = 0; i < options.toolCalls.length; i++) {
      const tc = options.toolCalls[i];
      if (!tc) continue;
      const callId = `call_mock_${i}`;
      const inputStr = JSON.stringify(tc.input);
      chunks.push({ type: "tool-input-start", id: callId, toolName: tc.name });
      chunks.push({ type: "tool-input-delta", id: callId, delta: inputStr });
      chunks.push({ type: "tool-input-end", id: callId });
      chunks.push({ type: "tool-call", toolCallId: callId, toolName: tc.name, input: inputStr });
      chunks.push({
        type: "tool-result",
        toolCallId: callId,
        toolName: tc.name,
        result: "mock-result",
      });
    }
    chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage });
  }

  if (options.response) {
    const textId = "text-1";
    chunks.push({ type: "text-start", id: textId });
    const words = options.response.split(" ");
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!word) continue;
      chunks.push({ type: "text-delta", id: textId, delta: i === 0 ? word : ` ${word}` });
    }
    chunks.push({ type: "text-end", id: textId });
  }

  chunks.push({ type: "finish", finishReason, usage });
  return chunks;
}
