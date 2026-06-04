/**
 * Search repository — owns ALL Prisma access for the Search aggregate (M8). A
 * search is a saved buyer brief that drives outreach. Mirrors
 * listing.repository.ts: explicit `*_SELECT`, the optional-tx pattern
 * (`const db = tx ?? prisma`), and an exported singleton + test setter.
 *
 * Multi-user owner scoping: EVERY method takes an `ownerId` and confines the
 * query to that owner's namespace (`userId IS NULL` for the operator, `userId =
 * ownerId` otherwise). Ownership is enforced HERE, not just in the router — a
 * read for another owner returns null/[], and a write for another owner throws
 * Prisma P2025 (which the router remaps to NOT_FOUND) so cross-user access is
 * indistinguishable from a missing row.
 *
 * The search FORM has no outcodes field — `outcodes` are resolved SERVER-SIDE
 * from the free-text `location` (resolveSearchOutcodes) on every create + update,
 * so a brief's targeting always tracks its location. `minBedrooms` /
 * `maxPricePence` / `status` persist as given.
 */
import { Prisma, type SearchStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { resolveSearchOutcodes } from "../lib/searches/search-brief.js";
// Shared pgvector (de)serialisers — the canonical pair lives in listing.repository
// so the parse + dimension/finite guards are defined ONCE across every repo that
// reads/writes an Unsupported("vector(1024)") column.
import { fromVectorLiteral, toVectorLiteral } from "./listing.repository.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

/**
 * The Prisma "record not found" error the router's `searchNotFound` remaps to a
 * tRPC NOT_FOUND. A scoped write that matches no row (wrong/foreign id) throws
 * this so the contract is identical to the pre-multi-user `update`/`delete`.
 */
function recordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Search not found for this owner",
    { code: "P2025", clientVersion: Prisma.prismaVersion.client },
  );
}

