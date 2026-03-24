/**
 * Mock language model for unit tests.
 *
 * Uses the official MockLanguageModelV3 from ai/test and simulateReadableStream
 * from ai — no fetch interception, no SSE format knowledge.
 *
 * Usage:
 *   const model = createMockModel({ response: "Hello, world!" });
 *   const agent = new Agent({ model, systemPrompt: "..." });
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

export interface MockToolCall {
  name: string;
  /** The input object the mock LLM will claim to have used. */
  input: Record<string, unknown>;
}

export interface MockModelOptions {
  /** Text to stream back as content deltas. */
  response?: string;
  /** Tool calls to emit before the final text response. */
  toolCalls?: MockToolCall[];
  /** If true, the model will finish with reason "length" (context overflow). */
  contextOverflow?: boolean;
}

/**
 * Create a mock LanguageModel for testing Agent and agentCompact.
 *
 * For streaming (streamText) it uses doStream; for non-streaming (generateText)
 * it uses doGenerate. Both are wired from the same MockModelOptions.
 */
export function createMockModel(options: MockModelOptions = {}): LanguageModel {
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

    // doStream is used by streamText (Agent._runStream)
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV3StreamPart>({
        chunkDelayInMs: 0,
        chunks: buildStreamChunks(options, finishReason, mockUsage),
      }),
    }),

    // doGenerate is used by generateText (agentCompact)
    doGenerate: async () => ({
      content: [{ type: "text", text: responseText }],
      finishReason,
      usage: mockUsage,
      warnings: [],
    }),
  });
}

// ─── Stream chunk builders ────────────────────────────────────────────────────

type FinishReason = { unified: "stop" | "length" | "tool-calls"; raw: undefined };
type MockUsage = {
  inputTokens: { total: number; noCache: number; cacheRead: undefined; cacheWrite: undefined };
  outputTokens: { total: number; text: number; reasoning: undefined };
};

function buildStreamChunks(
  options: MockModelOptions,
  finishReason: FinishReason,
  usage: MockUsage,
): LanguageModelV3StreamPart[] {
  const chunks: LanguageModelV3StreamPart[] = [];

  // Emit tool calls first if any
  if (options.toolCalls && options.toolCalls.length > 0) {
    for (let i = 0; i < options.toolCalls.length; i++) {
      const tc = options.toolCalls[i];
      if (tc === undefined) continue;
      const callId = `call_mock_${i}`;
      const inputStr = JSON.stringify(tc.input);

      chunks.push({ type: "tool-input-start", id: callId, toolName: tc.name });
      chunks.push({ type: "tool-input-delta", id: callId, delta: inputStr });
      chunks.push({ type: "tool-input-end", id: callId });
      // The actual tool-call part (provider-level format requires stringified input)
      chunks.push({ type: "tool-call", toolCallId: callId, toolName: tc.name, input: inputStr });
      // Simulate that the tool was executed by the client and returned a result
      chunks.push({
        type: "tool-result",
        toolCallId: callId,
        toolName: tc.name,
        result: "mock-result",
      });
    }

    // Step finish for tool-call step
    chunks.push({
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
    });
  }

  // Emit text response
  if (options.response) {
    const textId = "text-1";
    chunks.push({ type: "text-start", id: textId });
    const words = options.response.split(" ");
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word === undefined) continue;
      chunks.push({ type: "text-delta", id: textId, delta: i === 0 ? word : ` ${word}` });
    }
    chunks.push({ type: "text-end", id: textId });
  }

  // Final finish chunk
  chunks.push({ type: "finish", finishReason, usage });

  return chunks;
}
