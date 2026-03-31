import { describe, expect, it, vi } from "vitest";
import telegramWorker, {
  parseAllowedTelegramUserIds,
  sessionDoNameForChat,
  timingSafeEqual,
  webhookPathForToken,
} from "../src/index.ts";

describe("parseAllowedTelegramUserIds", () => {
  it("parses numeric and string IDs", () => {
    const parsed = parseAllowedTelegramUserIds('[12345, "67890"]');
    expect(parsed.has(12345)).toBe(true);
    expect(parsed.has(67890)).toBe(true);
  });

  it("returns empty set for malformed JSON", () => {
    expect(parseAllowedTelegramUserIds("not-json").size).toBe(0);
  });

  it("returns empty set for non-array JSON", () => {
    expect(parseAllowedTelegramUserIds('{"id":1}').size).toBe(0);
  });
});

describe("sessionDoNameForChat", () => {
  it("creates chat-scoped DO name", () => {
    expect(sessionDoNameForChat(42)).toBe("telegram-chat:42");
  });
});

describe("webhook hardening", () => {
  it("derives deterministic token hash path", async () => {
    const path = await webhookPathForToken("123:abc");
    expect(path).toMatch(/^\/webhook\/[a-f0-9]{32}$/);
  });

  it("uses timing-safe equality", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});

describe("worker fetch", () => {
  it("returns 404 for non-webhook path", async () => {
    const env = createEnv();
    const response = await telegramWorker.fetch(
      new Request("https://example.test/nope"),
      env as unknown as Env,
    );
    expect(response.status).toBe(404);
  });

  it("returns 405 for non-POST on valid webhook path", async () => {
    const env = createEnv();
    const path = await webhookPathForToken(env.TELEGRAM_BOT_TOKEN);
    const response = await telegramWorker.fetch(
      new Request(`https://example.test${path}`, { method: "GET" }),
      env as unknown as Env,
    );
    expect(response.status).toBe(405);
  });

  it("ignores unauthorized users", async () => {
    const env = createEnv({ allowedUsers: [1] });
    const path = await webhookPathForToken(env.TELEGRAM_BOT_TOKEN);
    const response = await telegramWorker.fetch(
      new Request(`https://example.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeTextUpdate({ userId: 42, chatId: 555, text: "hi" })),
      }),
      env as unknown as Env,
    );
    expect(response.status).toBe(200);
    expect(env.initialize).not.toHaveBeenCalled();
    expect(env.processIncomingText).not.toHaveBeenCalled();
  });

  it("routes authorized text update to TelegramSessionDO", async () => {
    const env = createEnv({ allowedUsers: [42] });
    const path = await webhookPathForToken(env.TELEGRAM_BOT_TOKEN);
    const response = await telegramWorker.fetch(
      new Request(`https://example.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeTextUpdate({ userId: 42, chatId: 777, text: "hello" })),
      }),
      env as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(env.idFromName).toHaveBeenCalledWith("telegram-chat:777");
    expect(env.initialize).toHaveBeenCalledWith({
      telegramUserId: 42,
      telegramChatId: 777,
      piccoloUserId: "telegram:42",
    });
    expect(env.processIncomingText).toHaveBeenCalledWith("hello");
  });
});

function makeTextUpdate(input: {
  userId: number;
  chatId: number;
  text: string;
}): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1,
      text: input.text,
      chat: { id: input.chatId, type: "private" },
      from: { id: input.userId, is_bot: false, first_name: "Test" },
    },
  };
}

type TestEnv = {
  TELEGRAM_BOT_TOKEN: string;
  ALLOWED_TELEGRAM_USER_IDS: string;
  TELEGRAM_SESSION: {
    idFromName: (name: string) => DurableObjectId;
    get: () => {
      initialize: () => Promise<void>;
      processIncomingText: (text: string) => Promise<void>;
    };
  };
  initialize: ReturnType<typeof vi.fn>;
  processIncomingText: ReturnType<typeof vi.fn>;
  idFromName: ReturnType<typeof vi.fn>;
};

function createEnv(input?: { allowedUsers?: number[] }): TestEnv {
  const initialize = vi.fn(async () => {});
  const processIncomingText = vi.fn(async (_text: string) => {});
  const stub = { initialize, processIncomingText, onRpcBroken: vi.fn() };
  const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId);

  return {
    TELEGRAM_BOT_TOKEN: "123:abc",
    ALLOWED_TELEGRAM_USER_IDS: JSON.stringify(input?.allowedUsers ?? []),
    TELEGRAM_SESSION: { idFromName, get: vi.fn(() => stub) },
    initialize,
    processIncomingText,
    idFromName,
  };
}
