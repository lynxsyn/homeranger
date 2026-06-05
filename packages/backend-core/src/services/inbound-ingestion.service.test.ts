/**
 * Unit tests for DefaultInboundIngestionService (M4 review fix — HIGH:
 * embedding-fallback dedup MUST MERGE, not duplicate). These are pure unit tests
 * (no DB): a fake DedupService + a spy ListingRepository + fake extractor /
 * enqueuer. They close the false-coverage gap the isolated DedupService test
 * left — proving the SERVICE merges into the embedding-matched row rather than
 * inserting a duplicate, and that `created` is honest on every dedup path.
 */
import { describe, expect, it, vi } from "vitest";
import { DefaultInboundIngestionService } from "./inbound-ingestion.service.js";
import type {
  AnalyzeListingEnqueuer,
  ExtractedListing,
  InboundEmailPayload,
  ListingExtractionProvider,
} from "./inbound-ingestion.service.js";
import type { DedupResult, DedupService } from "./dedup.service.js";
import type {
  ListingRecord,
  ListingRepository,
} from "../repositories/listing.repository.js";
import type { ConsumeTokenResult } from "../lib/rate-limit/redis-token-bucket.js";

// runTransaction wraps the body in a Prisma $transaction; for a unit test we run
// the body directly with a sentinel tx so the service composes update/upsert +
// source-record exactly as in production, without a live DB.
vi.mock("../lib/prisma.js", () => ({
  prisma: {},
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ __tx: true }),
}));

const PREEXISTING_ID = "00000000-0000-7000-8000-0000000000ff";
const NEW_CANDIDATE_KEY = "DIFFERENT WORDING SAME PLACE";

// The real consumeToken needs Redis; inject a fake so unit tests never touch it.
const passingBudget = async (): Promise<ConsumeTokenResult> => ({
  allowed: true,
  available: true,
  remaining: 999,
  retryAfterSeconds: 0,
});

function makeListing(overrides: Partial<ListingRecord> = {}): ListingRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: PREEXISTING_ID,
    addressNormalized: "12 ACACIA AVENUE SW1A 1AA",
    postcode: "SW1A 1AA",
    outcode: "SW1A",
    pricePence: 45_000_000,
    bedrooms: 3,
    tenure: null,
    propertyType: null,
    epcRating: null,
    listingStatus: "pre_market",
    isPreMarket: true,
    listingUrl: null,
    imageUrl: null,
    primarySource: "agent_email",
    bathrooms: 2,
    agentEmail: null,
    agencyName: null,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FixedExtractor implements ListingExtractionProvider {
  async extract(): Promise<ExtractedListing> {
    return {
      addressRaw: "Different wording, same place",
      postcode: null,
      outcode: null,
      pricePence: 50_000_000,
      bedrooms: 4,
      bathrooms: 2,
      tenure: "freehold",
      propertyType: "detached",
      epcRating: "b",
      listingStatus: "pre_market",
      listingUrl: "https://listings.example.test/x",
      confidence: 0.9,
    };
  }
}

class NoopEnqueuer implements AnalyzeListingEnqueuer {
  async enqueueAnalyzeListing(): Promise<void> {}
}

function fakeDedup(result: DedupResult): DedupService {
  return {
    async find(): Promise<DedupResult> {
      return result;
    },
    normaliseAddress(): string | null {
      return result.addressNormalized;
    },
  };
}

function payload(): InboundEmailPayload {
  return {
    messageId: "email-merge-1",
    receivedAt: new Date(),
    recipientEmail: "inbox@homeranger.app",
    senderEmail: "agent@example.com",
    senderName: null,
    subject: "Off-market",
    bodyText: "body",
    bodyHtml: null,
    spfVerdict: "pass",
    dkimVerdict: "pass",
    attachments: [],
  };
}

