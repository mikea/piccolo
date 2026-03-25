/**
 * Unit tests for system-prompt.ts and types-internal.ts (non-DO coverage).
 */

import { describe, expect, it } from "vitest";
import { buildBasePrompt, DEFAULT_AGENT_NAME } from "../../src/system-prompt.ts";
import { parseModels } from "../../src/types-internal.ts";

describe("buildBasePrompt", () => {
  it("uses the provided agent name", () => {
    const prompt = buildBasePrompt("MyBot");
    expect(prompt).toContain("MyBot");
  });

  it("falls back to DEFAULT_AGENT_NAME when given empty string", () => {
    const prompt = buildBasePrompt("");
    expect(prompt).toContain(DEFAULT_AGENT_NAME);
  });

  it("falls back to DEFAULT_AGENT_NAME when given whitespace only", () => {
    const prompt = buildBasePrompt("   ");
    expect(prompt).toContain(DEFAULT_AGENT_NAME);
  });
});

describe("parseModels", () => {
  it("parses a JSON string array", () => {
    const models = parseModels("anthropic/claude-sonnet-4-5,openai/gpt-4o");
    expect(models).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
  });
});
