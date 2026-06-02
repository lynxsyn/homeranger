/**
 * combinedScore sort integration test (M5 AC#7 — the listings table's default
 * sort). Proves `list({ sortBy: "combinedScore" })` orders by the LEFT-JOINed
 * ListingScore.combinedScore with NULLS LAST (unscored listings trail), keyset-
 * paginated across pages with no skip / no overlap even on tied scores.
 *
 * Gate: skipped unless VITEST_INTEGRATION=1. Runs against the live pgvector.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { listingRepository } from "./listing.repository.js";
import { listingScoreRepository } from "./listing-score.repository.js";

const db = getTestPrisma();
const TEST_PREFIX = "m5-score-sort";
const OUTCODE = "ZZ2T";

async function seed(suffix: string, combinedScore: number | null): Promise<string> {
  const row = await listingRepository.upsertByAddress({
    addressNormalized: `test-${TEST_PREFIX}-${suffix}`,
    postcode: null,
    outcode: OUTCODE,
    pricePence: 30_000_000,
    bedrooms: 2,
    tenure: null,
    propertyType: null,
    epcRating: null,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: null,
    primarySource: "agent_email",
  });
  if (combinedScore !== null) {
    await listingScoreRepository.upsertByListingId({
      listingId: row.id,
      vectorScore: combinedScore,
      llmScore: combinedScore,
      combinedScore,
      rationale: `score ${combinedScore}`,
    });
  }
  return row.id;
}

async function walkAll(
  dir: "asc" | "desc",
  limit: number,
): Promise<Array<{ id: string }>> {
  const seen: Array<{ id: string }> = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await listingRepository.list({
      filter: { outcodes: [OUTCODE] },
      sort: { sortBy: "combinedScore", sortDir: dir },
      limit,
      cursor,
    });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    for (const item of page.items) seen.push({ id: item.id });
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor && pages < 50);
  return seen;
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "listingRepository.list — combinedScore sort (NULLS LAST keyset)",
  () => {
    afterEach(async () => {
      await cleanupTestData(db, TEST_PREFIX);
    });
    afterAll(async () => {
      await disconnectTestPrisma();
    });

    it("orders scored rows DESC, unscored last, keyset across pages with tied scores", async () => {
      // 4 scored (incl. a 0.5 tie) + 2 unscored (NULL).
      const scoredIds = [
        await seed("a", 0.9),
        await seed("b", 0.5),
        await seed("c", 0.5),
        await seed("d", 0.1),
      ];
      const unscoredIds = [await seed("e", null), await seed("f", null)];
      const allIds = [...scoredIds, ...unscoredIds];

      const seen = await walkAll("desc", 2);
      const seenIds = seen.map((s) => s.id);

      // No skip, no overlap: every row exactly once.
      expect(new Set(seenIds).size).toBe(seenIds.length);
      expect(new Set(seenIds)).toEqual(new Set(allIds));

      // The 4 scored rows come before the 2 unscored (NULLS LAST).
      const firstUnscoredIdx = seenIds.findIndex((id) =>
        unscoredIds.includes(id),
      );
      expect(firstUnscoredIdx).toBe(4);
      // The highest score (0.9, "a") is first.
      expect(seenIds[0]).toBe(scoredIds[0]);
    });

    it("orders scored rows ASC, unscored last, no skip/overlap", async () => {
      const ids = [
        await seed("g", 0.2),
        await seed("h", 0.8),
        await seed("i", null),
      ];

      const seen = await walkAll("asc", 1);
      const seenIds = seen.map((s) => s.id);

      expect(new Set(seenIds)).toEqual(new Set(ids));
      // ASC: 0.2 ("g") first, 0.8 ("h") second, NULL ("i") last.
      expect(seenIds[0]).toBe(ids[0]);
      expect(seenIds[1]).toBe(ids[1]);
      expect(seenIds[2]).toBe(ids[2]);
    });
  },
);
