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
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
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

export interface ListListingsInput {
  filter?: ListingFilter;
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

function buildCursorFilter(cursor: { id: string }): Prisma.ListingWhereInput {
  // Keyset on the uuid(7) primary key (DESC) — time-sortable, unique, exact, so
  // it equals firstSeen/creation order with no timestamp-precision risk.
  return { id: { lt: cursor.id } };
}

export class ListingRepository {
  /**
   * Cursor-paginated list with an optional structured filter. Stable keyset
   * ordering on the uuid(7) id (DESC = newest first); over-fetches `limit + 1`
   * to compute `nextCursor`. Returns `{ items, nextCursor }`, default 20 / max
   * 100. (M3 adds user-selectable sorts by price/lastSeenAt/combinedScore.)
   */
  async list(input: ListListingsInput = {}): Promise<CursorPage<ListingRecord>> {
    const limit = clampLimit(input.limit);
    const where = buildWhere(input.filter);
    const cursorFilter = input.cursor
      ? buildCursorFilter(decodeCursor(input.cursor))
      : {};
    // Over-fetch one row so we can detect whether more pages exist.
    const rows = await prisma.listing.findMany({
      where: { ...where, ...cursorFilter },
      orderBy: [{ id: "desc" }],
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
      nextCursor: encodeCursor({ id: last.id }),
    };
  }

  async getById(id: string): Promise<ListingRecord | null> {
    return prisma.listing.findUnique({
      where: { id },
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
}

const defaultListingRepository = new ListingRepository();

export let listingRepository = defaultListingRepository;

export function _setListingRepositoryForTesting(
  repository: ListingRepository | null,
): void {
  listingRepository = repository ?? defaultListingRepository;
}
