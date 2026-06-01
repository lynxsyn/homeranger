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
  paginate,
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

function buildCursorFilter(cursor: {
  id: string;
  createdAt: Date;
}): Prisma.ListingWhereInput {
  // Keyset pagination on (firstSeenAt DESC, id DESC). The cursor's createdAt
  // slot carries firstSeenAt (see `list`), so compare against firstSeenAt.
  return {
    OR: [
      { firstSeenAt: { lt: cursor.createdAt } },
      { firstSeenAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

export class ListingRepository {
  /**
   * Cursor-paginated list with an optional structured filter. Stable keyset
   * ordering on (firstSeenAt DESC, id DESC); over-fetches `limit + 1` so
   * `paginate()` can compute `nextCursor`. Returns `{ items, nextCursor }`,
   * default 20 / max 100.
   */
  async list(_input: ListListingsInput = {}): Promise<CursorPage<ListingRecord>> {
    throw new Error("not implemented");
  }

  async getById(_id: string): Promise<ListingRecord | null> {
    throw new Error("not implemented");
  }

  /**
   * Idempotent upsert keyed on the unique `addressNormalized` dedup column.
   * Re-ingesting the same address UPDATES (refreshes mutable fields +
   * `lastSeenAt`) rather than inserting a duplicate. `firstSeenAt` is only set
   * on create. The embedding is written separately via `writeEmbedding`.
   */
  async upsertByAddress(
    _input: UpsertListingByAddressInput,
    _tx?: Prisma.TransactionClient,
  ): Promise<ListingRecord> {
    throw new Error("not implemented");
  }

  /**
   * Write (or clear) a listing's embedding. The `embedding` column is
   * `Unsupported("vector(1024)")`, so the typed client cannot set it — we use
   * raw `$executeRaw`. The vector is bound as a single text parameter and cast
   * `::vector`; the id is bound and cast `::uuid`. Returns the number of rows
   * updated (0 if the id does not exist).
   */
  async writeEmbedding(
    _listingId: string,
    _embedding: number[],
    _tx?: Prisma.TransactionClient,
  ): Promise<number> {
    throw new Error("not implemented");
  }

  /**
   * Raw cosine-similarity top-K. Orders by `"embedding" <=> $query` ascending
   * (smaller cosine distance = more similar = nearer first), applies the
   * optional structured pre-filter BEFORE ranking, and returns the projected
   * listing columns plus the distance. The HNSW `vector_cosine_ops` index
   * (created in the raw migration) backs the `<=>` operator.
   */
  async vectorTopK(
    _embedding: number[],
    _k: number,
    _prefilter?: ListingFilter,
  ): Promise<VectorTopKResult[]> {
    throw new Error("not implemented");
  }
}

// Helpers retained for the GREEN implementation; referenced to satisfy lint
// in the RED phase where the method bodies are stubbed.
void buildWhere;
void buildRawFilterFragments;
void buildCursorFilter;
void clampLimit;
void decodeCursor;
void paginate;

const defaultListingRepository = new ListingRepository();

export let listingRepository = defaultListingRepository;

export function _setListingRepositoryForTesting(
  repository: ListingRepository | null,
): void {
  listingRepository = repository ?? defaultListingRepository;
}
