import type { IMessage } from "@piccolo/api";
import { describe, expect, it } from "vitest";
import {
  collectAssistantText,
  isSameInitContext,
  isTurnError,
  splitTelegramText,
} from "../src/telegram-session-do.ts";

describe("TelegramSessionDO helpers", () => {
  it("splitTelegramText handles empty and long text", () => {
    expect(splitTelegramText("")).toEqual(["..."]);
    const chunks = splitTelegramText("a".repeat(5000));
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(4096);
    expect(chunks[1]?.length).toBe(904);
  });

  it("isSameInitContext compares all fields", () => {
    expect(
      isSameInitContext(
        { telegramUserId: 1, telegramChatId: 2, piccoloUserId: "telegram:1" },
        { telegramUserId: 1, telegramChatId: 2, piccoloUserId: "telegram:1" },
      ),
    ).toBe(true);
    expect(
      isSameInitContext(
        { telegramUserId: 1, telegramChatId: 2, piccoloUserId: "telegram:1" },
        { telegramUserId: 2, telegramChatId: 2, piccoloUserId: "telegram:1" },
      ),
    ).toBe(false);
  });

  it("isTurnError and collectAssistantText follow TurnResult contract", () => {
    const err = { type: "error", message: "boom" } as const;
    expect(isTurnError(err)).toBe(true);

    const messages: IMessage[] = [
      { id: "u", role: "user", content: "ignored" },
      { id: "a", role: "assistant", content: "hello" },
      { id: "b", role: "assistant", content: [{ type: "text", text: "world" }] },
    ];
    const ok = {
      messages,
    };
    expect(isTurnError(ok)).toBe(false);
    expect(collectAssistantText(ok)).toBe("hello\nworld");
  });
});
