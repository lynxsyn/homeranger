import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * Canonical cursor-pagination contract for @homescout/backend-core.
 *
 * Every list endpoint that returns paged results MUST consume
 * `cursorPageInput` (or `cursorPageInput.extend({ ...filters })`) for its
 * input and return `CursorPage<T>` for its output. The response shape is
 * `{ items: T[]; nextCursor: string | null }` — `nextCursor` is ALWAYS
 * present, `null` means "no more pages". Default page size is 20; max is
 * 100. Cursors are opaque base64-encoded JSON of `{ id }` — we keyset on the
 * time-sortable uuid(7) primary key (unique + exact, equals creation order)
 * and MUST be round-tripped via `encodeCursor` / `decodeCursor`.
 *
 * Mirrors the Doxus contract (doxus-web .../lib/pagination/cursor.ts) verbatim
 * so the repository layering is identical across both products.
 */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const cursorPageInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

/**
 * Clamp a caller-supplied limit into [1, MAX_PAGE_LIMIT], defaulting to 20.
 * Repositories call this so an out-of-range or omitted limit can never widen
 * a page beyond the contract (default 20 / max 100).
 */
export function clampLimit(limit?: number): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT);
}

/**
 * Encode a row's id as an opaque base64 cursor. We keyset on the primary key
 * alone because ids are uuid(7) — time-sortable, unique, and exact — so `id`
 * ordering equals creation order with no precision loss. (Embedding a JS Date
 * would truncate the DB's microsecond @db.Timestamptz(6) to milliseconds and
 * could duplicate a row at a same-millisecond page boundary.)
 */
export function encodeCursor(row: { id: string }): string {
  return Buffer.from(JSON.stringify({ id: row.id })).toString("base64");
}

/**
 * Decode a cursor produced by `encodeCursor`. Throws
 * `TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" })` on any
 * malformed input — the static message is intentional so no internal ids or
 * field names leak to the client.
 */
export function decodeCursor(cursor: string): { id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("id" in parsed) ||
    typeof (parsed as { id: unknown }).id !== "string"
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
  return { id: (parsed as { id: string }).id };
}

/**
 * Slice an over-fetched buffer into a `CursorPage`.
 *
 * Repositories MUST call `findMany` with `take: limit + 1` so this helper can
 * detect whether more pages exist. When `rows.length > limit`, the extra row
 * is dropped from `items` and the last included row is encoded as
 * `nextCursor`. Otherwise `nextCursor` is `null`.
 */
export function paginate<TRow extends { id: string }>(
  rows: TRow[],
  limit: number,
): CursorPage<TRow> {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  const lastIncluded = items[items.length - 1];
  return {
    items,
    nextCursor: lastIncluded ? encodeCursor(lastIncluded) : null,
  };
}
