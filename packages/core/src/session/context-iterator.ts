import type { AnyEntry, BranchSummaryEntry } from "../db/entry-types.ts";
import { parseEntry } from "../db/entry-types.ts";
import { getPathEntriesBackward } from "../db/schema.ts";

const DEFAULT_PAGE_SIZE = 64;

interface ContextIteratorOptions {
  db: D1Database;
  sessionId: string;
  leafId: string | null;
  pageSize?: number;
}

/**
 * Streams context entries from newest to oldest along the active path.
 *
 * The iterator pages from D1 in append-descending order and supports explicit
 * path jumps when a branch_summary marker is encountered.
 */
export class ContextIterator implements AsyncIterable<AnyEntry>, AsyncIterator<AnyEntry> {
  readonly #db: D1Database;
  readonly #sessionId: string;
  readonly #pageSize: number;

  #nextStartId: string | null;
  #buffer: AnyEntry[] = [];
  #seenStartIds = new Set<string>();
  #done = false;

  constructor(options: ContextIteratorOptions) {
    this.#db = options.db;
    this.#sessionId = options.sessionId;
    this.#nextStartId = options.leafId;
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  [Symbol.asyncIterator](): AsyncIterator<AnyEntry> {
    return this;
  }

  async next(): Promise<IteratorResult<AnyEntry>> {
    while (this.#buffer.length === 0 && !this.#done) {
      await this.#fillBuffer();
    }

    const entry = this.#buffer.shift();
    if (entry === undefined) {
      return { done: true, value: undefined };
    }

    if (entry.type === "branch_summary") {
      const jumpId = (entry as BranchSummaryEntry).data.fromId;
      this.#buffer = [];
      this.#nextStartId =
        typeof jumpId === "string" &&
        jumpId.length > 0 &&
        jumpId !== entry.id &&
        !this.#seenStartIds.has(jumpId)
          ? jumpId
          : null;
    }

    return { done: false, value: entry };
  }

  async #fillBuffer(): Promise<void> {
    const startId = this.#nextStartId;
    if (startId === null) {
      this.#done = true;
      return;
    }
    if (this.#seenStartIds.has(startId)) {
      this.#done = true;
      return;
    }
    this.#seenStartIds.add(startId);

    const rows = await getPathEntriesBackward(this.#db, this.#sessionId, startId, this.#pageSize);
    if (rows.length === 0) {
      this.#done = true;
      return;
    }

    this.#buffer = rows.map(parseEntry);
    const oldest = rows.at(-1);
    this.#nextStartId = oldest?.parent_id ?? null;
  }
}
