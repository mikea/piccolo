import { env } from "cloudflare:test";
import type { ISession } from "@piccolo/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivateSkillTool,
  buildSkillsPromptAddition,
  ImportSkillsTool,
  ListSkillsTool,
} from "../src/extension.ts";

beforeEach(async () => {
  await env.SKILLS_DB.prepare("DROP TABLE IF EXISTS skills").run();
  await env.SKILLS_DB.prepare(
    `CREATE TABLE skills (
      id            TEXT    PRIMARY KEY,
      user_id       TEXT,
      session_id    TEXT,
      file_name     TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      description   TEXT    NOT NULL,
      license       TEXT,
      compatibility TEXT,
      metadata_json TEXT,
      allowed_tools TEXT,
      content       TEXT    NOT NULL,
      sha256        TEXT    NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      CHECK (
        (user_id IS NULL AND session_id IS NULL) OR
        (user_id IS NOT NULL AND session_id IS NULL) OR
        (user_id IS NULL AND session_id IS NOT NULL)
      )
    )`,
  ).run();
});

function makeSession(userId = "user-a", sessionId = "session-a"): ISession {
  return {
    sessionId: async () => sessionId,
    userId: async () => userId,
    getUpdatedAt: async () => 0,
    getName: async () => undefined,
    setName: async () => {},
    prompt: async () => {
      throw new Error("not implemented");
    },
    sendUserMessage: async () => {},
    steer: async () => {},
    followUp: async () => {},
    getCurrentTurn: async () => undefined,
    getModel: async () => "test/model",
    setModel: async () => {},
    listModels: async () => [],
    getActiveTools: async () => [],
    getEntries: async () => [],
    getContextUsage: async () => ({ inputTokens: 0 }),
    compact: async () => {},
    getSystemPrompt: async () => "",
    fork: async () => {
      throw new Error("not implemented");
    },
    delete: async () => {},
    subscribe: async () => {
      throw new Error("not implemented");
    },
  } as unknown as ISession;
}

function skillDoc(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "compatibility: none",
    "allowed-tools: read write",
    "metadata:",
    "  owner: test",
    "---",
    "",
    `# ${name}`,
    "",
    "Use this skill.",
  ].join("\n");
}

function makeBucket(files: Record<string, string>): R2Bucket {
  const list = vi.fn(async (options?: R2ListOptions) => {
    const prefix = options?.prefix ?? "";
    const keys = Object.keys(files)
      .filter((key) => key.startsWith(prefix))
      .sort();
    return {
      objects: keys.map((key) => ({
        key,
        size: new TextEncoder().encode(files[key] ?? "").byteLength,
      })),
      truncated: false,
      delimitedPrefixes: [],
      cursor: undefined,
    } as unknown as R2Objects;
  });

  const get = vi.fn(async (key: string) => {
    const content = files[key];
    if (content == null) return null;
    const bytes = new TextEncoder().encode(content);
    return {
      key,
      size: bytes.byteLength,
      text: async () => content,
    } as unknown as R2ObjectBody;
  });

  return { list, get } as unknown as R2Bucket;
}

