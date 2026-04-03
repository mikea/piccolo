import { describe, expect, it } from "vitest";
import { parseSkillDocument } from "../src/parser.ts";

describe("parseSkillDocument", () => {
  it("returns fallback shape when frontmatter is missing", () => {
    const parsed = parseSkillDocument("# no frontmatter");
    expect(parsed.name).toBe("unknown-skill");
    expect(parsed.description).toBe("");
    expect(parsed.license).toBeNull();
    expect(parsed.compatibility).toBeNull();
    expect(parsed.metadataJson).toBeNull();
    expect(parsed.allowedTools).toBeNull();
  });

  it("normalizes frontmatter fields and trims values", () => {
    const doc = [
      "---",
      "name: My Fancy Skill",
      "description:   hello world   ",
      "license: MIT",
      "compatibility:  stable",
      "allowed-tools: read write",
      "metadata:",
      "  owner: team-a",
      "---",
      "body",
    ].join("\n");

    const parsed = parseSkillDocument(doc);
    expect(parsed.name).toBe("my-fancy-skill");
    expect(parsed.description).toBe("hello world");
    expect(parsed.license).toBe("MIT");
    expect(parsed.compatibility).toBe("stable");
    expect(parsed.allowedTools).toBe("read write");
    expect(parsed.metadataJson).toBe('{"owner":"team-a"}');
  });

  it("ignores unsupported and duplicate fields", () => {
    const doc = [
      "---",
      "name: first",
      "name: second",
      "description: d",
      "unsupported: x",
      "---",
      "body",
    ].join("\n");
    const parsed = parseSkillDocument(doc);
    expect(parsed.name).toBe("first");
  });

  it("handles malformed and nested frontmatter rows", () => {
    const doc = [
      "---",
      "# comment",
      "  bad-indented: true",
      "name this is malformed",
      "name: good",
      "metadata:",
      "",
      "  no-colon",
      "  number: true",
      "  key: value",
      "next: field",
      "---",
      "body",
    ].join("\n");

    const parsed = parseSkillDocument(doc);
    expect(parsed.name).toBe("good");
    expect(parsed.metadataJson).toBe('{"key":"value"}');
  });

  it("parses scalar booleans/objects and nulls invalid metadata", () => {
    const withObjectMetadata = [
      "---",
      "name: a",
      "description: b",
      'metadata: {"x":"y"}',
      "---",
      "body",
    ].join("\n");
    expect(parseSkillDocument(withObjectMetadata).metadataJson).toBe('{"x":"y"}');

    const withBooleanMetadata = [
      "---",
      "name: a",
      "description: b",
      "metadata: true",
      "---",
      "body",
    ].join("\n");
    expect(parseSkillDocument(withBooleanMetadata).metadataJson).toBeNull();
  });

  it("throws on invalid JSON object scalar", () => {
    const doc = ["---", "name: bad", "description: bad", "metadata: {invalid}", "---", "body"].join(
      "\n",
    );
    expect(() => parseSkillDocument(doc)).toThrow("Invalid JSON object scalar");
  });

  it("normalizes unknown/invalid names and truncates long descriptions", () => {
    const long = "x".repeat(1200);
    const doc = [
      "---",
      "name: $$$",
      `description: ${long}`,
      "license:  ",
      "compatibility:   ",
      "allowed-tools:  ",
      "---",
      "body",
    ].join("\n");
    const parsed = parseSkillDocument(doc);
    expect(parsed.name).toBe("unknown-skill");
    expect(parsed.description.length).toBe(1024);
    expect(parsed.license).toBeNull();
    expect(parsed.compatibility).toBeNull();
    expect(parsed.allowedTools).toBeNull();
  });

  it("uses rest-of-file when closing frontmatter delimiter is missing", () => {
    const doc = ["---", "name: no-close", "description: x", "body without close"].join("\n");
    const parsed = parseSkillDocument(doc);
    expect(parsed.name).toBe("no-close");
    expect(parsed.description).toBe("x");
  });
});
