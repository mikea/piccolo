import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  IExtensionWorker,
  ISession,
  ITool,
  SystemPromptAddition,
  ToolDescriptor,
  ToolResult,
} from "@piccolo/api";
import * as z from "zod";
import {
  findVisibleSkillByName,
  getByScopeAndFileName,
  listVisibleSkills,
  type ScopeLabel,
  scopeLabelForRow,
  upsertSkillByScopeAndFileName,
} from "./db.ts";
import { parseSkillDocument } from "./parser.ts";

interface Env {
  SKILLS_DB: D1Database;
  BUCKET: R2Bucket;
}

const importSkillsSchema = z.object({
  path: z.string().min(1),
  scope: z.enum(["global", "user", "session"]),
  max_files: z.number().int().min(1).max(10000).optional(),
  max_file_bytes: z.number().int().min(1).max(1_000_000).optional(),
});

const listSkillsSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  include_inactive: z.boolean().optional(),
});

const activateSkillSchema = z.object({
  name: z.string().min(1),
  arguments: z.string().optional(),
});

const importSkillsDescriptor: ToolDescriptor = {
  name: "import_skills",
  label: "Import Skills",
  description:
    "Import Agent Skills from an R2 path recursively. Only SKILL.md files are imported. " +
    "Imported files are parsed and stored in D1 with strict Agent Skills frontmatter validation.",
  promptSnippet: "Import SKILL.md files from R2 into the skills registry",
  inputSchema: z.toJSONSchema(importSkillsSchema, { target: "draft-07" }),
};

const listSkillsDescriptor: ToolDescriptor = {
  name: "list_skills",
  label: "List Skills",
  description:
    "List visible skills for this session. Results include scope origin (global/user/session) and active state.",
  promptSnippet: "List visible skills and their scopes",
  inputSchema: z.toJSONSchema(listSkillsSchema, { target: "draft-07" }),
};

const activateSkillDescriptor: ToolDescriptor = {
  name: "activate_skill",
  label: "Activate Skill",
  description:
    "Load full SKILL.md content for a visible active skill by name. " +
    "Resolution order is session scope, then user scope, then global scope. " +
    "Reference: https://agentskills.io/client-implementation/adding-skills-support#step-4-activate-skills",
  promptSnippet: "Load full instructions for a selected skill",
  inputSchema: z.toJSONSchema(activateSkillSchema, { target: "draft-07" }),
};

interface ImportSummary {
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  diagnostics: string[];
}

export async function buildSkillsPromptAddition(
  db: D1Database,
  ctx: ISession,
): Promise<SystemPromptAddition[]> {
  // Progressive disclosure catalog format for model-side skill discovery.
  // Integration guidance: https://agentskills.io/client-implementation/adding-skills-support#step-3-disclose-available-skills-to-the-model
  const [userId, sessionId] = await Promise.all([ctx.userId(), ctx.sessionId()]);
  const rows = await listVisibleSkills(db, userId, sessionId);
  if (rows.length === 0) return [];

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Call activate_skill with a skill name when the task matches its description.",
    "",
    "<available_skills>",
  ];

  for (const row of rows) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(row.name)}</name>`);
    lines.push(`    <description>${escapeXml(row.description)}</description>`);
    lines.push(`    <location>${escapeXml(`r2://skills/${row.file_name}`)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");

  return [{ section: "skills", content: lines.join("\n"), priority: 100 }];
}

export class ImportSkillsTool extends RpcTarget implements ITool {
  readonly #db: D1Database;
  readonly #bucket: R2Bucket;

  constructor(db: D1Database, bucket: R2Bucket) {
    super();
    this.#db = db;
    this.#bucket = bucket;
  }

  getDescriptor(): Promise<ToolDescriptor> {
    return Promise.resolve(importSkillsDescriptor);
  }

  async execute(_toolCallId: string, params: unknown, ctx: ISession): Promise<ToolResult> {
    const parsed = importSkillsSchema.parse(params);
    const { userId, sessionId } = await resolveScope(parsed.scope, ctx);
    const summary = await this.#importPath(
      parsed.path,
      userId,
      sessionId,
      parsed.max_files ?? 2000,
      parsed.max_file_bytes ?? 200_000,
    );
    const text =
      `Imported skills from '${parsed.path}'. ` +
      `Scanned: ${summary.scanned}, inserted: ${summary.inserted}, updated: ${summary.updated}, ` +
      `skipped: ${summary.skipped}, errors: ${summary.errors}.`;

    return {
      content: [{ type: "text", text }],
      details: {
        scope: parsed.scope,
        user_id: userId,
        session_id: sessionId,
        ...summary,
      },
    };
  }

  async #importPath(
    path: string,
    userId: string | null,
    sessionId: string | null,
    maxFiles: number,
    maxFileBytes: number,
  ): Promise<ImportSummary> {
    const summary: ImportSummary = {
      scanned: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      diagnostics: [],
    };

    const skillKeys = await listSkillKeys(this.#bucket, path, maxFiles);
    if (skillKeys.truncatedByMax) {
      summary.diagnostics.push(`Hit max_files=${maxFiles}. Import stopped early.`);
    }

    for (const key of skillKeys.keys) {
      summary.scanned += 1;
      const result = await importSingleSkill(this.#bucket, this.#db, {
        key,
        userId,
        sessionId,
        maxFileBytes,
      });
      if (result.type === "inserted") summary.inserted += 1;
      else if (result.type === "updated") summary.updated += 1;
      else if (result.type === "skipped") summary.skipped += 1;
      else if (result.type === "error") {
        summary.errors += 1;
        summary.diagnostics.push(result.message);
      }
    }

    return summary;
  }
}

