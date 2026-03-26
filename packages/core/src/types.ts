/**
 * packages/core internal types.
 *
 * This file contains ONLY implementation-detail types that are private to
 * piccolo-core and should never be exported to extensions or gateways.
 *
 * All public JSRPC contract types live in @piccolo/api.
 *
 * Spec ref: specs/core.md
 */

/**
 * Internal session record stored in D1. Not part of the JSRPC API surface.
 * Only piccolo-core's persistence layer uses this directly.
 */
export interface SessionRecord {
  id: string; // UUID v4
  userId: string;
  createdAt: number; // Unix ms
  updatedAt: number; // Unix ms
  name?: string;
  cwd?: string;
}