const SEARCH_SELECT = Prisma.validator<Prisma.SearchSelect>()({
  id: true,
  name: true,
  location: true,
  outcodes: true,
  types: true,
  condition: true,
  land: true,
  saleMethods: true,
  minBedrooms: true,
  maxPricePence: true,
  keywords: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

export type SearchRecord = Prisma.SearchGetPayload<{
  select: typeof SEARCH_SELECT;
}>;

/**
 * Create input — the wire fields minus `outcodes` (resolved here from
 * `location`). `minBedrooms` / `maxPricePence` are nullable; the rest default
 * at the wire boundary, so they always arrive concrete.
 */
export interface CreateSearchInput {
  name: string;
  location: string;
  types: string[];
  condition: string[];
  land: string[];
  saleMethods: string[];
  minBedrooms: number | null;
  maxPricePence: number | null;
  keywords: string;
  status: SearchStatus;
}

/** Update input — a FULL replace of an existing search by id. */
export interface UpdateSearchInput extends CreateSearchInput {
  id: string;
}

export class SearchRepository {
  /** All of `ownerId`'s searches, most-recently-updated first. */
  async list(ownerId: string | null): Promise<SearchRecord[]> {
    return prisma.search.findMany({
      where: { userId: ownerId },
      orderBy: [{ updatedAt: "desc" }],
      select: SEARCH_SELECT,
    });
  }

  /** A single search, scoped to `ownerId` (null if absent or another owner's). */
  async getById(id: string, ownerId: string | null): Promise<SearchRecord | null> {
    return prisma.search.findFirst({
      where: { id, userId: ownerId },
      select: SEARCH_SELECT,
    });
  }

  /**
   * Create a search for `ownerId`. `outcodes` are derived from `location` here
   * (never supplied by the caller) so a brief's targeting always tracks its
   * location text.
   */
  async create(
    input: CreateSearchInput,
    ownerId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<SearchRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.search.create({
      data: {
        userId: ownerId,
        name: input.name,
        location: input.location,
        outcodes: resolveSearchOutcodes(input.location),
        types: input.types,
        condition: input.condition,
        land: input.land,
        saleMethods: input.saleMethods,
        minBedrooms: input.minBedrooms,
        maxPricePence: input.maxPricePence,
        keywords: input.keywords,
        status: input.status,
      },
      select: SEARCH_SELECT,
    });
  }

  /**
   * Full-replace update, scoped to `ownerId`. Re-resolves `outcodes` from the
   * (possibly changed) `location`. A scoped updateMany that matches no row
   * (missing id or a foreign owner) throws P2025 — the router maps it to
   * NOT_FOUND, so a cross-owner write is indistinguishable from a missing row.
   */
  async update(
    input: UpdateSearchInput,
    ownerId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<SearchRecord> {
    const db: PrismaLike = tx ?? prisma;
    const result = await db.search.updateMany({
      where: { id: input.id, userId: ownerId },
      data: {
        name: input.name,
        location: input.location,
        outcodes: resolveSearchOutcodes(input.location),
        types: input.types,
        condition: input.condition,
        land: input.land,
        saleMethods: input.saleMethods,
        minBedrooms: input.minBedrooms,
        maxPricePence: input.maxPricePence,
        keywords: input.keywords,
        status: input.status,
      },
    });
    if (result.count === 0) {
      throw recordNotFound();
    }
    // The row is the caller's and was just updated — re-read it for the select.
    return db.search.findUniqueOrThrow({
      where: { id: input.id },
      select: SEARCH_SELECT,
    });
  }

  /** Delete by id, scoped to `ownerId`. Echoes `{ id }`; P2025 on a miss. */
  async delete(
    id: string,
    ownerId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string }> {
    const db: PrismaLike = tx ?? prisma;
    const result = await db.search.deleteMany({ where: { id, userId: ownerId } });
    if (result.count === 0) {
      throw recordNotFound();
    }
    return { id };
  }

  /**
   * Toggle a search's lifecycle status (active ⇄ paused), scoped to `ownerId`.
   * P2025 for an unknown/foreign id (router → NOT_FOUND).
   */
  async setStatus(
    id: string,
    status: SearchStatus,
    ownerId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<SearchRecord> {
    const db: PrismaLike = tx ?? prisma;
    const result = await db.search.updateMany({
      where: { id, userId: ownerId },
      data: { status },
    });
    if (result.count === 0) {
      throw recordNotFound();
    }
    return db.search.findUniqueOrThrow({ where: { id }, select: SEARCH_SELECT });
  }

  /**
   * Active searches (for `ownerId`) whose `outcodes` contain `outcode` — the
   * candidate searches a listing in that outcode is scored against. Ordered by
   * `updatedAt` DESC so the per-listing cap (MATCH_MAX_SEARCHES_PER_LISTING)
   * deterministically keeps the most-recently-edited searches. `limit` bounds the
   * fan-out (paid LLM re-score per search). Paused searches never match (they
   * stop new outreach + scoring).
   */
  async listActiveByOutcode(
    outcode: string,
    ownerId: string | null = null,
    limit?: number,
  ): Promise<SearchRecord[]> {
    return prisma.search.findMany({
      where: { status: "active", userId: ownerId, outcodes: { has: outcode } },
      orderBy: [{ updatedAt: "desc" }],
      ...(limit !== undefined ? { take: limit } : {}),
      select: SEARCH_SELECT,
    });
  }

  /** All active searches for `ownerId` — the full re-rank set (recomputeAll). */
  async listActive(ownerId: string | null = null): Promise<SearchRecord[]> {
    return prisma.search.findMany({
      where: { status: "active", userId: ownerId },
      orderBy: [{ updatedAt: "desc" }],
      select: SEARCH_SELECT,
    });
  }

  /**
   * Write a search's keyword taste embedding (raw — `keywordsEmbedding` is
   * Unsupported). Bound as a single `::vector` parameter; the id is bound + cast
   * `::uuid`. Deliberately does NOT touch `updatedAt`: a scoring recompute must
   * not reorder the user's search list (which sorts by `updatedAt` DESC) nor
   * perturb the per-listing cap ordering. Returns rows updated (0 if id absent).
   */
  async writeKeywordsEmbedding(
    searchId: string,
    embedding: number[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db: PrismaLike = tx ?? prisma;
    const literal = toVectorLiteral(embedding);
    return db.$executeRaw`
      UPDATE "Search"
      SET "keywordsEmbedding" = ${literal}::vector
      WHERE "id" = ${searchId}::uuid
    `;
  }

  /**
   * Read a search's keyword embedding back as a JS number[] (or null if unset).
   * Casts the Unsupported vector column to text in SQL and parses here so the raw
   * vector type never leaks across the repo boundary.
   */
  async readKeywordsEmbedding(
    searchId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number[] | null> {
    const db: PrismaLike = tx ?? prisma;
    const rows = await db.$queryRaw<Array<{ embedding: string | null }>>`
      SELECT "keywordsEmbedding"::text AS "embedding"
      FROM "Search"
      WHERE "id" = ${searchId}::uuid
    `;
    const raw = rows[0]?.embedding;
    if (!raw) {
      return null;
    }
    return fromVectorLiteral(raw);
  }
}

const defaultSearchRepository = new SearchRepository();

export let searchRepository = defaultSearchRepository;

export function _setSearchRepositoryForTesting(
  repository: SearchRepository | null,
): void {
  searchRepository = repository ?? defaultSearchRepository;
}
