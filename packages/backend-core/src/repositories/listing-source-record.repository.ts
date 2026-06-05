/**
 * ListingSourceRecord repository — owns all Prisma access for the per-source
 * provenance rows attached to a Listing. The core operation is an IDEMPOTENT
 * upsert keyed on the composite unique `@@unique([sourceType, externalId])`:
 * re-ingesting the same (sourceType, externalId) UPDATES the existing row
 * (refreshing the listing link / payload / observedAt) rather than inserting a
 * duplicate. This backs the M2 test-plan idempotency assertion (row 3).
 */
import { Prisma, type ListingSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const SOURCE_RECORD_SELECT = Prisma.validator<Prisma.ListingSourceRecordSelect>()(
  {
    id: true,
    listingId: true,
    sourceType: true,
    externalId: true,
    sourceUrl: true,
    rawPayload: true,
    observedAt: true,
    createdAt: true,
    updatedAt: true,
  },
);

export type ListingSourceRecordRecord = Prisma.ListingSourceRecordGetPayload<{
  select: typeof SOURCE_RECORD_SELECT;
}>;

/** Idempotent upsert input keyed on the composite (sourceType, externalId). */
export interface UpsertSourceRecordInput {
  listingId: string;
  sourceType: ListingSource;
  externalId: string;
  sourceUrl?: string | null;
  rawPayload?: Prisma.InputJsonValue | null;
}

export class ListingSourceRecordRepository {
  /**
   * Idempotent upsert keyed on `@@unique([sourceType, externalId])`. The
   * second observation of the same (sourceType, externalId) UPDATES the row
   * (and refreshes `observedAt`) instead of creating a duplicate — proving the
   * composite unique makes re-ingest a no-op for row count.
   */
  async upsert(
    input: UpsertSourceRecordInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ListingSourceRecordRecord> {
    const db: PrismaLike = tx ?? prisma;
    const now = new Date();
    return db.listingSourceRecord.upsert({
      where: {
        sourceType_externalId: {
          sourceType: input.sourceType,
          externalId: input.externalId,
        },
      },
      create: {
        listingId: input.listingId,
        sourceType: input.sourceType,
        externalId: input.externalId,
        sourceUrl: input.sourceUrl ?? null,
        ...(input.rawPayload !== undefined && input.rawPayload !== null
          ? { rawPayload: input.rawPayload }
          : {}),
        observedAt: now,
      },
      update: {
        listingId: input.listingId,
        sourceUrl: input.sourceUrl ?? null,
        ...(input.rawPayload !== undefined && input.rawPayload !== null
          ? { rawPayload: input.rawPayload }
          : {}),
        observedAt: now,
      },
      select: SOURCE_RECORD_SELECT,
    });
  }

  async findByExternalId(
    sourceType: ListingSource,
    externalId: string,
  ): Promise<ListingSourceRecordRecord | null> {
    return prisma.listingSourceRecord.findUnique({
      where: { sourceType_externalId: { sourceType, externalId } },
      select: SOURCE_RECORD_SELECT,
    });
  }

  async listByListing(
    listingId: string,
  ): Promise<ListingSourceRecordRecord[]> {
    return prisma.listingSourceRecord.findMany({
      where: { listingId },
      orderBy: [{ observedAt: "desc" }, { id: "desc" }],
      select: SOURCE_RECORD_SELECT,
    });
  }

  /**
   * Count source records per sourceType — the per-source "Lots found" metric.
   * ONE groupBy (no N+1). Sources with no rows are simply absent; caller defaults to 0.
   */
  async countBySourceType(): Promise<Map<ListingSource, number>> {
    const groups = await prisma.listingSourceRecord.groupBy({
      by: ["sourceType"],
      _count: { _all: true },
    });
    const counts = new Map<ListingSource, number>();
    for (const g of groups) {
      counts.set(g.sourceType, g._count._all);
    }
    return counts;
  }

  /**
   * Latest observation per sourceType — the per-source "Latest lot" timestamp
   * (MAX(observedAt)). ONE groupBy. observedAt is NOT NULL; absent sources are not in the Map.
   */
  async latestObservedBySourceType(): Promise<Map<ListingSource, Date>> {
    const groups = await prisma.listingSourceRecord.groupBy({
      by: ["sourceType"],
      _max: { observedAt: true },
    });
    const latest = new Map<ListingSource, Date>();
    for (const g of groups) {
      if (g._max.observedAt !== null) {
        latest.set(g.sourceType, g._max.observedAt);
      }
    }
    return latest;
  }
}

const defaultListingSourceRecordRepository =
  new ListingSourceRecordRepository();

export let listingSourceRecordRepository =
  defaultListingSourceRecordRepository;

export function _setListingSourceRecordRepositoryForTesting(
  repository: ListingSourceRecordRepository | null,
): void {
  listingSourceRecordRepository =
    repository ?? defaultListingSourceRecordRepository;
}
