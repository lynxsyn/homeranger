/**
 * Sorted-pagination integration test (M3 repository sort change).
 *
 * Proves that `list({ sort: { sortBy: "price" }, ... })` paginates across pages
 * with a correct composite keyset cursor `{ sortValue, id }` — no skipped rows,
 * no duplicated rows — even when the sort key (pricePence) has TIED values.
 * This is the AC#2 guarantee that sorting happens in the repository (not in
 * memory) and that the cursor is keyset-correct for a non-unique sort column.
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

const db = getTestPrisma();
const TEST_PREFIX = "m3-listing-sort";

function baseUpsert(addressNormalized: string, pricePence: number) {
  return {
    addressNormalized,
    postcode: null,
    outcode: "M3T",
    pricePence,
    bedrooms: 2,
    tenure: null,
    propertyType: null,
    epcRating: null,
    listingStatus: "live" as const,
    isPreMarket: false,
    listingUrl: null,
    primarySource: "agent_email" as const,
  };
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "listingRepository.list — sorted (price) keyset pagination",
  () => {
    afterEach(async () => {
      await cleanupTestData(db, TEST_PREFIX);
    });

    afterAll(async () => {
      await disconnectTestPrisma();
    });

    it("paginates price-asc across pages with no skip and no overlap (incl. tied prices)", async () => {
      // 7 rows, deliberately including tied prices (40m appears 3×, 50m twice)
      // so an id-only cursor on a non-unique sort column would skip/duplicate.
      const prices = [
        40_000_000, 40_000_000, 40_000_000, 50_000_000, 50_000_000,
        60_000_000, 70_000_000,
      ];
      const created: string[] = [];
      for (let i = 0; i < prices.length; i++) {
        const row = await listingRepository.upsertByAddress(
          baseUpsert(`test-${TEST_PREFIX}-${i}`, prices[i]!),
        );
        created.push(row.id);
      }

      const filter = { outcodes: ["M3T"] };
      const sort = { sortBy: "price" as const, sortDir: "asc" as const };
      const limit = 2;

      // Walk every page, collecting ids in arrival order.
      const seen: Array<{ id: string; pricePence: number | null }> = [];
      let cursor: string | undefined = undefined;
      let pages = 0;
      do {
        const page = await listingRepository.list({
          filter,
          sort,
          limit,
          cursor,
        });
        pages++;
        expect(page.items.length).toBeLessThanOrEqual(limit);
        for (const item of page.items) {
          seen.push({ id: item.id, pricePence: item.pricePence });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor && pages < 20);

      // No skip: every created row is present exactly once (no overlap).
      const seenIds = seen.map((s) => s.id);
      expect(new Set(seenIds).size).toBe(seenIds.length); // no duplicates
      expect(new Set(seenIds)).toEqual(new Set(created)); // no skipped rows
      expect(seen.length).toBe(prices.length);

      // Globally non-decreasing by price (the sort is correct across pages).
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]!.pricePence!).toBeGreaterThanOrEqual(
          seen[i - 1]!.pricePence!,
        );
      }
    });

    it("price-desc paginates with no skip/overlap and is globally non-increasing", async () => {
      const prices = [10_000_000, 20_000_000, 20_000_000, 30_000_000];
      const created: string[] = [];
      for (let i = 0; i < prices.length; i++) {
        const row = await listingRepository.upsertByAddress(
          baseUpsert(`test-${TEST_PREFIX}-d${i}`, prices[i]!),
        );
        created.push(row.id);
      }

      const filter = { outcodes: ["M3T"] };
      const sort = { sortBy: "price" as const, sortDir: "desc" as const };

      const seen: number[] = [];
      const seenIds: string[] = [];
      let cursor: string | undefined = undefined;
      do {
        const page = await listingRepository.list({
          filter,
          sort,
          limit: 1,
          cursor,
        });
        for (const item of page.items) {
          seen.push(item.pricePence!);
          seenIds.push(item.id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(new Set(seenIds)).toEqual(new Set(created));
      expect(seenIds.length).toBe(prices.length);
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]!).toBeLessThanOrEqual(seen[i - 1]!);
      }
    });
  },
);
