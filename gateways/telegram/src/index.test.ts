import { describe, expect, it } from "vitest";
import {
  parseAllowedTelegramUserIds,
  sessionDoNameForChat,
  timingSafeEqual,
  webhookPathForToken,
} from "./index.ts";

describe("parseAllowedTelegramUserIds", () => {
  it("parses numeric and string IDs", () => {
    const parsed = parseAllowedTelegramUserIds('[12345, "67890"]');
    expect(parsed.has(12345)).toBe(true);
    expect(parsed.has(67890)).toBe(true);
  });

  it("returns empty set for malformed JSON", () => {
    const parsed = parseAllowedTelegramUserIds("not-json");
    expect(parsed.size).toBe(0);
  });

  it("returns empty set for non-array JSON", () => {
    const parsed = parseAllowedTelegramUserIds('{"id":1}');
    expect(parsed.size).toBe(0);
  });
});

describe("sessionDoNameForChat", () => {
  it("creates a chat-scoped durable object name", () => {
    expect(sessionDoNameForChat(42)).toBe("telegram-chat:42");
  });
});

describe("webhook hardening", () => {
  it("derives a deterministic token hash path", async () => {
    const path = await webhookPathForToken("123:abc");
    expect(path.startsWith("/webhook/")).toBe(true);
    expect(path.length).toBe(41);
    expect(path).toMatch(/^\/webhook\/[a-f0-9]{32}$/);
  });

  it("uses timing-safe string equality", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});
