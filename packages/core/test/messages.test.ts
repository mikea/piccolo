import type { ModelMessage } from "@piccolo/api";
import { describe, expect, it } from "vitest";
import { Messages } from "../src/messages.ts";

describe("Messages", () => {
  it("is iterable and supports in-place replacement", () => {
    const first: ModelMessage = { role: "user", content: "first" };
    const second: ModelMessage = { role: "assistant", content: "second" };

    const messages = new Messages();
    messages.push(first, second);

    expect([...messages]).toEqual([first, second]);
    expect(messages.slice(1)).toEqual([second]);

    messages.replace([second]);

    expect(messages.length).toBe(1);
    expect([...messages]).toEqual([second]);
  });
});
