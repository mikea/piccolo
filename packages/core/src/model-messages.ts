import type { ModelMessage } from "ai";

type AnyObject = Record<string, unknown>;

function isObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null;
}

function isModelMessageLike(value: unknown): value is ModelMessage {
  if (!isObject(value)) {
    return false;
  }

  if (typeof value["role"] !== "string") {
    return false;
  }

  return "content" in value;
}

/**
 * Filter a message list to values that satisfy the basic ModelMessage shape.
 */
export function normalizeModelMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => isModelMessageLike(message));
}

/**
 * Parse and normalize a potentially untyped ModelMessage list.
 *
 * Extension workers run in separate modules and may return values that only
 * partially match the compile-time type. This accepts only array entries with
 * at least `{ role, content }` shape and drops everything else.
 */
export function normalizeUnknownModelMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: ModelMessage[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }
    if (typeof item["role"] !== "string" || !("content" in item)) {
      continue;
    }
    if (!isModelMessageLike(item)) {
      continue;
    }
    parsed.push(item);
  }
  return parsed;
}
