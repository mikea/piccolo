/**
 * ext-instructions — Instructions extension for piccolo.
 *
 * Maintains a persistent list of user-authored instructions scoped to
 * 'everyone', 'user', or 'session'. Instructions are appended to the system
 * prompt on every session start via getSystemPromptAdditions().
 *
 * Management is done through the single 'instructions' tool exposed to the LLM
 * with action: list | add | remove.
 *
 * Spec ref: specs/instructions_extension.md
 */

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
import { addInstruction, listVisible, removeInstruction, type ScopeType } from "./db.ts";

// ── Env ───────────────────────────────────────────────────────────────────────

interface Env {
  INSTRUCTIONS_DB: D1Database;
}

// ── Zod schema — single source of truth for the tool input ───────────────────

const instructionsParamsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
  }),
  z.object({
    action: z.literal("add"),
    scope_type: z
      .enum(["everyone", "user", "session"])
      .describe(
        '"everyone": applies to all users in all sessions. ' +
          '"user": applies to all sessions for the current user. ' +
          '"session": applies only to the current session.',
      ),
    content: z.string().min(1).describe("The instruction text to add."),
  }),
  z.object({
    action: z.literal("remove"),
    id: z.string().uuid().describe("UUID of the instruction to remove."),
  }),
]);

type InstructionsParams = z.output<typeof instructionsParamsSchema>;

const instructionsInputSchema = z.toJSONSchema(instructionsParamsSchema, { target: "draft-07" });

// ── ToolDescriptor ────────────────────────────────────────────────────────────

const descriptor: ToolDescriptor = {
  name: "instructions",
  label: "Instructions",
  description: `Manage persistent instructions that are automatically appended to the system prompt.

Instructions are scoped:
- "everyone": visible in every session for every user (global)
- "user": visible in all sessions belonging to the current user
- "session": visible only in the current session

Actions:
- list   : Show all instructions currently active in this session (all scopes combined).
- add    : Add a new instruction. scope_type is required — no default.
           The instruction is inserted immediately and will appear in the system prompt
           from the next turn onward.
- remove : Remove an instruction by its UUID. Returns an error if the ID does not exist.`,

  promptSnippet: "Manage persistent instructions that are appended to the system prompt",

  promptGuidelines: [
    "Use 'instructions list' to see what instructions are currently active before adding new ones.",
    "Use 'everyone' scope for instructions that should apply globally to all users.",
    "Use 'user' scope for personal preferences that should persist across all your sessions.",
    "Use 'session' scope for temporary instructions that should only apply to the current conversation.",
  ],

  inputSchema: instructionsInputSchema,
};

// ── Shared logic (tested directly, also called by WorkerEntrypoint) ───────────

/**
 * Build the system prompt additions from the visible instructions for a session.
 * Extracted as a standalone function so tests can call it without constructing
 * a WorkerEntrypoint (which requires CF runtime env injection).
 *
 * Spec ref: specs/instructions_extension.md §System Prompt Injection
 */
export async function buildSystemPromptAdditions(
  db: D1Database,
  ctx: ISession,
): Promise<SystemPromptAddition[]> {
  const [userId, sessionId] = await Promise.all([ctx.userId(), ctx.sessionId()]);
  const rows = await listVisible(db, userId, sessionId);
  if (rows.length === 0) return [];
  const content = `## Instructions\n\n${rows.map((r) => `- ${r.content}`).join("\n")}`;
  return [{ section: "context", content, priority: 10 }];
}

// ── InstructionsTool ──────────────────────────────────────────────────────────

/**
 * RpcTarget implementing ITool for the 'instructions' tool.
 *
 * Receives the D1 database and session context at construction time (captured
 * from getTools(ctx) on the extension WorkerEntrypoint). Using constructor
 * injection avoids the need for this.env in RpcTarget subclasses.
 *
 * Spec ref: specs/instructions_extension.md §Tool
 */
export class InstructionsTool extends RpcTarget implements ITool {
  readonly #db: D1Database;
  readonly #ctx: ISession;

  constructor(db: D1Database, ctx: ISession) {
    super();
    this.#db = db;
    this.#ctx = ctx;
  }

  getDescriptor(): Promise<ToolDescriptor> {
    return Promise.resolve(descriptor);
  }

  async execute(_toolCallId: string, params: unknown, _ctx: ISession): Promise<ToolResult> {
    const parsed: InstructionsParams = instructionsParamsSchema.parse(params);

    switch (parsed.action) {
      case "list":
        return this.#list();
      case "add":
        return this.#add(parsed.scope_type, parsed.content);
      case "remove":
        return this.#remove(parsed.id);
      default: {
        // Exhaustive guard — TypeScript narrows parsed to never here.
        const _never: never = parsed;
        throw new Error(`Unknown action: ${JSON.stringify(_never)}`);
      }
    }
  }

  // ── Action implementations ──────────────────────────────────────────────────

  async #list(): Promise<ToolResult> {
    const [userId, sessionId] = await Promise.all([this.#ctx.userId(), this.#ctx.sessionId()]);
    const rows = await listVisible(this.#db, userId, sessionId);

    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: "No instructions are currently active in this session." }],
        details: { rows: [] },
      };
    }

    // Render as a plain-text table for the LLM
    const header =
      "id                                    scope_type  scope_id                              content";
    const separator = "-".repeat(header.length);
    const lines = rows.map((r) => {
      const id = r.id.padEnd(36);
      const scopeType = r.scope_type.padEnd(10);
      const scopeId = (r.scope_id || "(all)").padEnd(36);
      return `${id}  ${scopeType}  ${scopeId}  ${r.content}`;
    });

    const text = [header, separator, ...lines].join("\n");
    return { content: [{ type: "text", text }], details: { rows } };
  }

  async #add(scopeType: ScopeType, content: string): Promise<ToolResult> {
    let scopeId: string;
    if (scopeType === "everyone") {
      scopeId = "";
    } else if (scopeType === "user") {
      scopeId = await this.#ctx.userId();
    } else {
      scopeId = await this.#ctx.sessionId();
    }

    const id = await addInstruction(this.#db, scopeType, scopeId, content);
    return {
      content: [
        {
          type: "text",
          text: `Instruction added (id: ${id}, scope: ${scopeType}). It will appear in the system prompt from the next turn onward.`,
        },
      ],
      details: { id, scope_type: scopeType, scope_id: scopeId, content },
    };
  }

  async #remove(id: string): Promise<ToolResult> {
    const deleted = await removeInstruction(this.#db, id);
    if (!deleted) {
      throw new Error(`Instruction not found: ${id}`);
    }
    return {
      content: [{ type: "text", text: `Instruction ${id} removed.` }],
      details: { id },
    };
  }
}

// ── InstructionsExtension ─────────────────────────────────────────────────────

/**
 * WorkerEntrypoint for the instructions extension.
 * Exported as the default export of index.ts.
 *
 * Spec ref: specs/instructions_extension.md §Extension Worker
 */
export class InstructionsExtension extends WorkerEntrypoint<Env> implements IExtensionWorker {
  override fetch(): Response {
    return new Response("OK", { status: 200 });
  }

  async getTools(ctx: ISession): Promise<ITool[]> {
    return [new InstructionsTool(this.env.INSTRUCTIONS_DB, ctx)];
  }

  async getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[]> {
    return buildSystemPromptAdditions(this.env.INSTRUCTIONS_DB, ctx);
  }
}
