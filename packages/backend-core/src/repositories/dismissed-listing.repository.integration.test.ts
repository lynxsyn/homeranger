/**
 * Integration test for dismissedListingRepository against a real pgvector
 * Postgres. Proves the per-user dismissed-listings overlay: dismiss is idempotent
 * (the COALESCE expression unique index from migration 0010 dedupes per (owner,
 * listing), including the operator's NULL owner), dismissMany is idempotent +
 * bulk, restore is idempotent, and the set is isolated across owners.
 *
 * Gate: integration project only (VITEST_INTEGRATION=1 + DATABASE_URL).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { listingRepository } from "./listing.repository.js";
import { dismissedListingRepository } from "./dismissed-listing.repository.js";

const db = getTestPrisma();
const ADDRESS_1 = "test-dismissed-listing one, se1 1aa";
const ADDRESS_2 = "test-dismissed-listing two, se1 2bb";
const USER_A = "a3a3a3a3-3333-4333-8333-3333333333a3";
const USER_B = "b3b3b3b3-3333-4333-8333-3333333333b3";

async function makeListing(address: string, outcode = "SE1"): Promise<string> {
  const listing = await listingRepository.upsertByAddress({
    addressNormalized: address,
    postcode: `${outcode} 1AA`,
    outcode,
    pricePence: 42_500_000,
    bedrooms: 2,
    tenure: null,
    propertyType: null,
    epcRating: null,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://example.test/dismissed-fixture",
    primarySource: "manual",
  });
  return listing.id;
}

async function cleanup(): Promise<void> {
  // Cascade removes any DismissedListing rows referencing the fixture listings.
  await db.listing.deleteMany({
    where: { addressNormalized: { in: [ADDRESS_1, ADDRESS_2] } },
  });
}

beforeEach(cleanup);
afterEach(async () => {
  await cleanup();
  await cleanupTestData(db);
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe("dismissedListingRepository (real pgvector)", () => {
  // Assertions are scoped to the FIXTURE listingIds (toContain / not.toContain),
  // never global emptiness — the dev DB is shared with the E2E suite.

  it("dismisses idempotently and lists a user's dismissed listing ids", async () => {
    const listingId = await makeListing(ADDRESS_1);

    expect(await dismissedListingRepository.dismiss(USER_A, listingId)).toBe(true);
    // Second dismiss of the same (owner, listing) is a no-op (unique index).
    expect(await dismissedListingRepository.dismiss(USER_A, listingId)).toBe(false);

    expect(
      await dismissedListingRepository.listDismissedListingIds(USER_A),
    ).toContain(listingId);
  });

  it("dismissMany bulk-hides idempotently (skipDuplicates), returning the newly-hidden count", async () => {
    const id1 = await makeListing(ADDRESS_1);
    const id2 = await makeListing(ADDRESS_2, "SE2");

    // First bulk dismiss inserts both.
    expect(
      await dismissedListingRepository.dismissMany(null, [id1, id2]),
    ).toBe(2);
    // Re-running with an overlapping set inserts only the new one (id1 skipped).
    expect(await dismissedListingRepository.dismissMany(null, [id1])).toBe(0);

    const ids = await dismissedListingRepository.listDismissedListingIds(null);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    // Empty input is a no-op.
    expect(await dismissedListingRepository.dismissMany(null, [])).toBe(0);
  });

  it("isolates dismissed listings across owners (incl. the operator NULL namespace)", async () => {
    const listingId = await makeListing(ADDRESS_1);
    await dismissedListingRepository.dismiss(USER_A, listingId);

    expect(
      await dismissedListingRepository.listDismissedListingIds(USER_B),
    ).not.toContain(listingId);
    expect(
      await dismissedListingRepository.listDismissedListingIds(null),
    ).not.toContain(listingId);

    // The operator (null) can dismiss the same listing independently; the
    // COALESCE unique index dedupes the operator's NULL-owner dismissals too.
    expect(await dismissedListingRepository.dismiss(null, listingId)).toBe(true);
    expect(await dismissedListingRepository.dismiss(null, listingId)).toBe(false);
    expect(
      await dismissedListingRepository.listDismissedListingIds(null),
    ).toContain(listingId);
  });

  it("restores idempotently", async () => {
    const listingId = await makeListing(ADDRESS_1);
    await dismissedListingRepository.dismiss(USER_A, listingId);

    expect(await dismissedListingRepository.restore(USER_A, listingId)).toBe(true);
    expect(
      await dismissedListingRepository.listDismissedListingIds(USER_A),
    ).not.toContain(listingId);
    // Restoring again is a no-op.
    expect(await dismissedListingRepository.restore(USER_A, listingId)).toBe(false);
  });
});
