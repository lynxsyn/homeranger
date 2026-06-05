/**
 * Integration test for the Sources telemetry groupBy methods
 * (countBySourceType + latestObservedBySourceType). These back the Sources
 * table's per-source "Lots found" + "Latest lot" metrics; the repo lives in the
 * coverage-excluded listing-source-record.repository.ts, so this is the ONLY
 * coverage proof for the two methods.
 *
 * Robust to a shared/polluted DB (these are whole-table groupBys, NOT
 * test-prefix-scoped): counts are asserted as a DELTA over a baseline captured
 * before inserting, and the MAX(observedAt) records use FAR-FUTURE dates so they
 * are guaranteed to be the maximum regardless of any pre-existing or seeded
 * rows (the seed writes `now`-dated scraped records to this same local DB). CI
 * runs integration on a fresh DB; this hardening keeps local re-runs honest.
 *
 * Gate: skipped unless VITEST_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { listingSourceRecordRepository } from "./listing-source-record.repository.js";

const db = getTestPrisma();
const TEST_PREFIX = "sources-telemetry";

// Far-future observedAt so this test's records are the deterministic MAX even if
// the DB already carries `now`-dated scraped records (e.g. after an E2E seed).
const AH_OBSERVED_EARLY = new Date("2099-06-01T00:00:00.000Z");
const AH_OBSERVED_MAX = new Date("2099-06-03T00:00:00.000Z");
const UKLF_OBSERVED = new Date("2099-05-20T00:00:00.000Z");

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "Sources telemetry groupBy (countBySourceType + latestObservedBySourceType)",
  () => {
    // Baseline counts captured BEFORE inserting, so assertions are delta-based.
    let baseAuction = 0;
    let baseLand = 0;

    beforeAll(async () => {
      const baseline = await listingSourceRecordRepository.countBySourceType();
      baseAuction = baseline.get("auctionhouse") ?? 0;
      baseLand = baseline.get("uklandandfarms") ?? 0;

      // Two listings to carry the scraped source records.
      const auctionListing = await db.listing.create({
        data: {
          addressNormalized: `test-${TEST_PREFIX}-auction-addr`,
          listingStatus: "live",
          isPreMarket: false,
          primarySource: "auctionhouse",
        },
        select: { id: true },
      });
      const landListing = await db.listing.create({
        data: {
          addressNormalized: `test-${TEST_PREFIX}-land-addr`,
          listingStatus: "live",
          isPreMarket: false,
          primarySource: "uklandandfarms",
        },
        select: { id: true },
      });

      // EXPLICIT distinct far-future observedAt so MAX(observedAt) is
      // deterministic AND guaranteed to dominate any pre-existing rows.
      // auctionhouse: two records, the later one (AH_OBSERVED_MAX) is the MAX.
      await db.listingSourceRecord.upsert({
        where: {
          sourceType_externalId: {
            sourceType: "auctionhouse",
            externalId: `test-${TEST_PREFIX}-ah-1`,
          },
        },
        create: {
          listingId: auctionListing.id,
          sourceType: "auctionhouse",
          externalId: `test-${TEST_PREFIX}-ah-1`,
          observedAt: AH_OBSERVED_EARLY,
        },
        update: { observedAt: AH_OBSERVED_EARLY },
      });
      await db.listingSourceRecord.upsert({
        where: {
          sourceType_externalId: {
            sourceType: "auctionhouse",
            externalId: `test-${TEST_PREFIX}-ah-2`,
          },
        },
        create: {
          listingId: auctionListing.id,
          sourceType: "auctionhouse",
          externalId: `test-${TEST_PREFIX}-ah-2`,
          observedAt: AH_OBSERVED_MAX,
        },
        update: { observedAt: AH_OBSERVED_MAX },
      });
      // uklandandfarms: a single record.
      await db.listingSourceRecord.upsert({
        where: {
          sourceType_externalId: {
            sourceType: "uklandandfarms",
            externalId: `test-${TEST_PREFIX}-uklf-1`,
          },
        },
        create: {
          listingId: landListing.id,
          sourceType: "uklandandfarms",
          externalId: `test-${TEST_PREFIX}-uklf-1`,
          observedAt: UKLF_OBSERVED,
        },
        update: { observedAt: UKLF_OBSERVED },
      });
    });

    afterAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await disconnectTestPrisma();
    });

    it("countBySourceType counts the inserted records per source (delta over baseline)", async () => {
      const counts = await listingSourceRecordRepository.countBySourceType();
      expect((counts.get("auctionhouse") ?? 0) - baseAuction).toBe(2);
      expect((counts.get("uklandandfarms") ?? 0) - baseLand).toBe(1);
    });

    it("latestObservedBySourceType returns MAX(observedAt) per source", async () => {
      const latest =
        await listingSourceRecordRepository.latestObservedBySourceType();
      // Far-future inserts dominate any pre-existing rows, so MAX is exact.
      expect(latest.get("auctionhouse")).toEqual(AH_OBSERVED_MAX);
      expect(latest.get("uklandandfarms")).toEqual(UKLF_OBSERVED);
    });
  },
);
