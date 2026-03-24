/**
 * Unit tests for system-prompt.ts and types-internal.ts (non-DO coverage).
 */

import { describe, expect, it } from "vitest";
import { buildBasePrompt, DEFAULT_AGENT_NAME } from "../../src/do/system-prompt.ts";
import { MODEL_CATALOG, resolveModel } from "../../src/do/types-internal.ts";

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

describe("resolveModel", () => {
  it("returns catalog entry for a known model", () => {
    const info = resolveModel("anthropic/claude-sonnet-4-5");
    expect(info.id).toBe("anthropic/claude-sonnet-4-5");
    expect(info.provider).toBe("anthropic");
  });

  it("synthesises an entry for an unknown model", () => {
    const info = resolveModel("custom/unknown-model-xyz");
    expect(info.id).toBe("custom/unknown-model-xyz");
    expect(info.label).toBe("custom/unknown-model-xyz");
    expect(info.provider).toBe("custom");
  });

  it("synthesises an entry for a model ID with no slash", () => {
    const info = resolveModel("just-a-model");
    expect(info.id).toBe("just-a-model");
    expect(info.provider).toBe("just-a-model");
  });

  it("MODEL_CATALOG contains at least one anthropic model", () => {
    const anthropic = MODEL_CATALOG.filter((m) => m.provider === "anthropic");
    expect(anthropic.length).toBeGreaterThan(0);
  });
});
