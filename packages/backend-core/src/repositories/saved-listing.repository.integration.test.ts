/**
 * Integration test for savedListingRepository against a real pgvector Postgres.
 * Proves the per-user saved-listings overlay: save is idempotent (the COALESCE
 * expression unique index from migration 0008 dedupes per (owner, listing),
 * including the operator's NULL owner), unsave is idempotent, and the listing
 * set is isolated across owners.
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
import { savedListingRepository } from "./saved-listing.repository.js";

const db = getTestPrisma();
const ADDRESS = "test-saved-listing fixture, se1 1aa";
const USER_A = "a2a2a2a2-2222-4222-8222-2222222222a2";
const USER_B = "b2b2b2b2-2222-4222-8222-2222222222b2";

async function makeListing(): Promise<string> {
  const listing = await listingRepository.upsertByAddress({
    addressNormalized: ADDRESS,
    postcode: "SE1 1AA",
    outcode: "SE1",
    pricePence: 42_500_000,
    bedrooms: 2,
    tenure: null,
    propertyType: null,
    epcRating: null,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://example.test/saved-fixture",
    primarySource: "manual",
  });
  return listing.id;
}

async function cleanup(): Promise<void> {
  // Cascade removes any SavedListing rows referencing the fixture listing.
  await db.listing.deleteMany({ where: { addressNormalized: ADDRESS } });
}

beforeEach(cleanup);
afterEach(async () => {
  await cleanup();
  await cleanupTestData(db);
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe("savedListingRepository (real pgvector)", () => {
  // Assertions are scoped to the FIXTURE listingId (toContain / not.toContain),
  // never global emptiness — the dev DB is shared with the E2E suite, so the
  // operator (NULL) namespace may legitimately hold OTHER listings' saves.

  it("saves idempotently and lists a user's saved listing ids", async () => {
    const listingId = await makeListing();

    expect(await savedListingRepository.save(USER_A, listingId)).toBe(true);
    // Second save of the same (owner, listing) is a no-op (unique index).
    expect(await savedListingRepository.save(USER_A, listingId)).toBe(false);

    expect(await savedListingRepository.listSavedListingIds(USER_A)).toContain(
      listingId,
    );
  });

  it("isolates saved listings across owners (incl. the operator NULL namespace)", async () => {
    const listingId = await makeListing();
    await savedListingRepository.save(USER_A, listingId);

    // Neither USER_B nor the operator has saved THIS listing yet.
    expect(
      await savedListingRepository.listSavedListingIds(USER_B),
    ).not.toContain(listingId);
    expect(
      await savedListingRepository.listSavedListingIds(null),
    ).not.toContain(listingId);

    // The operator (null) can save the same listing independently, and the
    // COALESCE unique index dedupes the operator's NULL-owner saves too.
    expect(await savedListingRepository.save(null, listingId)).toBe(true);
    expect(await savedListingRepository.save(null, listingId)).toBe(false);
    expect(await savedListingRepository.listSavedListingIds(null)).toContain(
      listingId,
    );
    // USER_A's save is still independent of the operator's.
    expect(await savedListingRepository.listSavedListingIds(USER_A)).toContain(
      listingId,
    );
  });

  it("unsaves idempotently", async () => {
    const listingId = await makeListing();
    await savedListingRepository.save(USER_A, listingId);

    expect(await savedListingRepository.unsave(USER_A, listingId)).toBe(true);
    expect(
      await savedListingRepository.listSavedListingIds(USER_A),
    ).not.toContain(listingId);
    // Unsaving again is a no-op.
    expect(await savedListingRepository.unsave(USER_A, listingId)).toBe(false);
  });
});
