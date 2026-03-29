import type { IMessage } from "@piccolo/api";
import { describe, expect, it } from "vitest";
import { Messages } from "../src/messages.ts";

describe("Messages", () => {
  it("is iterable and supports replacing the internal array in-place", () => {
    const first: IMessage = { role: "user", content: "first", id: "first" };
    const second: IMessage = { role: "assistant", content: "second", id: "second" };

    const messages = new Messages([first]);
    messages.pushAll([second]);

    expect([...messages]).toEqual([first, second]);
    expect(messages.get().slice(1)).toEqual([second]);

    const replacement = [second];
    messages.get().splice(0, messages.length, ...replacement);

    expect(messages.length).toBe(1);
    expect([...messages]).toEqual([second]);
  });
});
