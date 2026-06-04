/**
 * ListingScore repository — owns all Prisma access for a Listing's combined
 * relevance score against ONE Search's taste (per-search match scoring). Keyed
 * on the composite unique `(listingId, searchId)` so a listing carries one score
 * PER search and recomputes upsert in place.
 *
 * Read paths:
 *   - getCombinedScoresByListingIds(ids)            → MAX(combinedScore) per
 *     listing across the operator's searches (the UNFILTERED listings table's
 *     "best match to any of my searches" Match ring).
 *   - getCombinedScoresByListingIdsForSearch(ids, s) → that search's score per
 *     listing (the search link-through's Match ring).
 *   - getBestByListingId(id)                        → the single highest-scored
 *     row for a listing (the dormant row-expand panel's rationale).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const LISTING_SCORE_SELECT = Prisma.validator<Prisma.ListingScoreSelect>()({
  id: true,
  listingId: true,
  searchId: true,
  vectorScore: true,
  llmScore: true,
  combinedScore: true,
  rationale: true,
  scoredAt: true,
  createdAt: true,
  updatedAt: true,
});

export type ListingScoreRecord = Prisma.ListingScoreGetPayload<{
  select: typeof LISTING_SCORE_SELECT;
}>;

export interface UpsertListingScoreInput {
  listingId: string;
  searchId: string;
  vectorScore: number;
  llmScore: number | null;
  combinedScore: number;
  rationale: string | null;
}

export class ListingScoreRepository {
  /** Idempotent upsert keyed on the composite unique `(listingId, searchId)`. */
  async upsertByListingAndSearch(
    input: UpsertListingScoreInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ListingScoreRecord> {
    const db: PrismaLike = tx ?? prisma;
    const now = new Date();
    return db.listingScore.upsert({
      where: {
        listingId_searchId: {
          listingId: input.listingId,
          searchId: input.searchId,
        },
      },
      create: {
        listingId: input.listingId,
        searchId: input.searchId,
        vectorScore: input.vectorScore,
        llmScore: input.llmScore,
        combinedScore: input.combinedScore,
        rationale: input.rationale,
        scoredAt: now,
      },
      update: {
        vectorScore: input.vectorScore,
        llmScore: input.llmScore,
        combinedScore: input.combinedScore,
        rationale: input.rationale,
        scoredAt: now,
      },
      select: LISTING_SCORE_SELECT,
    });
  }

  /**
   * The single best-scored row for a listing (highest combinedScore across the
   * searches it was scored against) — backs the row-expand rationale. Null when
   * the listing has not been scored against any search yet.
   */
  async getBestByListingId(
    listingId: string,
  ): Promise<ListingScoreRecord | null> {
    return prisma.listingScore.findFirst({
      where: { listingId },
      orderBy: { combinedScore: "desc" },
      select: LISTING_SCORE_SELECT,
    });
  }

  /**
   * Batch MAX-combinedScore-per-listing for a page of listings — the UNFILTERED
   * listings table's Match ring ("best match to any of my searches"). One
   * `groupBy` (no N+1) over the page; returns a Map keyed by listingId with only
   * listings that have at least one score (unscored listings are absent, and the
   * caller defaults them to `null`). A listing with scores against several
   * searches collapses to its single best — NOT overwritten (the old findMany +
   * Map.set silently lost all-but-one search; groupBy `_max` is the fix).
   */
  async getCombinedScoresByListingIds(
    listingIds: string[],
  ): Promise<Map<string, number>> {
    if (listingIds.length === 0) {
      return new Map();
    }
    const groups = await prisma.listingScore.groupBy({
      by: ["listingId"],
      where: { listingId: { in: listingIds } },
      _max: { combinedScore: true },
    });
    const scores = new Map<string, number>();
    for (const group of groups) {
      if (group._max.combinedScore !== null) {
        scores.set(group.listingId, group._max.combinedScore);
      }
    }
    return scores;
  }

  /**
   * Batch combinedScore-per-listing for ONE search — the search link-through's
   * Match ring. The composite unique `(listingId, searchId)` guarantees at most
   * one row per (listing, search), so no MAX is needed. Listings unscored against
   * this search are absent (caller defaults to `null`).
   */
  async getCombinedScoresByListingIdsForSearch(
    listingIds: string[],
    searchId: string,
  ): Promise<Map<string, number>> {
    if (listingIds.length === 0) {
      return new Map();
    }
    const rows = await prisma.listingScore.findMany({
      where: { listingId: { in: listingIds }, searchId },
      select: { listingId: true, combinedScore: true },
    });
    return new Map(rows.map((row) => [row.listingId, row.combinedScore]));
  }
}

const defaultListingScoreRepository = new ListingScoreRepository();

export let listingScoreRepository = defaultListingScoreRepository;

export function _setListingScoreRepositoryForTesting(
  repository: ListingScoreRepository | null,
): void {
  listingScoreRepository = repository ?? defaultListingScoreRepository;
}
