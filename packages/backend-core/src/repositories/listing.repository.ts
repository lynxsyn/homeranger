/**
 * Listing repository — owns ALL Prisma access for the Listing aggregate plus
 * the raw pgvector cosine-similarity query. Per aide/rules/backend.md:
 * repositories are the ONLY layer that touches `prisma.*`; services call this
 * surface and never the client directly. Every write method accepts an
 * optional `tx` so a service can compose it into a larger transaction.
 *
 * Patterns mirrored from Doxus:
 *   - optional-tx via `const db = tx ?? prisma` (notification.repository.ts)
 *   - cursor pagination via over-fetch + `paginate()` (lib/pagination/cursor)
 *   - raw SQL with `Prisma.sql` + `Prisma.join` + `ANY(ARRAY[...]::T[])`
 *     (outbox.repository.ts / scheduled-report.repository.ts) so dynamic
 *     filters stay fully parameterised — no string concatenation.
 */
import {
  Prisma,
  type EpcRating,
  type ListingSource,
  type ListingStatus,
  type PropertyType,
  type Tenure,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { ListingSortField, SortDirection } from "@homescout/shared";
import {
  clampLimit,
  decodeCompositeCursor,
  encodeCompositeCursor,
  type CompositeCursorPayload,
  type CursorPage,
} from "../lib/pagination/cursor.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

/** Embedding dimensionality for Voyage voyage-3.5 (locked decision). */
export const EMBEDDING_DIMENSIONS = 1024;

const LISTING_SELECT = Prisma.validator<Prisma.ListingSelect>()({
  id: true,
  addressNormalized: true,
  postcode: true,
  outcode: true,
  pricePence: true,
  bedrooms: true,
  tenure: true,
  propertyType: true,
  epcRating: true,
  listingStatus: true,
  isPreMarket: true,
  listingUrl: true,
  primarySource: true,
  firstSeenAt: true,
  lastSeenAt: true,
  createdAt: true,
  updatedAt: true,
  // NB: `embedding` (Unsupported("vector(1024)")) is intentionally NOT in any
  // Prisma select — Unsupported columns cannot be projected by the typed
  // client. The vector is read/written only via the raw helpers below.
});

export type ListingRecord = Prisma.ListingGetPayload<{
  select: typeof LISTING_SELECT;
}>;

/** Structured pre-filter shared by `list` and `vectorTopK`. */
export interface ListingFilter {
  outcodes?: string[];
  minPricePence?: number;
  maxPricePence?: number;
  minBedrooms?: number;
  listingStatus?: ListingStatus;
  isPreMarket?: boolean;
}

/**
 * Sort descriptor for `list`. `combinedScore` falls back to the id keyset
 * (the ListingScore relation arrives M5); `price` and `lastSeenAt` use a
 * correct composite keyset cursor over the (sort column, id) tuple.
 */
export interface ListListingsSort {
  sortBy: ListingSortField;
  sortDir: SortDirection;
}

export interface ListListingsInput {
  filter?: ListingFilter;
  sort?: ListListingsSort;
  cursor?: string;
  limit?: number;
}

/** Idempotent upsert keyed on the dedup column `addressNormalized`. */
export interface UpsertListingByAddressInput {
  addressNormalized: string;
  postcode: string | null;
  outcode: string | null;
  pricePence: number | null;
  bedrooms: number | null;
  tenure: Tenure | null;
  propertyType: PropertyType | null;
  epcRating: EpcRating | null;
  listingStatus: ListingStatus;
  isPreMarket: boolean;
  listingUrl: string | null;
  primarySource: ListingSource;
}

/** A vectorTopK hit: the projected listing columns plus the cosine distance. */
export type VectorTopKResult = ListingRecord & {
  /** pgvector cosine distance (`<=>`): 0 = identical, 2 = opposite. */
  distance: number;
};

function buildWhere(filter?: ListingFilter): Prisma.ListingWhereInput {
  if (!filter) {
    return {};
  }
  const where: Prisma.ListingWhereInput = {};
  if (filter.outcodes && filter.outcodes.length > 0) {
    where.outcode = { in: filter.outcodes };
  }
  if (filter.minPricePence !== undefined || filter.maxPricePence !== undefined) {
    where.pricePence = {
      ...(filter.minPricePence !== undefined
        ? { gte: filter.minPricePence }
        : {}),
      ...(filter.maxPricePence !== undefined
        ? { lte: filter.maxPricePence }
        : {}),
    };
  }
  if (filter.minBedrooms !== undefined) {
    where.bedrooms = { gte: filter.minBedrooms };
  }
  if (filter.listingStatus !== undefined) {
    where.listingStatus = filter.listingStatus;
  }
  if (filter.isPreMarket !== undefined) {
    where.isPreMarket = filter.isPreMarket;
  }
  return where;
}

/**
 * Compose the raw pre-filter for `vectorTopK` as a list of parameterised
 * `Prisma.sql` fragments. Each fragment binds its values (`${...}`) so there
 * is zero string interpolation of caller input — the SQL injection surface is
 * the same as Prisma's tagged-template path.
 */
function buildRawFilterFragments(filter?: ListingFilter): Prisma.Sql[] {
  const fragments: Prisma.Sql[] = [Prisma.sql`"embedding" IS NOT NULL`];
  if (!filter) {
    return fragments;
  }
  if (filter.outcodes && filter.outcodes.length > 0) {
    fragments.push(
      Prisma.sql`"outcode" = ANY(ARRAY[${Prisma.join(filter.outcodes)}]::text[])`,
    );
  }
  if (filter.minPricePence !== undefined) {
    fragments.push(Prisma.sql`"pricePence" >= ${filter.minPricePence}`);
  }
  if (filter.maxPricePence !== undefined) {
    fragments.push(Prisma.sql`"pricePence" <= ${filter.maxPricePence}`);
  }
  if (filter.minBedrooms !== undefined) {
    fragments.push(Prisma.sql`"bedrooms" >= ${filter.minBedrooms}`);
  }
  if (filter.listingStatus !== undefined) {
    fragments.push(
      Prisma.sql`"listingStatus" = ${filter.listingStatus}::"ListingStatus"`,
    );
  }
  if (filter.isPreMarket !== undefined) {
    fragments.push(Prisma.sql`"isPreMarket" = ${filter.isPreMarket}`);
  }
  return fragments;
}

/**
 * Serialise a JS number[] into the pgvector text literal `'[a,b,c]'`. The
 * resulting string is bound as a single `$N` parameter and cast `::vector` in
 * SQL — it is NEVER concatenated into the statement, so it cannot inject.
 * Validates length to fail fast on a mis-sized embedding.
 */
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding must have ${EMBEDDING_DIMENSIONS} dimensions, received ${embedding.length}`,
    );
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding contains a non-finite value");
    }
  }
  return `[${embedding.join(",")}]`;
}

/**
 * Raw filter fragments for the combinedScore list path, qualified with the
 * `l.` (Listing) alias so they are unambiguous across the LEFT JOIN to
 * ListingScore (`id`/`createdAt`/`updatedAt` exist on both tables). No embedding
 * constraint (unlike `buildRawFilterFragments`, which is vectorTopK-only).
 */
function buildScoreFilterFragments(filter?: ListingFilter): Prisma.Sql[] {
  const fragments: Prisma.Sql[] = [];
  if (!filter) {
    return fragments;
  }
  if (filter.outcodes && filter.outcodes.length > 0) {
    fragments.push(
      Prisma.sql`l."outcode" = ANY(ARRAY[${Prisma.join(filter.outcodes)}]::text[])`,
    );
  }
  if (filter.minPricePence !== undefined) {
    fragments.push(Prisma.sql`l."pricePence" >= ${filter.minPricePence}`);
  }
  if (filter.maxPricePence !== undefined) {
    fragments.push(Prisma.sql`l."pricePence" <= ${filter.maxPricePence}`);
  }
  if (filter.minBedrooms !== undefined) {
    fragments.push(Prisma.sql`l."bedrooms" >= ${filter.minBedrooms}`);
  }
  if (filter.listingStatus !== undefined) {
    fragments.push(
      Prisma.sql`l."listingStatus" = ${filter.listingStatus}::"ListingStatus"`,
    );
  }
  if (filter.isPreMarket !== undefined) {
    fragments.push(Prisma.sql`l."isPreMarket" = ${filter.isPreMarket}`);
  }
  return fragments;
}

/**
 * Composite keyset predicate for `combinedScore <dir> NULLS LAST, id <dir>`.
 * Mirrors the price nullable keyset but for a LEFT-JOINed, NULLS-LAST score:
 *
 *   non-null boundary v (DESC): combinedScore < v
 *                               OR (combinedScore = v AND id < lastId)
 *                               OR combinedScore IS NULL   (NULLs trail → still ahead)
 *   non-null boundary v (ASC):  combinedScore > v
 *                               OR (combinedScore = v AND id > lastId)
 *                               OR combinedScore IS NULL
 *   NULL boundary (DESC): combinedScore IS NULL AND id < lastId  (every non-null already emitted)
 *   NULL boundary (ASC):  combinedScore IS NULL AND id > lastId
 */
function buildScoreCursorFragment(
  cursor: CompositeCursorPayload,
  dir: "asc" | "desc",
): Prisma.Sql {
  if (cursor.scoreIsNull) {
    return dir === "asc"
      ? Prisma.sql`ls."combinedScore" IS NULL AND l."id" > ${cursor.id}::uuid`
      : Prisma.sql`ls."combinedScore" IS NULL AND l."id" < ${cursor.id}::uuid`;
  }
  const v = cursor.sortValue as number;
  return dir === "asc"
    ? Prisma.sql`(ls."combinedScore" > ${v} OR (ls."combinedScore" = ${v} AND l."id" > ${cursor.id}::uuid) OR ls."combinedScore" IS NULL)`
    : Prisma.sql`(ls."combinedScore" < ${v} OR (ls."combinedScore" = ${v} AND l."id" < ${cursor.id}::uuid) OR ls."combinedScore" IS NULL)`;
}

/** The Prisma scalar column a non-default sort orders by. */
type SortColumn = "pricePence" | "lastSeenAt";

/**
 * Resolve the sort to a Prisma scalar column, or `null` for the default
 * `combinedScore` path (which keysets on `id` until M5 supplies scores).
 */
function sortColumnFor(sort?: ListListingsSort): SortColumn | null {
  if (!sort || sort.sortBy === "combinedScore") {
    return null;
  }
  return sort.sortBy === "price" ? "pricePence" : "lastSeenAt";
}

/**
 * Build the composite cursor payload from a boundary row. pricePence is
 * nullable, so a NULL boundary is encoded as a FIRST-CLASS keyset value via
 * `priceIsNull: true` (NOT a `-1` sentinel — see cursor.ts: any numeric
 * sentinel desyncs because `NULL > sentinel` is NULL, silently dropping every
 * remaining NULL-priced row from the next page). `sortValue` is a harmless `0`
 * placeholder when the price is NULL.
 *
 * lastSeenAt is encoded as an ISO string (NOT NULL in the schema). The
 * millisecond-truncation caveat (cursor.ts) is not reachable in M3.
 */
function cursorPayloadOf(
  row: ListingRecord,
  column: SortColumn,
): { sortValue: number | string; priceIsNull?: boolean } {
  if (column === "pricePence") {
    if (row.pricePence === null) {
      return { sortValue: 0, priceIsNull: true };
    }
    return { sortValue: row.pricePence };
  }
  return { sortValue: row.lastSeenAt.toISOString() };
}

/**
 * Build the composite keyset WHERE for a `(column, id)`-ordered page.
 *
 * For a NOT-NULL column (lastSeenAt): the next ASC page is rows where
 * `(column, id) > (sortValue, id)`, i.e. `column > sortValue OR (column =
 * sortValue AND id > lastId)`; DESC flips the comparisons to `<`. The `id`
 * tiebreaker makes the keyset exact even on tied values — no skip, no overlap.
 *
 * For the NULLABLE price column the predicate ALSO branches on whether the
 * boundary row's price is NULL, matching Postgres' default NULL placement
 * (ASC → NULLS LAST, DESC → NULLS FIRST). Prisma `{ pricePence: null }`
 * compiles to `IS NULL` and its default orderBy NULL placement agrees, so no
 * raw `NULLS LAST/FIRST` is needed:
 *
 *   ASC, non-null boundary v:  pricePence > v  OR  pricePence IS NULL  OR
 *                              (pricePence = v AND id > lastId)
 *     (NULLs sort AFTER every non-null, so they are still ahead → include them)
 *   ASC, NULL boundary:        pricePence IS NULL AND id > lastId
 *     (NULLs are the TRAILING block in ASC, so every non-null is already
 *      emitted; only the remaining NULLs by id remain)
 *   DESC, non-null boundary v: pricePence < v  OR  (pricePence = v AND id < lastId)
 *     (NULLs sort BEFORE every non-null, so they were already emitted →
 *      do NOT re-include them)
 *   DESC, NULL boundary:       (pricePence IS NULL AND id < lastId)  OR
 *                              pricePence IS NOT NULL
 *     (NULLs are the LEADING block in DESC: the remaining NULLs are those with
 *      a smaller id, and EVERY non-null row still follows them — both must be
 *      paged or the entire non-null tail is silently skipped)
 */
function buildCompositeCursorFilter(
  column: SortColumn,
  cursor: CompositeCursorPayload,
  dir: "asc" | "desc",
): Prisma.ListingWhereInput {
  const cmp = dir === "asc" ? "gt" : "lt";

  if (column === "lastSeenAt") {
    const boundary = new Date(cursor.sortValue as string);
    return {
      OR: [
        { lastSeenAt: { [cmp]: boundary } } as Prisma.ListingWhereInput,
        {
          AND: [{ lastSeenAt: boundary }, { id: { [cmp]: cursor.id } }],
        } as Prisma.ListingWhereInput,
      ],
    };
  }

  // pricePence (nullable) — branch on direction AND boundary null-ness.
  if (cursor.priceIsNull) {
    if (dir === "asc") {
      // NULLs are the TRAILING block in ASC: every non-null is already
      // emitted, only the remaining NULLs (by id) follow.
      return {
        AND: [{ pricePence: null }, { id: { gt: cursor.id } }],
      };
    }
    // NULLs are the LEADING block in DESC: the remaining NULLs are those with
    // a smaller id, and EVERY non-null row still follows the NULL block — both
    // must be paged or the non-null tail is silently skipped.
    return {
      OR: [
        { AND: [{ pricePence: null }, { id: { lt: cursor.id } }] },
        { pricePence: { not: null } },
      ],
    };
  }

  const boundary = cursor.sortValue as number;
  if (dir === "asc") {
    return {
      OR: [
        { pricePence: { gt: boundary } },
        { pricePence: null }, // NULLs sort LAST → still ahead of us in ASC
        { AND: [{ pricePence: boundary }, { id: { gt: cursor.id } }] },
      ],
    };
  }
  return {
    OR: [
      { pricePence: { lt: boundary } },
      // NULLs sort FIRST in DESC → already emitted, do NOT re-include.
      { AND: [{ pricePence: boundary }, { id: { lt: cursor.id } }] },
    ],
  };
}

export class ListingRepository {
  /**
   * Cursor-paginated list with an optional structured filter + sort.
   * Over-fetches `limit + 1` to compute `nextCursor`. Returns `{ items,
   * nextCursor }`, default 20 / max 100.
   *
   * Sort (M3 AC#2 — applied in the repository, never in memory):
   *   - `combinedScore` (default, M5): LEFT JOIN ListingScore, order by
   *     `combinedScore <dir> NULLS LAST, id <dir>` via raw SQL (`listByCombinedScore`)
   *     — unscored listings trail. Keyset over (combinedScore, id).
   *   - `price` / `lastSeenAt`: ordered by `[{column: dir}, {id: dir}]` with a
   *     COMPOSITE keyset cursor `{ sortValue, id }` so sorted pagination across
   *     pages has no skip and no overlap even on tied values.
   */
  async list(input: ListListingsInput = {}): Promise<CursorPage<ListingRecord>> {
    const limit = clampLimit(input.limit);
    const where = buildWhere(input.filter);
    const column = sortColumnFor(input.sort);
    const dir = input.sort?.sortDir ?? "desc";

    if (column === null) {
      // combinedScore path (M5): LEFT JOIN ListingScore and order by
      // `combinedScore <dir> NULLS LAST, id <dir>` so unscored listings always
      // trail. Prisma can't orderBy a to-many relation field, so this is raw SQL
      // (the same pattern as vectorTopK), keyset-paginated over (combinedScore, id).
      return this.listByCombinedScore(input.filter, input.cursor, dir, limit);
    }

    // Sorted path: composite (column, id) keyset.
    const cursorFilter = input.cursor
      ? buildCompositeCursorFilter(column, decodeCompositeCursor(input.cursor), dir)
      : {};
    const rows = await prisma.listing.findMany({
      where: { ...where, ...cursorFilter },
      orderBy: [{ [column]: dir }, { id: dir }],
      take: limit + 1,
      select: LISTING_SELECT,
    });
    if (rows.length <= limit) {
      return { items: rows, nextCursor: null };
    }
    const items = rows.slice(0, limit);
    const last = items[items.length - 1]!;
    return {
      items,
      nextCursor: encodeCompositeCursor({
        ...cursorPayloadOf(last, column),
        id: last.id,
      }),
    };
  }

  async getById(id: string): Promise<ListingRecord | null> {
    return prisma.listing.findUnique({
      where: { id },
      select: LISTING_SELECT,
    });
  }

  /**
   * Exact lookup on the unique dedup key `addressNormalized`. Backs the
   * DedupService exact-match stage: the canonical address the extractor +
   * dedup produce is looked up here, and a hit is a certain duplicate. M2
   * shipped getById / list / upsertByAddress / writeEmbedding / vectorTopK but
   * no by-dedup-key read; M4 adds this one method (the column is `@unique`, so
   * findUnique is valid).
   */
  async getByAddressNormalized(
    addressNormalized: string,
  ): Promise<ListingRecord | null> {
    return prisma.listing.findUnique({
      where: { addressNormalized },
      select: LISTING_SELECT,
    });
  }

  /**
   * Idempotent upsert keyed on the unique `addressNormalized` dedup column.
   * Re-ingesting the same address UPDATES (refreshes mutable fields +
   * `lastSeenAt`) rather than inserting a duplicate. `firstSeenAt` is only set
   * on create. The embedding is written separately via `writeEmbedding`.
   */
  async upsertByAddress(
    input: UpsertListingByAddressInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ListingRecord> {
    const db: PrismaLike = tx ?? prisma;
    const now = new Date();
    return db.listing.upsert({
      where: { addressNormalized: input.addressNormalized },
      create: {
        addressNormalized: input.addressNormalized,
        postcode: input.postcode,
        outcode: input.outcode,
        pricePence: input.pricePence,
        bedrooms: input.bedrooms,
        tenure: input.tenure,
        propertyType: input.propertyType,
        epcRating: input.epcRating,
        listingStatus: input.listingStatus,
        isPreMarket: input.isPreMarket,
        listingUrl: input.listingUrl,
        primarySource: input.primarySource,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        postcode: input.postcode,
        outcode: input.outcode,
        pricePence: input.pricePence,
        bedrooms: input.bedrooms,
        tenure: input.tenure,
        propertyType: input.propertyType,
        epcRating: input.epcRating,
        listingStatus: input.listingStatus,
        isPreMarket: input.isPreMarket,
        listingUrl: input.listingUrl,
        primarySource: input.primarySource,
        lastSeenAt: now,
      },
      select: LISTING_SELECT,
    });
  }

  /**
   * Update an EXISTING listing by id — the merge primitive the dedup path needs
   * when a match was found by a key OTHER than the candidate's addressNormalized
   * (the embedding fallback returns the existing listing's id, whose
   * addressNormalized differs from the new candidate's). `upsertByAddress`
   * cannot express this because addressNormalized is its only key, so an
   * embedding match would otherwise INSERT a duplicate. Refreshes the mutable
   * fields + `lastSeenAt`; `firstSeenAt` and `addressNormalized` are left
   * untouched (we merge INTO the existing row, never re-key it).
   */
  async updateById(
    listingId: string,
    fields: Omit<UpsertListingByAddressInput, "addressNormalized">,
    tx?: Prisma.TransactionClient,
  ): Promise<ListingRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.listing.update({
      where: { id: listingId },
      data: {
        postcode: fields.postcode,
        outcode: fields.outcode,
        pricePence: fields.pricePence,
        bedrooms: fields.bedrooms,
        tenure: fields.tenure,
        propertyType: fields.propertyType,
        epcRating: fields.epcRating,
        listingStatus: fields.listingStatus,
        isPreMarket: fields.isPreMarket,
        listingUrl: fields.listingUrl,
        primarySource: fields.primarySource,
        lastSeenAt: new Date(),
      },
      select: LISTING_SELECT,
    });
  }

  /**
   * Write (or clear) a listing's embedding. The `embedding` column is
   * `Unsupported("vector(1024)")`, so the typed client cannot set it — we use
   * raw `$executeRaw`. The vector is bound as a single text parameter and cast
   * `::vector`; the id is bound and cast `::uuid`. Returns the number of rows
   * updated (0 if the id does not exist).
   */
  async writeEmbedding(
    listingId: string,
    embedding: number[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db: PrismaLike = tx ?? prisma;
    const literal = toVectorLiteral(embedding);
    return db.$executeRaw`
      UPDATE "Listing"
      SET "embedding" = ${literal}::vector,
          "updatedAt" = NOW()
      WHERE "id" = ${listingId}::uuid
    `;
  }

  /**
   * Raw cosine-similarity top-K. Orders by `"embedding" <=> $query` ascending
   * (smaller cosine distance = more similar = nearer first), applies the
   * optional structured pre-filter BEFORE ranking, and returns the projected
   * listing columns plus the distance. The HNSW `vector_cosine_ops` index
   * (created in the raw migration) backs the `<=>` operator.
   */
  async vectorTopK(
    embedding: number[],
    k: number,
    prefilter?: ListingFilter,
  ): Promise<VectorTopKResult[]> {
    const limit = clampLimit(k);
    const queryLiteral = toVectorLiteral(embedding);
    const whereSql = Prisma.join(buildRawFilterFragments(prefilter), " AND ");

    const rows = await prisma.$queryRaw<
      Array<
        Omit<ListingRecord, "id"> & { id: string; distance: number | string }
      >
    >(Prisma.sql`
      SELECT
        "id"::text AS "id",
        "addressNormalized",
        "postcode",
        "outcode",
        "pricePence",
        "bedrooms",
        "tenure",
        "propertyType",
        "epcRating",
        "listingStatus",
        "isPreMarket",
        "listingUrl",
        "primarySource",
        "firstSeenAt",
        "lastSeenAt",
        "createdAt",
        "updatedAt",
        ("embedding" <=> ${queryLiteral}::vector) AS "distance"
      FROM "Listing"
      WHERE ${whereSql}
      ORDER BY "embedding" <=> ${queryLiteral}::vector ASC
      LIMIT ${limit}
    `);

    return rows.map(({ distance, ...listing }) => ({
      ...(listing as ListingRecord),
      distance: Number(distance),
    }));
  }

  /**
   * combinedScore-ordered page (M5 AC#7 — the listings table's default sort).
   * LEFT JOINs ListingScore so unscored listings appear (with NULL score,
   * ordered LAST), and keysets over (combinedScore, id). Raw SQL because Prisma
   * cannot orderBy a to-many relation field. Columns are `l.`-qualified
   * (id/createdAt/updatedAt collide across the join) and projected to match
   * `LISTING_SELECT` exactly, so the returned rows ARE `ListingRecord`s.
   */
  private async listByCombinedScore(
    filter: ListingFilter | undefined,
    cursor: string | undefined,
    dir: "asc" | "desc",
    limit: number,
  ): Promise<CursorPage<ListingRecord>> {
    const fragments = buildScoreFilterFragments(filter);
    if (cursor) {
      fragments.push(
        buildScoreCursorFragment(decodeCompositeCursor(cursor), dir),
      );
    }
    const whereSql =
      fragments.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(fragments, " AND ")}`
        : Prisma.empty;
    const orderBySql =
      dir === "asc"
        ? Prisma.sql`ORDER BY ls."combinedScore" ASC NULLS LAST, l."id" ASC`
        : Prisma.sql`ORDER BY ls."combinedScore" DESC NULLS LAST, l."id" DESC`;

    const rows = await prisma.$queryRaw<
      Array<
        Omit<ListingRecord, "id"> & {
          id: string;
          combinedScore: number | string | null;
        }
      >
    >(Prisma.sql`
      SELECT
        l."id"::text AS "id",
        l."addressNormalized",
        l."postcode",
        l."outcode",
        l."pricePence",
        l."bedrooms",
        l."tenure",
        l."propertyType",
        l."epcRating",
        l."listingStatus",
        l."isPreMarket",
        l."listingUrl",
        l."primarySource",
        l."firstSeenAt",
        l."lastSeenAt",
        l."createdAt",
        l."updatedAt",
        ls."combinedScore" AS "combinedScore"
      FROM "Listing" l
      LEFT JOIN "ListingScore" ls ON ls."listingId" = l."id"
      ${whereSql}
      ${orderBySql}
      LIMIT ${limit + 1}
    `);

    if (rows.length <= limit) {
      return {
        items: rows.map(({ combinedScore: _combinedScore, ...listing }) => listing as ListingRecord),
        nextCursor: null,
      };
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1]!;
    const items = page.map(
      ({ combinedScore: _combinedScore, ...listing }) => listing as ListingRecord,
    );
    const payload: CompositeCursorPayload =
      last.combinedScore === null
        ? { sortValue: 0, id: last.id, scoreIsNull: true }
        : { sortValue: Number(last.combinedScore), id: last.id };
    return { items, nextCursor: encodeCompositeCursor(payload) };
  }

  /**
   * Cosine distance (`<=>`, 0..2) between ONE listing's embedding and a query
   * vector — the per-listing score path (PreferenceMatchService.scoreListing)
   * uses this instead of a full `vectorTopK` recall so analysing a single
   * listing costs one bounded comparison, not a corpus scan. Returns null when
   * the listing has no embedding (so the caller can skip scoring it).
   */
  async vectorDistanceFor(
    listingId: string,
    embedding: number[],
  ): Promise<number | null> {
    const queryLiteral = toVectorLiteral(embedding);
    const rows = await prisma.$queryRaw<Array<{ distance: number | string | null }>>(
      Prisma.sql`
        SELECT ("embedding" <=> ${queryLiteral}::vector) AS "distance"
        FROM "Listing"
        WHERE "id" = ${listingId}::uuid AND "embedding" IS NOT NULL
      `,
    );
    const distance = rows[0]?.distance;
    return distance === null || distance === undefined ? null : Number(distance);
  }
}

const defaultListingRepository = new ListingRepository();

export let listingRepository = defaultListingRepository;

export function _setListingRepositoryForTesting(
  repository: ListingRepository | null,
): void {
  listingRepository = repository ?? defaultListingRepository;
}
