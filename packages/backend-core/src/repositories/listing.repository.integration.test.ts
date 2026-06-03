/**
 * Integration tests for listingRepository.upsertByAddress + list cursor
 * pagination + integer-pence storage (M2 test-plan row 4 at the repository
 * layer, exercised against real Postgres) and the vectorTopK price/beds
 * structured pre-filter (test-plan row 2).
 *
 * Gate: skipped unless VITEST_INTEGRATION=1.
 *
 * RED until M2 GREEN lands schema + listing.repository.ts implementations.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { listingRepository } from "./listing.repository.js";

const db = getTestPrisma();
const TEST_PREFIX = "m2-listing-repo";
const DIM = 1024;

function vec(value: number, rest = 0): number[] {
  const v = new Array<number>(DIM).fill(rest);
  v[0] = value;
  return v;
}

function baseUpsert(addressNormalized: string) {
  return {
    addressNormalized,
    postcode: null,
    outcode: "SW1A",
    pricePence: 50000000,
    bedrooms: 3,
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
  "listingRepository (upsert + list + vectorTopK prefilter)",
  () => {
    afterEach(async () => {
      await cleanupTestData(db, TEST_PREFIX);
    });

    afterAll(async () => {
      await disconnectTestPrisma();
    });

    it("upsertByAddress is idempotent on addressNormalized and stores integer pence", async () => {
      const address = `test-${TEST_PREFIX}-dedup`;
      const first = await listingRepository.upsertByAddress(baseUpsert(address));
      expect(first.pricePence).toBe(50000000);
      expect(Number.isInteger(first.pricePence)).toBe(true);

      const second = await listingRepository.upsertByAddress({
        ...baseUpsert(address),
        pricePence: 49500000,
      });
      expect(second.id).toBe(first.id);
      expect(second.pricePence).toBe(49500000);

      const count = await db.listing.count({
        where: { addressNormalized: address },
      });
      expect(count).toBe(1);
    });

    it("list returns { items, nextCursor } and paginates with a stable cursor", async () => {
      for (let i = 0; i < 3; i++) {
        await listingRepository.upsertByAddress(
          baseUpsert(`test-${TEST_PREFIX}-page-${i}`),
        );
      }

      const filter = { outcodes: ["SW1A"] };
      const firstPage = await listingRepository.list({ filter, limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await listingRepository.list({
        filter,
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.items.length).toBeGreaterThanOrEqual(1);
      expect(secondPage.nextCursor).toBeNull();

      // No overlap between pages.
      const firstIds = new Set(firstPage.items.map((r) => r.id));
      for (const row of secondPage.items) {
        expect(firstIds.has(row.id)).toBe(false);
      }
    });

    it("countByAgentEmails groups listings by agentEmail and omits unmatched/null emails", async () => {
      const seller = "test-seller@example.com";
      const other = "test-other@example.com";
      // Two listings attributed to `seller`, one to `other`, one with NO agent.
      await listingRepository.upsertByAddress({
        ...baseUpsert(`test-${TEST_PREFIX}-cba-1`),
        agentEmail: seller,
      });
      await listingRepository.upsertByAddress({
        ...baseUpsert(`test-${TEST_PREFIX}-cba-2`),
        agentEmail: seller,
      });
      await listingRepository.upsertByAddress({
        ...baseUpsert(`test-${TEST_PREFIX}-cba-3`),
        agentEmail: other,
      });
      await listingRepository.upsertByAddress(
        baseUpsert(`test-${TEST_PREFIX}-cba-null`),
      );

      const counts = await listingRepository.countByAgentEmails([
        seller,
        other,
        "test-nobody@example.com",
      ]);
      expect(counts.get(seller)).toBe(2);
      expect(counts.get(other)).toBe(1);
      // An email with no listings is ABSENT (the caller defaults it to 0); the
      // NULL-agentEmail listing is never counted.
      expect(counts.has("test-nobody@example.com")).toBe(false);

      // An empty email list short-circuits to an empty Map (no query).
      expect((await listingRepository.countByAgentEmails([])).size).toBe(0);
    });

    it("vectorTopK applies a price + beds pre-filter before ranking", async () => {
      const cheap = await listingRepository.upsertByAddress({
        ...baseUpsert(`test-${TEST_PREFIX}-cheap`),
        pricePence: 30000000,
        bedrooms: 4,
      });
      const dear = await listingRepository.upsertByAddress({
        ...baseUpsert(`test-${TEST_PREFIX}-dear`),
        pricePence: 90000000,
        bedrooms: 4,
      });
      await listingRepository.writeEmbedding(cheap.id, vec(1, 0));
      await listingRepository.writeEmbedding(dear.id, vec(1, 0));

      const results = await listingRepository.vectorTopK(vec(1, 0), 10, {
        maxPricePence: 50000000,
        minBedrooms: 3,
      });
      expect(results.map((r) => r.id)).toEqual([cheap.id]);
    });
  },
);
