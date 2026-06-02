/**
 * analyze:listing integration test (M5 test plan, Integration rows).
 *
 * Against the live pgvector, with the DETERMINISTIC fake providers (no LLM /
 * Voyage / R2 calls), proves the per-listing pipeline:
 *   - a seeded listing → PhotoAnalysis row(s) + a non-null Listing.embedding +
 *     a ListingScore (combinedScore + rationale);
 *   - the monthly-spend kill-switch short-circuits analysis (no rows written).
 *
 * Isolation: the test pins the profile's `outcodes` to a unique test outcode so
 * the preference recompute's vectorTopK only recalls THIS test's listing (never
 * other suites' embedded rows). The SearchProfile singleton is reset afterEach.
 *
 * Gate: skipped unless VITEST_INTEGRATION=1. Runs against the live pgvector.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { listingRepository } from "../repositories/listing.repository.js";
import { photoAnalysisRepository } from "../repositories/photo-analysis.repository.js";
import { listingScoreRepository } from "../repositories/listing-score.repository.js";
import { searchProfileRepository } from "../repositories/search-profile.repository.js";
import { DefaultListingAnalysisService } from "../services/listing-analysis.service.js";
import { DefaultPreferenceMatchService } from "../services/preference-match.service.js";
import { FakeVisionScorer } from "../lib/ai/fake-vision-scorer.provider.js";
import { FakeEmbeddingProvider } from "../lib/ai/fake-embedding.provider.js";
import { FakeMatchScorer } from "../lib/ai/fake-match-scorer.provider.js";
import { FakePhotoSource } from "../lib/ai/fake-photo-source.provider.js";

const db = getTestPrisma();
const TEST_PREFIX = "m5-analysis";
const TEST_OUTCODE = "ZZ1T"; // unique → recompute only recalls this test's row

function makeService(config: { killSwitch: boolean; monthlyBudgetPence: number }) {
  const embeddingProvider = new FakeEmbeddingProvider();
  const preferenceMatchService = new DefaultPreferenceMatchService({
    embeddingProvider,
    matchScorer: new FakeMatchScorer(),
    config: { topK: 25, weightVector: 0.4, weightLlm: 0.6 },
    listingRepository,
    searchProfileRepository,
    listingScoreRepository,
  });
  return new DefaultListingAnalysisService({
    visionScorer: new FakeVisionScorer(),
    embeddingProvider,
    photoSource: new FakePhotoSource(),
    preferenceMatchService,
    config,
    listingRepository,
    photoAnalysisRepository,
  });
}

async function seedListing(suffix: string): Promise<string> {
  const row = await listingRepository.upsertByAddress({
    addressNormalized: `test-${TEST_PREFIX}-${suffix}`,
    postcode: "ZZ1 1TT",
    outcode: TEST_OUTCODE,
    pricePence: 45_000_000,
    bedrooms: 2,
    tenure: "leasehold",
    propertyType: "flat",
    epcRating: "c",
    listingStatus: "pre_market",
    isPreMarket: true,
    listingUrl: null,
    primarySource: "agent_email",
  });
  return row.id;
}

async function embeddingIsSet(listingId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ has: boolean }>>`
    SELECT ("embedding" IS NOT NULL) AS "has"
    FROM "Listing" WHERE "id" = ${listingId}::uuid
  `;
  return rows[0]?.has ?? false;
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "ListingAnalysisService (integration, fake providers)",
  () => {
    beforeEach(async () => {
      // A non-empty profile pinned to the test outcode → the recompute recalls
      // only this suite's listing(s).
      await searchProfileRepository.update({
        freeTextPreferences: "Bright modern flat with a garden near the river",
        outcodes: [TEST_OUTCODE],
        minBedrooms: null,
        maxPricePence: null,
        requiredTenure: null,
      });
    });

    afterEach(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      // Reset the singleton profile so it never leaks into other suites.
      await searchProfileRepository.update({
        freeTextPreferences: "",
        outcodes: [],
      });
      await db.$executeRaw`UPDATE "SearchProfile" SET "preferenceEmbedding" = NULL`;
    });

    afterAll(async () => {
      await disconnectTestPrisma();
    });

    it("populates PhotoAnalysis + Listing.embedding + ListingScore", async () => {
      const listingId = await seedListing("ok");
      const service = makeService({ killSwitch: false, monthlyBudgetPence: 0 });

      const result = await service.analyzeListing(listingId);

      expect(result.skipped).toBe(false);
      expect(result.photosAnalyzed).toBe(1); // FakePhotoSource yields 1 photo
      expect(result.embedded).toBe(true);

      const photos = await photoAnalysisRepository.listByListingId(listingId);
      expect(photos).toHaveLength(1);
      expect(photos[0]!.tasteScore).toBeGreaterThanOrEqual(0);
      expect(photos[0]!.tasteScore).toBeLessThanOrEqual(100);
      expect(photos[0]!.model).toBe("fake-haiku");

      expect(await embeddingIsSet(listingId)).toBe(true);

      const score = await listingScoreRepository.getByListingId(listingId);
      expect(score).not.toBeNull();
      expect(score!.combinedScore).toBeGreaterThanOrEqual(0);
      expect(score!.combinedScore).toBeLessThanOrEqual(1);
      expect(score!.rationale).toBeTruthy();
    });

    it("dedups by imageHash on a second run (no second PhotoAnalysis row)", async () => {
      const listingId = await seedListing("dedup");
      const service = makeService({ killSwitch: false, monthlyBudgetPence: 0 });

      await service.analyzeListing(listingId);
      const second = await service.analyzeListing(listingId);

      expect(second.photosSkipped).toBe(1);
      expect(second.photosAnalyzed).toBe(0);
      expect(await photoAnalysisRepository.listByListingId(listingId)).toHaveLength(
        1,
      );
    });

    it("short-circuits + writes nothing when the kill-switch flag is set", async () => {
      const listingId = await seedListing("killed");
      const service = makeService({ killSwitch: true, monthlyBudgetPence: 0 });

      const result = await service.analyzeListing(listingId);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("kill_switch_flag");
      expect(await photoAnalysisRepository.listByListingId(listingId)).toHaveLength(
        0,
      );
      expect(await embeddingIsSet(listingId)).toBe(false);
      expect(await listingScoreRepository.getByListingId(listingId)).toBeNull();
    });

    it("short-circuits when the month's spend has reached the budget", async () => {
      const listingId = await seedListing("budget");
      // Pre-seed spend AT/over the budget by recording a costly analysis on a
      // throwaway image hash for THIS month.
      await photoAnalysisRepository.upsertByImageHash({
        listingId,
        imageHash: `test-${TEST_PREFIX}-budget-seed`,
        imageUrl: null,
        tasteScore: 50,
        featuresJson: {},
        model: "seed",
        costPence: 1000,
      });

      const service = makeService({ killSwitch: false, monthlyBudgetPence: 1000 });
      const result = await service.analyzeListing(listingId);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("monthly_budget");
      // The pre-seeded row is the only PhotoAnalysis — no new analysis ran.
      expect(await photoAnalysisRepository.listByListingId(listingId)).toHaveLength(
        1,
      );
      expect(await embeddingIsSet(listingId)).toBe(false);
    });
  },
);
