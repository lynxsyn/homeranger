/**
 * Integration test for the inbound listing path (M4 test plan, Integration row):
 * outreach:inbound end-to-end against docker pgvector with a FAKE extractor +
 * FAKE analyze enqueuer (no Redis / R2 / Anthropic). Asserts:
 *   - a Listing is upserted with isPreMarket=true + primarySource=agent_email;
 *   - a ListingSourceRecord (sourceType=agent_email, externalId=<email_id>) is
 *     written, with the SPF/DKIM verdicts in rawPayload;
 *   - the analyze:listing enqueue fires with the new listing id;
 *   - re-ingesting the SAME email is idempotent (one Listing, one source record,
 *     created=false the second time).
 *
 * Gate: skipped unless VITEST_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { DefaultInboundIngestionService } from "../services/inbound-ingestion.service.js";
import type {
  AnalyzeListingEnqueuer,
  ExtractedListing,
  InboundEmailPayload,
  ListingExtractionProvider,
} from "../services/inbound-ingestion.service.js";
import type { DedupResult, DedupService } from "../services/dedup.service.js";

const db = getTestPrisma();
const TEST_PREFIX = "m4-inbound";
const ADDRESS = `test-${TEST_PREFIX}-12 acacia avenue sw1a 1aa`;
const EMAIL_ID = `test-${TEST_PREFIX}-email-1`;

/** A fake extractor returning a fixed listing whose canonical key is ADDRESS. */
class FixedExtractor implements ListingExtractionProvider {
  async extract(): Promise<ExtractedListing> {
    return {
      // The dedup key the service builds from these is exactly ADDRESS (the
      // helper upper-cases; the test prefix is lower-case so we match its form).
      addressRaw: `test-${TEST_PREFIX}-12 acacia avenue`,
      postcode: "SW1A 1AA",
      outcode: "SW1A",
      pricePence: 45_000_000,
      bedrooms: 3,
      bathrooms: 2,
      tenure: "freehold",
      propertyType: "terraced",
      epcRating: "c",
      listingStatus: "pre_market",
      listingUrl: "https://listings.example.test/acacia",
      confidence: 0.9,
    };
  }
}

class SpyEnqueuer implements AnalyzeListingEnqueuer {
  readonly enqueued: string[] = [];
  async enqueueAnalyzeListing(listingId: string): Promise<void> {
    this.enqueued.push(listingId);
  }
}

function payload(): InboundEmailPayload {
  return {
    messageId: EMAIL_ID,
    receivedAt: new Date(),
    recipientEmail: "inbox@homescout.app",
    senderEmail: `test-${TEST_PREFIX}-agent@example.com`,
    senderName: null,
    subject: "Off-market terrace",
    bodyText: "Lovely terrace coming to market soon.",
    bodyHtml: null,
    spfVerdict: "pass",
    dkimVerdict: "pass",
    attachments: [],
  };
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "inbound-ingestion: outreach:inbound → Listing + ListingSourceRecord + analyze:listing",
  () => {
    const enqueuer = new SpyEnqueuer();
    const service = new DefaultInboundIngestionService({
      extractionProvider: new FixedExtractor(),
      analyzeListingEnqueuer: enqueuer,
    });

    beforeAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
    });

    afterAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await disconnectTestPrisma();
    });

    it("upserts a pre-market agent_email Listing + source record and enqueues analyze:listing", async () => {
      const result = await service.ingestInboundEmail(payload());

      // Listing upserted with the M4 pre-market + agent_email invariants.
      const listing = await db.listing.findUnique({
        where: { id: result.listingId },
      });
      expect(listing).not.toBeNull();
      expect(listing!.addressNormalized).toBe(ADDRESS.toUpperCase());
      expect(listing!.isPreMarket).toBe(true);
      expect(listing!.primarySource).toBe("agent_email");
      expect(listing!.listingStatus).toBe("pre_market");
      expect(listing!.pricePence).toBe(45_000_000);
      // M8 PR2: the sending agent is captured from the inbound email so the
      // listings table's Agent column + per-agency follow-ups have real data.
      expect(listing!.agentEmail).toBe(`test-${TEST_PREFIX}-agent@example.com`);
      expect(listing!.agencyName).toBeNull();

      // ListingSourceRecord written (sourceType=agent_email, externalId=email_id).
      const source = await db.listingSourceRecord.findUnique({
        where: {
          sourceType_externalId: {
            sourceType: "agent_email",
            externalId: EMAIL_ID,
          },
        },
      });
      expect(source).not.toBeNull();
      expect(source!.listingId).toBe(result.listingId);
      expect((source!.rawPayload as { spfVerdict?: string }).spfVerdict).toBe(
        "pass",
      );

      // analyze:listing enqueued with the new listing id.
      expect(enqueuer.enqueued).toContain(result.listingId);
      expect(result.created).toBe(true);
      expect(result.matchedBy).toBeNull();
    });

    it("is idempotent: re-ingesting the same email keeps ONE Listing + ONE source record", async () => {
      const second = await service.ingestInboundEmail(payload());

      const listingCount = await db.listing.count({
        where: { addressNormalized: ADDRESS.toUpperCase() },
      });
      const sourceCount = await db.listingSourceRecord.count({
        where: { sourceType: "agent_email", externalId: EMAIL_ID },
      });

      expect(listingCount).toBe(1);
      expect(sourceCount).toBe(1);
      // The exact-match dedup stage now finds the existing listing.
      expect(second.matchedBy).toBe("exact");
      expect(second.created).toBe(false);
    });

    // M4 review fix (HIGH): an embedding-fallback match MUST MERGE into the
    // existing row, not insert a duplicate keyed on the new candidate's address.
    // Inject a fake dedup that returns matchedBy:"embedding" pointing at the
    // listing the first test created, with a DIFFERENT addressNormalized (the
    // embedding fallback only fires when the exact key MISSED). Assert exactly
    // ONE listing exists, its id === the pre-existing id, and created === false.
    it("embedding match MERGES into the existing listing (no duplicate row)", async () => {
      // The id of the listing the first test created.
      const existing = await db.listing.findUnique({
        where: { addressNormalized: ADDRESS.toUpperCase() },
      });
      expect(existing).not.toBeNull();
      const existingId = existing!.id;
      const NEW_KEY = `TEST-${TEST_PREFIX.toUpperCase()}-EMBEDDING-NEAR-DUP`;

      const fakeDedup: DedupService = {
        async find(): Promise<DedupResult> {
          return {
            listingId: existingId,
            matchedBy: "embedding",
            addressNormalized: NEW_KEY,
          };
        },
        normaliseAddress() {
          return NEW_KEY;
        },
      };

      const mergeService = new DefaultInboundIngestionService({
        extractionProvider: new FixedExtractor(),
        analyzeListingEnqueuer: new SpyEnqueuer(),
        dedupService: fakeDedup,
      });

      const result = await mergeService.ingestInboundEmail({
        ...payload(),
        // A DIFFERENT messageId so the source-record upsert does not collide.
        messageId: `${EMAIL_ID}-near-dup`,
      });

      // Exactly ONE listing for the original address, none for the new key.
      const originalCount = await db.listing.count({
        where: { addressNormalized: ADDRESS.toUpperCase() },
      });
      const newKeyCount = await db.listing.count({
        where: { addressNormalized: NEW_KEY },
      });
      expect(originalCount).toBe(1);
      expect(newKeyCount).toBe(0);

      // The merge targeted the pre-existing row and reports honestly.
      expect(result.listingId).toBe(existingId);
      expect(result.created).toBe(false);
      expect(result.matchedBy).toBe("embedding");
    });
  },
);
