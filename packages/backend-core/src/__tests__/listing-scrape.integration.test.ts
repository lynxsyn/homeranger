/**
 * Integration test (listing-site ingestion): ListingScrapeService.runScrape end-
 * to-end against docker pgvector with the REAL listing + source-record + dedup
 * repositories and a deterministic injected provider (no Firecrawl / Redis /
 * Anthropic). Mirrors inbound-ingestion.integration.test.ts. Asserts:
 *   - a Listing is upserted with isPreMarket=false + listingStatus=live +
 *     primarySource=<site>;
 *   - a ListingSourceRecord (sourceType=<site>, externalId=<ref>) is written;
 *   - the analyze:listing enqueue fires with the new listing id;
 *   - re-running the SAME scrape is idempotent (one Listing, one source record).
 *
 * The provider returns `test-`-prefixed natural keys so cleanupTestData matches
 * them (the FakeListingScrapeProvider derives address/externalId from the site +
 * outcode and is exercised by the unit test instead).
 *
 * Gate: skipped unless VITEST_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { DefaultListingScrapeService } from "../services/listing-scrape.service.js";
import type {
  ListingScrapeProvider,
  ScrapeListingsInput,
  ScrapedListing,
} from "../lib/listing-scrape/listing-scrape.provider.js";

const db = getTestPrisma();
const TEST_PREFIX = "lsi";
const ADDRESS_RAW = `test-${TEST_PREFIX} 14 willow road`;
const POSTCODE = "SW1A 1AA";
const EXTERNAL_ID = `test-${TEST_PREFIX}-uklf-ref-1`;
const SOURCE_URL = "https://uklandandfarms.example/listing/test-lsi-1";
// The canonical dedup key the service builds from ADDRESS_RAW + POSTCODE (the
// helper upper-cases + appends the normalised postcode).
const EXPECTED_KEY = "TEST-LSI 14 WILLOW ROAD SW1A 1AA";

/** A fixed provider returning ONE deterministic `test-`-prefixed scraped listing. */
class FixedScrapeProvider implements ListingScrapeProvider {
  async scrape(_input: ScrapeListingsInput): Promise<ScrapedListing[]> {
    return [
      {
        externalId: EXTERNAL_ID,
        sourceUrl: SOURCE_URL,
        addressRaw: ADDRESS_RAW,
        postcode: POSTCODE,
        pricePence: 72_500_000,
      },
    ];
  }
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "listing-scrape: runScrape → Listing + ListingSourceRecord + analyze:listing",
  () => {
    const enqueued: string[] = [];
    const service = new DefaultListingScrapeService({
      provider: new FixedScrapeProvider(),
      enqueueAnalyze: async (id) => {
        enqueued.push(id);
      },
    });

    beforeAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
    });

    afterAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await disconnectTestPrisma();
    });

    it("upserts a live, link-out Listing + source record and enqueues analyze:listing", async () => {
      const result = await service.runScrape({
        site: "uklandandfarms",
        outcodes: ["SW1A"],
      });
      expect(result).toEqual({
        site: "uklandandfarms",
        scraped: 1,
        upserted: 1,
        skipped: 0,
      });

      const listing = await db.listing.findUnique({
        where: { addressNormalized: EXPECTED_KEY },
      });
      expect(listing).not.toBeNull();
      expect(listing!.isPreMarket).toBe(false);
      expect(listing!.listingStatus).toBe("live");
      expect(listing!.primarySource).toBe("uklandandfarms");
      expect(listing!.outcode).toBe("SW1A");
      expect(listing!.postcode).toBe("SW1A 1AA");
      expect(listing!.pricePence).toBe(72_500_000);
      expect(listing!.listingUrl).toBe(SOURCE_URL);

      const source = await db.listingSourceRecord.findUnique({
        where: {
          sourceType_externalId: {
            sourceType: "uklandandfarms",
            externalId: EXTERNAL_ID,
          },
        },
      });
      expect(source).not.toBeNull();
      expect(source!.listingId).toBe(listing!.id);
      expect(source!.sourceUrl).toBe(SOURCE_URL);

      expect(enqueued).toContain(listing!.id);
    });

    it("is idempotent: re-running the same scrape keeps ONE Listing + ONE source record", async () => {
      await service.runScrape({ site: "uklandandfarms", outcodes: ["SW1A"] });

      const listingCount = await db.listing.count({
        where: { addressNormalized: EXPECTED_KEY },
      });
      const sourceCount = await db.listingSourceRecord.count({
        where: { sourceType: "uklandandfarms", externalId: EXTERNAL_ID },
      });
      expect(listingCount).toBe(1);
      expect(sourceCount).toBe(1);
    });
  },
);