describe("DefaultInboundIngestionService — dedup merge", () => {
  it("MERGES into the embedding-matched listing (updateById, NO duplicate)", async () => {
    const existing = makeListing();
    const updateByIdArgs: string[] = [];
    const sourceUpsertListingIds: string[] = [];
    let upsertCalled = false;
    const updateById = vi.fn(async (id: string) => {
      updateByIdArgs.push(id);
      return existing;
    });
    const upsertByAddress = vi.fn(async () => {
      upsertCalled = true;
      return makeListing({ id: "should-not-happen" });
    });
    const sourceUpsert = vi.fn(async (input: { listingId: string }) => {
      sourceUpsertListingIds.push(input.listingId);
      return { id: "src-1" };
    });

    const service = new DefaultInboundIngestionService({
      extractionProvider: new FixedExtractor(),
      consumeToken: passingBudget,
      analyzeListingEnqueuer: new NoopEnqueuer(),
      dedupService: fakeDedup({
        listingId: PREEXISTING_ID,
        matchedBy: "embedding",
        // The embedding fallback's key differs from the existing row's key.
        addressNormalized: NEW_CANDIDATE_KEY,
      }),
      listingRepository: {
        updateById,
        upsertByAddress,
      } as unknown as ListingRepository,
      listingSourceRecordRepository: {
        upsert: sourceUpsert,
      } as unknown as import("../repositories/listing-source-record.repository.js").ListingSourceRecordRepository,
    });

    const result = await service.ingestInboundEmail(payload());

    // Exactly ONE listing — the pre-existing one — was written via updateById,
    // and upsertByAddress (the create path) was NEVER called.
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(updateByIdArgs[0]).toBe(PREEXISTING_ID);
    expect(upsertCalled).toBe(false);
    expect(upsertByAddress).not.toHaveBeenCalled();

    // The result is honest: it points at the pre-existing id and created=false.
    expect(result.listingId).toBe(PREEXISTING_ID);
    expect(result.created).toBe(false);
    expect(result.matchedBy).toBe("embedding");

    // One source record written, pointing at the pre-existing listing.
    expect(sourceUpsert).toHaveBeenCalledTimes(1);
    expect(sourceUpsertListingIds[0]).toBe(PREEXISTING_ID);
  });

  it("MERGES into an exact match via updateById (created=false)", async () => {
    const existing = makeListing();
    const updateById = vi.fn(async () => existing);
    const upsertByAddress = vi.fn(async () => existing);

    const service = new DefaultInboundIngestionService({
      extractionProvider: new FixedExtractor(),
      consumeToken: passingBudget,
      analyzeListingEnqueuer: new NoopEnqueuer(),
      dedupService: fakeDedup({
        listingId: PREEXISTING_ID,
        matchedBy: "exact",
        addressNormalized: existing.addressNormalized,
      }),
      listingRepository: {
        updateById,
        upsertByAddress,
      } as unknown as ListingRepository,
      listingSourceRecordRepository: {
        upsert: async () => ({ id: "src-2" }),
      } as unknown as import("../repositories/listing-source-record.repository.js").ListingSourceRecordRepository,
    });

    const result = await service.ingestInboundEmail(payload());

    expect(updateById).toHaveBeenCalledTimes(1);
    expect(upsertByAddress).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(result.matchedBy).toBe("exact");
  });

  it("CREATES via upsertByAddress when dedup found no match (created=true)", async () => {
    const fresh = makeListing({ id: "fresh-id", addressNormalized: NEW_CANDIDATE_KEY });
    const upsertKeys: string[] = [];
    const updateById = vi.fn(async () => fresh);
    const upsertByAddress = vi.fn(
      async (input: { addressNormalized: string }) => {
        upsertKeys.push(input.addressNormalized);
        return fresh;
      },
    );

    const service = new DefaultInboundIngestionService({
      extractionProvider: new FixedExtractor(),
      consumeToken: passingBudget,
      analyzeListingEnqueuer: new NoopEnqueuer(),
      dedupService: fakeDedup({
        listingId: null,
        matchedBy: null,
        addressNormalized: NEW_CANDIDATE_KEY,
      }),
      listingRepository: {
        updateById,
        upsertByAddress,
      } as unknown as ListingRepository,
      listingSourceRecordRepository: {
        upsert: async () => ({ id: "src-3" }),
      } as unknown as import("../repositories/listing-source-record.repository.js").ListingSourceRecordRepository,
    });

    const result = await service.ingestInboundEmail(payload());

    expect(upsertByAddress).toHaveBeenCalledTimes(1);
    expect(updateById).not.toHaveBeenCalled();
    expect(upsertKeys[0]).toBe(
      NEW_CANDIDATE_KEY,
    );
    expect(result.created).toBe(true);
    expect(result.listingId).toBe("fresh-id");
  });
});

describe("DefaultInboundIngestionService — extraction budget guardrails", () => {
  const budgetService = (consumeToken: () => Promise<ConsumeTokenResult>) =>
    new DefaultInboundIngestionService({
      extractionProvider: new FixedExtractor(),
      analyzeListingEnqueuer: new NoopEnqueuer(),
      consumeToken,
    });

  it("DROPS (non-retryable) when the daily extraction cap is exceeded", async () => {
    const service = budgetService(async () => ({
      allowed: false,
      available: true,
      remaining: 0,
      retryAfterSeconds: 3600,
    }));
    await expect(service.ingestInboundEmail(payload())).rejects.toMatchObject({
      name: "InboundIngestionError",
      retryable: false,
    });
  });

  it("RETRIES (retryable) when the budget bucket is unavailable (Redis down)", async () => {
    const service = budgetService(async () => ({
      allowed: false,
      available: false,
      remaining: 0,
      retryAfterSeconds: 0,
    }));
    await expect(service.ingestInboundEmail(payload())).rejects.toMatchObject({
      name: "InboundIngestionError",
      retryable: true,
    });
  });
});
