/**
 * Unit tests for SystemPromptAssembler.
 *
 * Pure class — no Miniflare / Workers runtime needed.
 * Covers all cases from specs/core.md §SystemPromptAssembler.
 */

import { describe, expect, it } from "vitest";
import type { ToolDescriptorLike } from "../../src/do/extension-runner.ts";
import { SystemPromptAssembler } from "../../src/do/system-prompt-assembler.ts";
import type { SystemPromptAddition } from "../../src/do/types-internal.ts";

const BASE = "You are a helpful assistant.";

function makeTool(
  name: string,
  opts: { promptSnippet?: string; promptGuidelines?: string[] } = {},
): ToolDescriptorLike {
  return {
    name,
    label: name,
    description: `${name} tool`,
    inputSchema: {},
    ...opts,
  };
}

function makeAddition(
  section: SystemPromptAddition["section"],
  content: string,
  priority?: number,
): SystemPromptAddition {
  const a: SystemPromptAddition = { section, content };
  if (priority !== undefined) a.priority = priority;
  return a;
}

describe("SystemPromptAssembler", () => {
  const assembler = new SystemPromptAssembler();

  // ─── Override ─────────────────────────────────────────────────────────────

  it("returns override verbatim when override is provided", () => {
    const result = assembler.assemble(BASE, [], [], "OVERRIDE");
    expect(result).toBe("OVERRIDE");
  });

  it("override ignores additions", () => {
    const result = assembler.assemble(
      BASE,
      [makeAddition("context", "ctx content")],
      [],
      "OVERRIDE",
    );
    expect(result).toBe("OVERRIDE");
  });

  it("override ignores active tools", () => {
    const result = assembler.assemble(
      BASE,
      [],
      [makeTool("r2", { promptSnippet: "snippet", promptGuidelines: ["guideline"] })],
      "OVERRIDE",
    );
    expect(result).toBe("OVERRIDE");
  });

  // ─── Base-only ────────────────────────────────────────────────────────────

  it("returns base when no additions and no tools", () => {
    const result = assembler.assemble(BASE, [], []);
    expect(result).toBe(BASE);
  });

  it("does not append empty sections", () => {
    const result = assembler.assemble(BASE, [], []);
    expect(result).not.toContain("##");
  });

  // ─── Section ordering ─────────────────────────────────────────────────────

  it("appends context addition after base", () => {
    const result = assembler.assemble(BASE, [makeAddition("context", "ctx")], []);
    const basePos = result.indexOf(BASE);
    const ctxPos = result.indexOf("ctx");
    expect(ctxPos).toBeGreaterThan(basePos);
  });

  it("appends skills addition after context", () => {
    const additions = [makeAddition("context", "ctx"), makeAddition("skills", "skills")];
    const result = assembler.assemble(BASE, additions, []);
    const ctxPos = result.indexOf("ctx");
    const skillsPos = result.indexOf("skills");
    expect(skillsPos).toBeGreaterThan(ctxPos);
  });

  it("appends guidelines addition after skills", () => {
    const additions = [makeAddition("skills", "skills"), makeAddition("guidelines", "guidelines")];
    const result = assembler.assemble(BASE, additions, []);
    const skillsPos = result.indexOf("skills");
    const guidelinesPos = result.indexOf("guidelines");
    expect(guidelinesPos).toBeGreaterThan(skillsPos);
  });

  it("appends footer addition after guidelines", () => {
    const additions = [makeAddition("guidelines", "guidelines"), makeAddition("footer", "footer")];
    const result = assembler.assemble(BASE, additions, []);
    const guidelinesPos = result.indexOf("guidelines");
    const footerPos = result.indexOf("footer");
    expect(footerPos).toBeGreaterThan(guidelinesPos);
  });

  it("correct ordering: base → context → skills → guidelines → footer", () => {
    const additions = [
      makeAddition("footer", "FOOTER"),
      makeAddition("guidelines", "GUIDELINES"),
      makeAddition("skills", "SKILLS"),
      makeAddition("context", "CONTEXT"),
    ];
    const result = assembler.assemble(BASE, additions, []);
    const basePos = result.indexOf(BASE);
    const ctxPos = result.indexOf("CONTEXT");
    const skillsPos = result.indexOf("SKILLS");
    const guidelinesPos = result.indexOf("GUIDELINES");
    const footerPos = result.indexOf("FOOTER");
    expect(basePos).toBeLessThan(ctxPos);
    expect(ctxPos).toBeLessThan(skillsPos);
    expect(skillsPos).toBeLessThan(guidelinesPos);
    expect(guidelinesPos).toBeLessThan(footerPos);
  });

  // ─── Priority sorting within sections ────────────────────────────────────

  it("sorts additions within a section by priority ascending", () => {
    const additions = [makeAddition("context", "LAST", 200), makeAddition("context", "FIRST", 10)];
    const result = assembler.assemble(BASE, additions, []);
    expect(result.indexOf("FIRST")).toBeLessThan(result.indexOf("LAST"));
  });

  it("treats missing priority as 100", () => {
    const additions = [
      makeAddition("context", "EXPLICIT_50", 50),
      makeAddition("context", "DEFAULT"), // priority=undefined → 100
      makeAddition("context", "EXPLICIT_150", 150),
    ];
    const result = assembler.assemble(BASE, additions, []);
    const p50 = result.indexOf("EXPLICIT_50");
    const pDef = result.indexOf("DEFAULT");
    const p150 = result.indexOf("EXPLICIT_150");
    expect(p50).toBeLessThan(pDef);
    expect(pDef).toBeLessThan(p150);
  });

  it("priority sorting is stable across sections", () => {
    // Each section is sorted independently — footer should still come after context
    const additions = [
      makeAddition("footer", "FOOTER_LOW", 1),
      makeAddition("context", "CONTEXT_HIGH", 999),
    ];
    const result = assembler.assemble(BASE, additions, []);
    expect(result.indexOf("CONTEXT_HIGH")).toBeLessThan(result.indexOf("FOOTER_LOW"));
  });

  // ─── Available Tools section ──────────────────────────────────────────────

  it("includes Available Tools section when tool has promptSnippet", () => {
    const result = assembler.assemble(BASE, [], [makeTool("r2", { promptSnippet: "R2 storage" })]);
    expect(result).toContain("## Available Tools");
    expect(result).toContain("- **r2**: R2 storage");
  });

  it("excludes tool without promptSnippet from Available Tools section", () => {
    const result = assembler.assemble(BASE, [], [makeTool("no-snippet")]);
    expect(result).not.toContain("## Available Tools");
  });

  it("lists multiple tools with snippets in Available Tools section", () => {
    const tools = [
      makeTool("r2", { promptSnippet: "R2 storage" }),
      makeTool("d1", { promptSnippet: "D1 database" }),
    ];
    const result = assembler.assemble(BASE, [], tools);
    expect(result).toContain("- **r2**: R2 storage");
    expect(result).toContain("- **d1**: D1 database");
  });

  it("does not include Available Tools section when all tools lack promptSnippet", () => {
    const tools = [makeTool("no-snippet-1"), makeTool("no-snippet-2")];
    const result = assembler.assemble(BASE, [], tools);
    expect(result).not.toContain("## Available Tools");
  });

  // Available Tools appears before guidelines section additions
  it("Available Tools section appears before guidelines additions", () => {
    const tools = [makeTool("r2", { promptSnippet: "R2 storage" })];
    const additions = [makeAddition("guidelines", "GUIDELINES")];
    const result = assembler.assemble(BASE, additions, tools);
    expect(result.indexOf("## Available Tools")).toBeLessThan(result.indexOf("GUIDELINES"));
  });

  // ─── Tool Guidelines section ──────────────────────────────────────────────

  it("includes Tool Guidelines section when tool has promptGuidelines", () => {
    const tool = makeTool("r2", { promptGuidelines: ["Always check permissions before writes"] });
    const result = assembler.assemble(BASE, [], [tool]);
    expect(result).toContain("## Tool Guidelines");
    expect(result).toContain("- Always check permissions before writes");
  });

  it("merges guidelines from multiple tools", () => {
    const tools = [
      makeTool("r2", { promptGuidelines: ["r2 guideline"] }),
      makeTool("d1", { promptGuidelines: ["d1 guideline"] }),
    ];
    const result = assembler.assemble(BASE, [], tools);
    expect(result).toContain("- r2 guideline");
    expect(result).toContain("- d1 guideline");
  });

  it("does not include Tool Guidelines section when no tool has promptGuidelines", () => {
    const result = assembler.assemble(BASE, [], [makeTool("no-guidelines")]);
    expect(result).not.toContain("## Tool Guidelines");
  });

  it("Tool Guidelines section appears after guidelines additions", () => {
    const tool = makeTool("r2", { promptGuidelines: ["r2 guideline"] });
    const additions = [makeAddition("guidelines", "GUIDELINES")];
    const result = assembler.assemble(BASE, additions, [tool]);
    expect(result.indexOf("GUIDELINES")).toBeLessThan(result.indexOf("## Tool Guidelines"));
  });

  it("Tool Guidelines section appears before footer", () => {
    const tool = makeTool("r2", { promptGuidelines: ["r2 guideline"] });
    const additions = [makeAddition("footer", "FOOTER")];
    const result = assembler.assemble(BASE, additions, [tool]);
    expect(result.indexOf("## Tool Guidelines")).toBeLessThan(result.indexOf("FOOTER"));
  });

  // ─── Separator / whitespace ───────────────────────────────────────────────

  it("sections are separated by double newlines", () => {
    const result = assembler.assemble(BASE, [makeAddition("context", "CTX")], []);
    expect(result).toContain(`${BASE}\n\nCTX`);
  });

  it("no trailing double newline when footer is absent", () => {
    const result = assembler.assemble(BASE, [makeAddition("context", "CTX")], []);
    expect(result.endsWith("\n\n")).toBe(false);
  });

  // ─── Combined scenario ────────────────────────────────────────────────────

  it("assembles all sections together in correct order", () => {
    const additions = [
      makeAddition("context", "CTX"),
      makeAddition("skills", "SKILLS"),
      makeAddition("guidelines", "GUIDELINES"),
      makeAddition("footer", "FOOTER"),
    ];
    const tools = [
      makeTool("r2", { promptSnippet: "R2 storage", promptGuidelines: ["r2 guideline"] }),
    ];
    const result = assembler.assemble(BASE, additions, tools);

    const basePos = result.indexOf(BASE);
    const ctxPos = result.indexOf("CTX");
    const skillsPos = result.indexOf("SKILLS");
    const availPos = result.indexOf("## Available Tools");
    const guidelinesPos = result.indexOf("GUIDELINES");
    const toolGuidelinesPos = result.indexOf("## Tool Guidelines");
    const footerPos = result.indexOf("FOOTER");

    expect(basePos).toBeLessThan(ctxPos);
    expect(ctxPos).toBeLessThan(skillsPos);
    expect(skillsPos).toBeLessThan(availPos);
    expect(availPos).toBeLessThan(guidelinesPos);
    expect(guidelinesPos).toBeLessThan(toolGuidelinesPos);
    expect(toolGuidelinesPos).toBeLessThan(footerPos);
  });
});
