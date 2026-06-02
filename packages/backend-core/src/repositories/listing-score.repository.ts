/**
 * ListingScore repository — owns all Prisma access for a Listing's combined
 * relevance score against the SearchProfile (M5). Keyed on the unique
 * `listingId` (one score per listing) so recomputes upsert in place. The
 * `combinedScore` column (DESC-indexed) is what the listings table sorts by.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const LISTING_SCORE_SELECT = Prisma.validator<Prisma.ListingScoreSelect>()({
  id: true,
  listingId: true,
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
  vectorScore: number;
  llmScore: number | null;
  combinedScore: number;
  rationale: string | null;
}

export class ListingScoreRepository {
  /** Idempotent upsert keyed on the unique `listingId` (one score per listing). */
  async upsertByListingId(
    input: UpsertListingScoreInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ListingScoreRecord> {
    const db: PrismaLike = tx ?? prisma;
    const now = new Date();
    return db.listingScore.upsert({
      where: { listingId: input.listingId },
      create: {
        listingId: input.listingId,
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

  async getByListingId(listingId: string): Promise<ListingScoreRecord | null> {
    return prisma.listingScore.findUnique({
      where: { listingId },
      select: LISTING_SCORE_SELECT,
    });
  }
}

const defaultListingScoreRepository = new ListingScoreRepository();

export let listingScoreRepository = defaultListingScoreRepository;

export function _setListingScoreRepositoryForTesting(
  repository: ListingScoreRepository | null,
): void {
  listingScoreRepository = repository ?? defaultListingScoreRepository;
}
