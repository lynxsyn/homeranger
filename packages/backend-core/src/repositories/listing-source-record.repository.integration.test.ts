/**
 * Integration test for listingSourceRecordRepository.upsert idempotency
 * (M2 test-plan row 3). The composite `@@unique([sourceType, externalId])`
 * must make re-ingest a no-op for row count: a second upsert of the same
 * (sourceType, externalId) UPDATES the existing row rather than inserting a
 * duplicate.
 *
 * Gate: skipped unless VITEST_INTEGRATION=1.
 *
 * RED until M2 GREEN lands the schema + listingSourceRecord.repository.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { listingSourceRecordRepository } from "./listing-source-record.repository.js";

const db = getTestPrisma();
const TEST_PREFIX = "m2-source-record";
const EXTERNAL_ID = `test-${TEST_PREFIX}-ext-1`;

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "listingSourceRecordRepository.upsert idempotency",
  () => {
    let listingId: string;

    beforeAll(async () => {
      const listing = await db.listing.create({
        data: {
          addressNormalized: `test-${TEST_PREFIX}-addr`,
          listingStatus: "pre_market",
          isPreMarket: true,
          primarySource: "agent_email",
        },
        select: { id: true },
      });
      listingId = listing.id;
    });

    afterAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await disconnectTestPrisma();
    });

    it("re-ingesting the same (sourceType, externalId) updates, not duplicates", async () => {
      const first = await listingSourceRecordRepository.upsert({
        listingId,
        sourceType: "agent_email",
        externalId: EXTERNAL_ID,
        sourceUrl: "https://example.com/a",
      });

      const second = await listingSourceRecordRepository.upsert({
        listingId,
        sourceType: "agent_email",
        externalId: EXTERNAL_ID,
        sourceUrl: "https://example.com/b",
      });

      // Same row (same PK), updated field, no duplicate.
      expect(second.id).toBe(first.id);
      expect(second.sourceUrl).toBe("https://example.com/b");

      const count = await db.listingSourceRecord.count({
        where: { sourceType: "agent_email", externalId: EXTERNAL_ID },
      });
      expect(count).toBe(1);
    });

    it("finds a record by its composite (sourceType, externalId) key", async () => {
      const found = await listingSourceRecordRepository.findByExternalId(
        "agent_email",
        EXTERNAL_ID,
      );
      expect(found?.externalId).toBe(EXTERNAL_ID);
      expect(found?.listingId).toBe(listingId);
    });
  },
);
