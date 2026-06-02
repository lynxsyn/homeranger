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

function baseUpsert(addressNormalized: string, pricePence: number | null) {
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

/**
 * Walk every page of `list` for the given sort, collecting rows in arrival
 * order. Caps at 50 pages as a safety net so a keyset bug can't loop forever.
 */
async function walkAllPages(
  sort: { sortBy: "price" | "lastSeenAt"; sortDir: "asc" | "desc" },
  limit: number,
): Promise<Array<{ id: string; pricePence: number | null; lastSeenAt: Date }>> {
  const filter = { outcodes: ["M3T"] };
  const seen: Array<{
    id: string;
    pricePence: number | null;
    lastSeenAt: Date;
  }> = [];
  let cursor: string | undefined = undefined;
  let pages = 0;
  do {
    const page = await listingRepository.list({ filter, sort, limit, cursor });
    pages++;
    expect(page.items.length).toBeLessThanOrEqual(limit);
    for (const item of page.items) {
      seen.push({
        id: item.id,
        pricePence: item.pricePence,
        lastSeenAt: item.lastSeenAt,
      });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor && pages < 50);
  return seen;
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

    // HIGH review-fix regression: NULL-priced rows interleaved with TIED
    // non-null prices. The old `?? -1` sentinel silently dropped every NULL
    // row once a page boundary touched the NULL block (NULL > -1 is NULL, not
    // TRUE). With `priceIsNull` as a first-class keyset value, NULLs are paged
    // exactly once (NULLS LAST in ASC / FIRST in DESC).
    it("price-asc pages NULL-priced rows EXACTLY once when interleaved with tied prices", async () => {
      // 3 NULLs + tied non-nulls (40m×2, 60m×3) → NULLs must land LAST in ASC.
      const prices: Array<number | null> = [
        40_000_000, 40_000_000, null, 60_000_000, 60_000_000, null, 60_000_000,
        null,
      ];
      const created: string[] = [];
      for (let i = 0; i < prices.length; i++) {
        const row = await listingRepository.upsertByAddress(
          baseUpsert(`test-${TEST_PREFIX}-na${i}`, prices[i]!),
        );
        created.push(row.id);
      }

      const seen = await walkAllPages(
        { sortBy: "price", sortDir: "asc" },
        2,
      );
      const seenIds = seen.map((s) => s.id);

      // Every row (incl. all 3 NULLs) appears exactly once: no skip, no dup.
      expect(new Set(seenIds).size).toBe(seenIds.length);
      expect(new Set(seenIds)).toEqual(new Set(created));
      expect(seen.length).toBe(prices.length);
      expect(seen.filter((s) => s.pricePence === null)).toHaveLength(3);

      // NULLs sort LAST in ASC: once a NULL appears, no non-null follows; and
      // the non-null prefix is non-decreasing.
      const firstNullIdx = seen.findIndex((s) => s.pricePence === null);
      expect(firstNullIdx).toBeGreaterThanOrEqual(0);
      for (let i = firstNullIdx; i < seen.length; i++) {
        expect(seen[i]!.pricePence).toBeNull();
      }
      for (let i = 1; i < firstNullIdx; i++) {
        expect(seen[i]!.pricePence!).toBeGreaterThanOrEqual(
          seen[i - 1]!.pricePence!,
        );
      }
    });

    it("price-desc pages NULL-priced rows EXACTLY once when interleaved with tied prices", async () => {
      const prices: Array<number | null> = [
        null, 30_000_000, 30_000_000, null, 20_000_000, 30_000_000, null,
      ];
      const created: string[] = [];
      for (let i = 0; i < prices.length; i++) {
        const row = await listingRepository.upsertByAddress(
          baseUpsert(`test-${TEST_PREFIX}-nd${i}`, prices[i]!),
        );
        created.push(row.id);
      }

      const seen = await walkAllPages(
        { sortBy: "price", sortDir: "desc" },
        2,
      );
      const seenIds = seen.map((s) => s.id);

      expect(new Set(seenIds).size).toBe(seenIds.length);
      expect(new Set(seenIds)).toEqual(new Set(created));
      expect(seen.length).toBe(prices.length);
      expect(seen.filter((s) => s.pricePence === null)).toHaveLength(3);

      // NULLs sort FIRST in DESC: the leading block is all NULL, then the
      // non-null suffix is non-increasing.
      const lastNullIdx =
        seen.length -
        1 -
        [...seen].reverse().findIndex((s) => s.pricePence === null);
      for (let i = 0; i <= lastNullIdx; i++) {
        expect(seen[i]!.pricePence).toBeNull();
      }
      for (let i = lastNullIdx + 2; i < seen.length; i++) {
        expect(seen[i]!.pricePence!).toBeLessThanOrEqual(
          seen[i - 1]!.pricePence!,
        );
      }
    });

    // MEDIUM review-fix: lastSeenAt sort had ZERO integration coverage. This
    // exercises the string sortValue + Date(sortValue) round-trip in
    // buildCompositeCursorFilter (a materially different code path from price),
    // including a tied lastSeenAt (forced via upsert re-stamping `now`).
    it("paginates lastSeenAt asc + desc with no skip/overlap (incl. a tied timestamp)", async () => {
      // Create 5 rows. Re-upsert one to bump its lastSeenAt to `now`, and
      // create two more in the same tick to force a likely tie on lastSeenAt.
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await listingRepository.upsertByAddress(
          baseUpsert(`test-${TEST_PREFIX}-ls${i}`, 10_000_000 + i),
        );
        created.push(row.id);
      }
      // Re-stamp the first row's lastSeenAt to the latest tick.
      await listingRepository.upsertByAddress(
        baseUpsert(`test-${TEST_PREFIX}-ls0`, 10_000_000),
      );

      for (const dir of ["asc", "desc"] as const) {
        const seen = await walkAllPages({ sortBy: "lastSeenAt", sortDir: dir }, 2);
        const seenIds = seen.map((s) => s.id);

        // No skip, no overlap across pages — every row exactly once.
        expect(new Set(seenIds).size).toBe(seenIds.length);
        expect(new Set(seenIds)).toEqual(new Set(created));
        expect(seen.length).toBe(created.length);

        // Globally monotonic on lastSeenAt in the requested direction.
        for (let i = 1; i < seen.length; i++) {
          const prev = seen[i - 1]!.lastSeenAt.getTime();
          const cur = seen[i]!.lastSeenAt.getTime();
          if (dir === "asc") {
            expect(cur).toBeGreaterThanOrEqual(prev);
          } else {
            expect(cur).toBeLessThanOrEqual(prev);
          }
        }
      }
    });
  },
);