describe("ImportSkillsTool", () => {
  it("imports SKILL.md recursively and skips unchanged rows by sha", async () => {
    const bucket = makeBucket({
      "skills/alpha/SKILL.md": skillDoc("alpha", "Alpha skill"),
      "skills/beta/SKILL.md": skillDoc("beta", "Beta skill"),
      "skills/ignore.txt": "ignored",
    });
    const tool = new ImportSkillsTool(env.SKILLS_DB, bucket);
    const ctx = makeSession("u1", "s1");

    const first = await tool.execute("c1", { path: "skills/", scope: "global" }, ctx);
    const firstDetails = first.details as { inserted: number; skipped: number };
    expect(firstDetails.inserted).toBe(2);
    expect(firstDetails.skipped).toBe(0);

    const second = await tool.execute("c2", { path: "skills/", scope: "global" }, ctx);
    const secondDetails = second.details as { inserted: number; skipped: number };
    expect(secondDetails.inserted).toBe(0);
    expect(secondDetails.skipped).toBe(2);
  });

  it("updates existing row when file content changes", async () => {
    const files = {
      "skills/alpha/SKILL.md": skillDoc("alpha", "Alpha skill v1"),
    };
    const bucket = makeBucket(files);
    const tool = new ImportSkillsTool(env.SKILLS_DB, bucket);
    const ctx = makeSession();

    await tool.execute("c1", { path: "skills/", scope: "global" }, ctx);
    files["skills/alpha/SKILL.md"] = skillDoc("alpha", "Alpha skill v2");

    const result = await tool.execute("c2", { path: "skills/", scope: "global" }, ctx);
    const details = result.details as { updated: number };
    expect(details.updated).toBe(1);
  });

  it("ignores non-standard frontmatter fields", async () => {
    const doc = [
      "---",
      "name: bad",
      "description: Bad field",
      "disable-model-invocation: true",
      "---",
      "# bad",
    ].join("\n");

    const bucket = makeBucket({ "skills/bad/SKILL.md": doc });
    const tool = new ImportSkillsTool(env.SKILLS_DB, bucket);
    const ctx = makeSession();
    const result = await tool.execute("c1", { path: "skills/", scope: "global" }, ctx);
    const details = result.details as { errors: number; inserted: number };
    expect(details.errors).toBe(0);
    expect(details.inserted).toBe(1);
  });
});

describe("ListSkillsTool and ActivateSkillTool", () => {
  it("lists visible skills with scope labels and activates by precedence", async () => {
    const bucket = makeBucket({
      "global/shared/SKILL.md": skillDoc("shared", "global"),
      "user/shared/SKILL.md": skillDoc("shared", "user"),
      "session/shared/SKILL.md": skillDoc("shared", "session"),
    });
    const importer = new ImportSkillsTool(env.SKILLS_DB, bucket);
    const list = new ListSkillsTool(env.SKILLS_DB);
    const activate = new ActivateSkillTool(env.SKILLS_DB);
    const ctx = makeSession("u-list", "s-list");

    await importer.execute("i1", { path: "global/", scope: "global" }, ctx);
    await importer.execute("i2", { path: "user/", scope: "user" }, ctx);
    await importer.execute("i3", { path: "session/", scope: "session" }, ctx);

    const listed = await list.execute("l1", {}, ctx);
    const text = (listed.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("shared");
    expect(text).toContain("global");
    expect(text).toContain("user");
    expect(text).toContain("session");

    const activated = await activate.execute("a1", { name: "shared" }, ctx);
    const activatedText = (activated.content[0] as { type: "text"; text: string }).text;
    expect(activatedText).toContain("description: session");
  });

  it("activate_skill appends user arguments", async () => {
    const bucket = makeBucket({
      "skills/a/SKILL.md": skillDoc("alpha", "desc"),
    });
    const importer = new ImportSkillsTool(env.SKILLS_DB, bucket);
    const activate = new ActivateSkillTool(env.SKILLS_DB);
    const ctx = makeSession();

    await importer.execute("i1", { path: "skills/", scope: "global" }, ctx);
    const result = await activate.execute(
      "a1",
      { name: "alpha", arguments: "focus on tests" },
      ctx,
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("User arguments: focus on tests");
  });
});

describe("buildSkillsPromptAddition", () => {
  it("returns XML catalog with escaped values", async () => {
    const bucket = makeBucket({
      "skills/xml/SKILL.md": skillDoc("xml-skill", 'Use <xml> & escape "quotes"'),
    });
    const importer = new ImportSkillsTool(env.SKILLS_DB, bucket);
    const ctx = makeSession();
    await importer.execute("i1", { path: "skills/", scope: "global" }, ctx);

    const additions = await buildSkillsPromptAddition(env.SKILLS_DB, ctx);
    expect(additions).toHaveLength(1);
    const content = additions[0]?.content ?? "";
    expect(content).toContain("<available_skills>");
    expect(content).toContain("&lt;xml&gt;");
    expect(content).toContain("&amp;");
    expect(content).toContain("&quot;");
  });
});
