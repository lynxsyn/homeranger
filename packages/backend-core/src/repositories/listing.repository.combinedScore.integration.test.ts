/**
 * combinedScore sort + per-search keying integration test. Proves:
 *   - `list({ sortBy: "combinedScore" })` (no searchId) orders by MAX(combinedScore)
 *     across the operator's searches, NULLS LAST, keyset-paginated with no skip /
 *     overlap even on tied scores;
 *   - `list({ searchId })` orders by THAT search's score (a home scored only by a
 *     different search trails as NULL under the lens);
 *   - the listing-score read methods return MAX vs per-search vs best correctly.
 *
 * Gate: skipped unless VITEST_INTEGRATION=1. Runs against the live pgvector.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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

let searchA: string;
let searchB: string;

/** An active operator search covering the test outcode. */
async function makeSearch(suffix: string): Promise<string> {
  const s = await db.search.create({
    data: {
      name: `test-${TEST_PREFIX}-${suffix}`,
      outcodes: [OUTCODE],
      keywords: `taste ${suffix}`,
      status: "active",
    },
    select: { id: true },
  });
  return s.id;
}

async function seed(
  suffix: string,
  combinedScore: number | null,
  searchId?: string,
): Promise<string> {
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
  if (combinedScore !== null && searchId) {
    await listingScoreRepository.upsertByListingAndSearch({
      listingId: row.id,
      searchId,
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
  searchId?: string,
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
      searchId,
    });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    for (const item of page.items) seen.push({ id: item.id });
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor && pages < 50);
  return seen;
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "listingRepository.list — combinedScore sort + per-search keying",
  () => {
    beforeEach(async () => {
      searchA = await makeSearch("searchA");
      searchB = await makeSearch("searchB");
    });
    afterEach(async () => {
      await cleanupTestData(db, TEST_PREFIX); // listings + scores + searches
    });
    afterAll(async () => {
      await disconnectTestPrisma();
    });

    it("orders scored rows DESC, unscored last, keyset across pages with tied scores (MAX path)", async () => {
      // 4 scored (incl. a 0.5 tie) + 2 unscored (NULL).
      const scoredIds = [
        await seed("a", 0.9, searchA),
        await seed("b", 0.5, searchA),
        await seed("c", 0.5, searchA),
        await seed("d", 0.1, searchA),
      ];
      const unscoredIds = [await seed("e", null), await seed("f", null)];
      const allIds = [...scoredIds, ...unscoredIds];

      const seen = await walkAll("desc", 2);
      const seenIds = seen.map((s) => s.id);

      // No skip, no overlap: every row exactly once.
      expect(new Set(seenIds).size).toBe(seenIds.length);
      expect(new Set(seenIds)).toEqual(new Set(allIds));

      // The 4 scored rows come before the 2 unscored (NULLS LAST).
      const firstUnscoredIdx = seenIds.findIndex((id) => unscoredIds.includes(id));
      expect(firstUnscoredIdx).toBe(4);
      expect(seenIds[0]).toBe(scoredIds[0]); // highest (0.9) first
    });

    it("orders scored rows ASC, unscored last, no skip/overlap (MAX path)", async () => {
      const ids = [
        await seed("g", 0.2, searchA),
        await seed("h", 0.8, searchA),
        await seed("i", null),
      ];

      const seen = await walkAll("asc", 1);
      const seenIds = seen.map((s) => s.id);

      expect(new Set(seenIds)).toEqual(new Set(ids));
      expect(seenIds[0]).toBe(ids[0]); // 0.2 first
      expect(seenIds[1]).toBe(ids[1]); // 0.8 second
      expect(seenIds[2]).toBe(ids[2]); // NULL last
    });

    it("the per-search lens orders by THAT search's score; a home scored only by another search trails", async () => {
      const onlyB = await seed("pa", 0.95, searchB); // high, but only for B
      const aHigh = await seed("pb", 0.7, searchA);
      const aLow = await seed("pc", 0.2, searchA);

      // Under the searchA lens: aHigh (0.7), aLow (0.2), then onlyB (NULL for A).
      const seen = (await walkAll("desc", 2, searchA)).map((s) => s.id);
      expect(seen).toEqual([aHigh, aLow, onlyB]);
    });

    it("reads MAX-across-searches, per-search, and best score for a multi-search listing", async () => {
      const multi = await seed("ma", 0.3, searchA); // 0.3 for A
      await listingScoreRepository.upsertByListingAndSearch({
        listingId: multi,
        searchId: searchB,
        vectorScore: 0.9,
        llmScore: 0.9,
        combinedScore: 0.9, // 0.9 for B
        rationale: "b wins",
      });

      const maxMap = await listingScoreRepository.getCombinedScoresByListingIds([multi]);
      expect(maxMap.get(multi)).toBeCloseTo(0.9); // MAX across A + B

      const aMap = await listingScoreRepository.getCombinedScoresByListingIdsForSearch(
        [multi],
        searchA,
      );
      expect(aMap.get(multi)).toBeCloseTo(0.3); // A's own score

      const best = await listingScoreRepository.getBestByListingId(multi);
      expect(best!.combinedScore).toBeCloseTo(0.9);
      expect(best!.searchId).toBe(searchB); // best is B's row
    });
  },
);
