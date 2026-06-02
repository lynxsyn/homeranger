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
 * A composite keyset cursor `{ sortValue, id, priceIsNull? }` for ordering by a
 * NON-unique column (price, lastSeenAt) with `id` as the unique tiebreaker.
 * `sortValue` is the primitive value of the sort column on the boundary row (a
 * number for pricePence, an ISO-8601 string for a timestamp). The pair is what
 * makes sorted pagination keyset-correct: a same-value run cannot skip or
 * duplicate a row at a page boundary because `id` disambiguates the tie.
 *
 * `priceIsNull` is a FIRST-CLASS keyset value for the price sort: pricePence is
 * nullable (`Int?`), and Postgres places NULLs LAST (ASC) / FIRST (DESC). When
 * the boundary row's price is NULL we cannot encode it as a number (any sentinel
 * desyncs: `NULL > -1` is NULL, not TRUE, so NULL-priced rows get silently
 * dropped from the next page). Instead we flag it and the repository's
 * `buildCompositeCursorFilter` branches on null-ness + direction using Prisma
 * `{ pricePence: null }` (compiles to `IS NULL`), whose NULL placement matches
 * Prisma's default orderBy — so no raw `NULLS LAST/FIRST` is required.
 * `sortValue` is left as a harmless `0` when `priceIsNull` is true.
 *
 * lastSeenAt microsecond caveat: lastSeenAt is `@db.Timestamptz(6)` but the
 * cursor encodes `toISOString()` (millisecond precision). This is NOT reachable
 * in M3 — every lastSeenAt is app-written via `new Date()` (JS Dates are .000µs,
 * so create and update agree on ms). A sub-millisecond same-instant boundary can
 * only arise from a DB `CURRENT_TIMESTAMP` default written outside
 * `upsertByAddress` (a future M4+ ingest/raw-SQL path); it is a documented M4+
 * consideration, not a current defect. See the regression note in
 * listing.repository.sort.integration.test.ts.
 */
export interface CompositeCursorPayload {
  sortValue: number | string;
  id: string;
  /** True when the boundary row's pricePence is NULL (price sort only). */
  priceIsNull?: boolean;
}

/** Encode a composite `{ sortValue, id }` keyset cursor as opaque base64. */
export function encodeCompositeCursor(payload: CompositeCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Decode a composite cursor produced by `encodeCompositeCursor`. Throws
 * `TRPCError BAD_REQUEST` ("Invalid cursor") on any malformed input — the
 * static message is intentional so no internal field names leak.
 */
export function decodeCompositeCursor(cursor: string): CompositeCursorPayload {
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
    !("sortValue" in parsed) ||
    typeof (parsed as { id: unknown }).id !== "string"
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
  const sortValue = (parsed as { sortValue: unknown }).sortValue;
  if (typeof sortValue !== "number" && typeof sortValue !== "string") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
  const rawPriceIsNull = (parsed as { priceIsNull?: unknown }).priceIsNull;
  if (rawPriceIsNull !== undefined && typeof rawPriceIsNull !== "boolean") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
  return {
    sortValue,
    id: (parsed as { id: string }).id,
    ...(rawPriceIsNull === true ? { priceIsNull: true } : {}),
  };
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
