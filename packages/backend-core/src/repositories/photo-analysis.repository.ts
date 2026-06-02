/**
 * PhotoAnalysis repository — owns all Prisma access for per-photo vision
 * analysis (M5). Deduped by the unique `imageHash` so the same image is never
 * re-analysed/re-billed (AC#1); `costPence` is persisted per row and aggregated
 * by `sumCostPenceSince` to back the monthly-spend kill-switch (AC#5).
 *
 * Repository-layer rules (aide/rules/backend.md): the ONLY place that touches
 * `prisma.photoAnalysis`; every write accepts an optional `tx`.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const PHOTO_ANALYSIS_SELECT = Prisma.validator<Prisma.PhotoAnalysisSelect>()({
  id: true,
  listingId: true,
  imageHash: true,
  imageUrl: true,
  tasteScore: true,
  featuresJson: true,
  model: true,
  costPence: true,
  createdAt: true,
  updatedAt: true,
});

export type PhotoAnalysisRecord = Prisma.PhotoAnalysisGetPayload<{
  select: typeof PHOTO_ANALYSIS_SELECT;
}>;

export interface UpsertPhotoAnalysisInput {
  listingId: string;
  imageHash: string;
  imageUrl: string | null;
  tasteScore: number;
  /** A plain JSON object (the vision `features`); cast to Prisma JSON in-repo. */
  featuresJson: Record<string, unknown>;
  model: string;
  costPence: number;
}

export class PhotoAnalysisRepository {
  /** Dedup lookup: a hit means the image was already analysed (skip + no re-bill). */
  async findByImageHash(imageHash: string): Promise<PhotoAnalysisRecord | null> {
    return prisma.photoAnalysis.findUnique({
      where: { imageHash },
      select: PHOTO_ANALYSIS_SELECT,
    });
  }

  /**
   * Idempotent upsert keyed on the unique `imageHash`. A re-analysis of the same
   * image (e.g. a manual re-run) refreshes the score/features rather than
   * throwing on the unique constraint.
   */
  async upsertByImageHash(
    input: UpsertPhotoAnalysisInput,
    tx?: Prisma.TransactionClient,
  ): Promise<PhotoAnalysisRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.photoAnalysis.upsert({
      where: { imageHash: input.imageHash },
      create: {
        listingId: input.listingId,
        imageHash: input.imageHash,
        imageUrl: input.imageUrl,
        tasteScore: input.tasteScore,
        featuresJson: input.featuresJson as Prisma.InputJsonValue,
        model: input.model,
        costPence: input.costPence,
      },
      update: {
        tasteScore: input.tasteScore,
        featuresJson: input.featuresJson as Prisma.InputJsonValue,
        model: input.model,
        costPence: input.costPence,
      },
      select: PHOTO_ANALYSIS_SELECT,
    });
  }

  async listByListingId(listingId: string): Promise<PhotoAnalysisRecord[]> {
    return prisma.photoAnalysis.findMany({
      where: { listingId },
      orderBy: [{ tasteScore: "desc" }, { id: "asc" }],
      select: PHOTO_ANALYSIS_SELECT,
    });
  }

  /**
   * Sum of `costPence` across all photo analyses since `since` — the monthly
   * spend the kill-switch compares against its budget. Returns 0 when no rows.
   */
  async sumCostPenceSince(since: Date): Promise<number> {
    const result = await prisma.photoAnalysis.aggregate({
      _sum: { costPence: true },
      where: { createdAt: { gte: since } },
    });
    return result._sum.costPence ?? 0;
  }
}

const defaultPhotoAnalysisRepository = new PhotoAnalysisRepository();

export let photoAnalysisRepository = defaultPhotoAnalysisRepository;

export function _setPhotoAnalysisRepositoryForTesting(
  repository: PhotoAnalysisRepository | null,
): void {
  photoAnalysisRepository = repository ?? defaultPhotoAnalysisRepository;
}
