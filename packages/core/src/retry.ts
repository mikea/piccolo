/**
 * Auto-retry logic for transient LLM errors.
 *
 * `checkRetry` is called by `AgentSessionDO._handleAgentEnd()` when
 * `AgentEvent { type: "error" }` fires. It classifies the error, applies
 * exponential backoff with jitter, and retries the turn by calling
 * `agent.continue()`.
 *
 * Retry is only applied to *transient* errors (rate limits, overload, timeouts).
 * Context-length errors are NOT retried — they are handed off to the compaction
 * path via the `onContextOverflow` callback.
 * Permanent errors (unknown, malformed request, etc.) are passed through unchanged.
 *
 * Spec ref: specs/core.md §Auto-Retry
 */

import type { Agent } from "@piccolo/agent";

// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Matches errors that are worth retrying: rate limits, model overload, timeouts.
 * Spec ref: specs/core.md §Auto-Retry — TRANSIENT_ERROR_RE
 */
export const TRANSIENT_ERROR_RE = /overloaded|rate.?limit|429|503|504|timeout/i;

/**
 * Matches context-window overflow errors.
 * These are NOT retried — they trigger compaction instead.
 * Spec ref: specs/core.md §Auto-Retry — CONTEXT_OVERFLOW_RE
 */
export const CONTEXT_OVERFLOW_RE = /context.?length|too.?many.?token|prompt.?too.?long/i;

// ─── Retry parameters ─────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to retry a failed agent turn.
 *
 * @param errorMessage    The error message from `AgentEvent { type: "error" }`.
 * @param agent           The Agent instance to retry.
 * @param signal          AbortSignal — if aborted, retry is cancelled immediately.
 * @param onContextOverflow  Callback invoked when the error is a context-length
 *                        overflow. The caller (AgentSessionDO) should trigger
 *                        compaction here.
 * @returns true if a retry succeeded; false otherwise.
 */
export async function checkRetry(
  errorMessage: string,
  agent: Agent,
  signal: AbortSignal,
  onContextOverflow: () => Promise<void>,
): Promise<boolean> {
  // Context overflow → not a transient error; hand off to compaction
  if (CONTEXT_OVERFLOW_RE.test(errorMessage)) {
    await onContextOverflow();
    return false;
  }

  // Not a transient error → do not retry
  if (!TRANSIENT_ERROR_RE.test(errorMessage)) {
    return false;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return false;

    // Exponential backoff with ±20% jitter, capped at MAX_DELAY_MS
    const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    const jittered = base * (0.8 + Math.random() * 0.4);
    await sleep(jittered, signal);

    if (signal.aborted) return false;

    // Remove the failed (incomplete) assistant message before retrying.
    // The agent appended a partial message during the failed turn — drop it.
    const msgs = agent.state.messages;
    if (msgs.length > 0) {
      agent.replaceMessages(msgs.slice(0, msgs.length - 1));
    }

    await agent.continue();

    // If the agent completed without error, the retry succeeded
    if (!agent.state.error) return true;
  }

  return false;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
