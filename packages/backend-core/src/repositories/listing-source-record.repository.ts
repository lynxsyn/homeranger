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
    _input: UpsertSourceRecordInput,
    _tx?: Prisma.TransactionClient,
  ): Promise<ListingSourceRecordRecord> {
    throw new Error("not implemented");
  }

  async findByExternalId(
    _sourceType: ListingSource,
    _externalId: string,
  ): Promise<ListingSourceRecordRecord | null> {
    throw new Error("not implemented");
  }

  async listByListing(
    _listingId: string,
  ): Promise<ListingSourceRecordRecord[]> {
    throw new Error("not implemented");
  }
}

void SOURCE_RECORD_SELECT;

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