export class ListSkillsTool extends RpcTarget implements ITool {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    super();
    this.#db = db;
  }

  getDescriptor(): Promise<ToolDescriptor> {
    return Promise.resolve(listSkillsDescriptor);
  }

  async execute(_toolCallId: string, params: unknown, ctx: ISession): Promise<ToolResult> {
    const parsed = listSkillsSchema.parse(params ?? {});
    const [userId, sessionId] = await Promise.all([ctx.userId(), ctx.sessionId()]);
    const rows = await listVisibleSkills(this.#db, userId, sessionId, parsed.query);
    const offset = parsed.offset ?? 0;
    const limit = parsed.limit ?? 100;
    const page = rows.slice(offset, offset + limit);

    if (page.length === 0) {
      return {
        content: [{ type: "text", text: "No visible skills found." }],
        details: { total: rows.length, rows: [] },
      };
    }

    const header =
      "name                             scope     active  file_name\n" +
      "--------------------------------------------------------------------------";
    const lines = page.map((row) => {
      const name = row.name.padEnd(32);
      const scope = scopeLabelForRow(row).padEnd(8);
      const active = String(row.active).padEnd(6);
      return `${name} ${scope} ${active}  ${row.file_name}`;
    });
    const text = `${header}\n${lines.join("\n")}`;

    return {
      content: [{ type: "text", text }],
      details: {
        total: rows.length,
        offset,
        limit,
        rows: page.map((row) => ({
          name: row.name,
          description: row.description,
          scope: scopeLabelForRow(row),
          active: row.active === 1,
          file_name: row.file_name,
          updated_at: row.updated_at,
        })),
      },
    };
  }
}

export class ActivateSkillTool extends RpcTarget implements ITool {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    super();
    this.#db = db;
  }

  getDescriptor(): Promise<ToolDescriptor> {
    return Promise.resolve(activateSkillDescriptor);
  }

  async execute(_toolCallId: string, params: unknown, ctx: ISession): Promise<ToolResult> {
    const parsed = activateSkillSchema.parse(params);
    const [userId, sessionId] = await Promise.all([ctx.userId(), ctx.sessionId()]);
    const row = await findVisibleSkillByName(this.#db, userId, sessionId, parsed.name);
    if (!row) {
      throw new Error(`Skill not found or inactive: ${parsed.name}`);
    }

    const text =
      parsed.arguments && parsed.arguments.trim().length > 0
        ? `${row.content}\n\nUser arguments: ${parsed.arguments.trim()}`
        : row.content;

    return {
      content: [{ type: "text", text }],
      details: {
        name: row.name,
        scope: scopeLabelForRow(row),
        file_name: row.file_name,
      },
    };
  }
}

export class SkillsExtension extends WorkerEntrypoint<Env> implements IExtensionWorker {
  override fetch(): Response {
    return new Response("OK", { status: 200 });
  }

  async getTools(_ctx: ISession): Promise<ITool[]> {
    return [
      new ImportSkillsTool(this.env.SKILLS_DB, this.env.BUCKET),
      new ListSkillsTool(this.env.SKILLS_DB),
      new ActivateSkillTool(this.env.SKILLS_DB),
    ];
  }

  async getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[]> {
    return buildSkillsPromptAddition(this.env.SKILLS_DB, ctx);
  }
}

async function resolveScope(
  scope: ScopeLabel,
  ctx: ISession,
): Promise<{ userId: string | null; sessionId: string | null }> {
  if (scope === "global") return { userId: null, sessionId: null };
  if (scope === "user") return { userId: await ctx.userId(), sessionId: null };
  return { userId: null, sessionId: await ctx.sessionId() };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function listSkillKeys(
  bucket: R2Bucket,
  path: string,
  maxFiles: number,
): Promise<{ keys: string[]; truncatedByMax: boolean }> {
  const keys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const options: R2ListOptions = cursor
      ? { prefix: path, cursor, limit: 1000 }
      : { prefix: path, limit: 1000 };
    const listed = await bucket.list(options);
    for (const object of listed.objects) {
      if (!object.key.endsWith("SKILL.md")) continue;
      keys.push(object.key);
      if (keys.length >= maxFiles) {
        return { keys, truncatedByMax: true };
      }
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }

  return { keys, truncatedByMax: false };
}

async function importSingleSkill(
  bucket: R2Bucket,
  db: D1Database,
  options: {
    key: string;
    userId: string | null;
    sessionId: string | null;
    maxFileBytes: number;
  },
): Promise<{ type: "inserted" | "updated" | "skipped" } | { type: "error"; message: string }> {
  try {
    const file = await bucket.get(options.key);
    if (!file) {
      return { type: "error", message: `Missing object: ${options.key}` };
    }
    if (file.size > options.maxFileBytes) {
      return {
        type: "error",
        message: `File too large (${file.size} bytes, max ${options.maxFileBytes}): ${options.key}`,
      };
    }

    const text = await file.text();
    const sha = await sha256Hex(text);
    const existing = await getByScopeAndFileName(
      db,
      options.userId,
      options.sessionId,
      options.key,
    );
    if (existing?.sha256 === sha) {
      return { type: "skipped" };
    }

    const parsed = parseSkillDocument(text);
    const upsert = await upsertSkillByScopeAndFileName(db, {
      userId: options.userId,
      sessionId: options.sessionId,
      fileName: options.key,
      name: parsed.name,
      description: parsed.description,
      license: parsed.license,
      compatibility: parsed.compatibility,
      metadataJson: parsed.metadataJson,
      allowedTools: parsed.allowedTools,
      content: parsed.content,
      sha256: sha,
    });
    return { type: upsert.inserted ? "inserted" : "updated" };
  } catch (error) {
    return {
      type: "error",
      message: `${options.key}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
