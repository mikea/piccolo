import type { ModelMessage } from "@piccolo/api";
import { describe, expect, it } from "vitest";
import { Messages } from "../src/messages.ts";

describe("Messages", () => {
  it("is iterable and supports replacing the internal array in-place", () => {
    const first: ModelMessage = { role: "user", content: "first" };
    const second: ModelMessage = { role: "assistant", content: "second" };

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
