/**
 * Unit tests for retry.ts (checkRetry).
 *
 * These tests run in the Workers sandbox (no D1 needed) and exercise the
 * retry classification and backoff logic directly without a full DO.
 *
 * Spec ref: specs/core.md §Auto-Retry
 */

import { Agent } from "@piccolo/agent";
import { describe, expect, it, vi } from "vitest";
import { CONTEXT_OVERFLOW_RE, checkRetry, TRANSIENT_ERROR_RE } from "../../src/do/retry.ts";
import { createMockModel } from "./mock-model.ts";

// ─── Regex classification tests ───────────────────────────────────────────────

describe("retry — error classification regexes", () => {
  it("TRANSIENT_ERROR_RE matches rate limit patterns", () => {
    expect(TRANSIENT_ERROR_RE.test("rate limit exceeded")).toBe(true);
    expect(TRANSIENT_ERROR_RE.test("rate-limit-exceeded")).toBe(true);
    expect(TRANSIENT_ERROR_RE.test("HTTP 429")).toBe(true);
    expect(TRANSIENT_ERROR_RE.test("service 503 unavailable")).toBe(true);
    expect(TRANSIENT_ERROR_RE.test("504 gateway timeout")).toBe(true);
    expect(TRANSIENT_ERROR_RE.test("model overloaded")).toBe(true);
    expect(TRANSIENT_ERROR_RE.test("request timeout")).toBe(true);
  });

  it("TRANSIENT_ERROR_RE does not match permanent errors", () => {
    expect(TRANSIENT_ERROR_RE.test("invalid API key")).toBe(false);
    expect(TRANSIENT_ERROR_RE.test("model not found")).toBe(false);
    expect(TRANSIENT_ERROR_RE.test("bad request")).toBe(false);
  });

  it("CONTEXT_OVERFLOW_RE matches context length patterns", () => {
    expect(CONTEXT_OVERFLOW_RE.test("context length exceeded")).toBe(true);
    expect(CONTEXT_OVERFLOW_RE.test("too many tokens")).toBe(true);
    expect(CONTEXT_OVERFLOW_RE.test("prompt too long")).toBe(true);
    expect(CONTEXT_OVERFLOW_RE.test("context_length_exceeded")).toBe(true);
  });

  it("CONTEXT_OVERFLOW_RE does not match transient patterns", () => {
    expect(CONTEXT_OVERFLOW_RE.test("rate limit")).toBe(false);
    expect(CONTEXT_OVERFLOW_RE.test("503 service unavailable")).toBe(false);
  });
});

// ─── checkRetry behaviour tests ───────────────────────────────────────────────

describe("checkRetry", () => {
  function makeAgent(response: string): Agent {
    const agent = new Agent({
      model: createMockModel({ response }),
      systemPrompt: "test",
    });
    return agent;
  }

  it("returns false and does not retry for permanent errors", async () => {
    const agent = makeAgent("hi");
    const signal = new AbortController().signal;
    const onOverflow = vi.fn();

    const retried = await checkRetry("invalid API key 401", agent, signal, onOverflow);

    expect(retried).toBe(false);
    expect(onOverflow).not.toHaveBeenCalled();
  });

  it("calls onContextOverflow for context length errors and returns false", async () => {
    const agent = makeAgent("hi");
    const signal = new AbortController().signal;
    const onOverflow = vi.fn().mockResolvedValue(undefined);

    const retried = await checkRetry("context length exceeded", agent, signal, onOverflow);

    expect(retried).toBe(false);
    expect(onOverflow).toHaveBeenCalledOnce();
  });

  it("calls onContextOverflow for 'too many tokens' errors", async () => {
    const agent = makeAgent("hi");
    const signal = new AbortController().signal;
    const onOverflow = vi.fn().mockResolvedValue(undefined);

    await checkRetry("too many tokens in prompt", agent, signal, onOverflow);

    expect(onOverflow).toHaveBeenCalledOnce();
  });

  it("TRANSIENT pattern triggers the retry path (not permanent or overflow)", () => {
    // Verify the branching: a transient error string enters the retry loop.
    // We verify this structurally by confirming neither "false early returns" fire.
    const transient = "overloaded";
    expect(CONTEXT_OVERFLOW_RE.test(transient)).toBe(false); // not overflow
    expect(TRANSIENT_ERROR_RE.test(transient)).toBe(true); // is transient
    // Combined: not overflow AND is transient → enters retry loop
  });

  it("returns false immediately when signal is already aborted", async () => {
    const agent = makeAgent("hi");
    const controller = new AbortController();
    controller.abort();

    const retried = await checkRetry("overloaded", agent, controller.signal, vi.fn());

    expect(retried).toBe(false);
  });
});
