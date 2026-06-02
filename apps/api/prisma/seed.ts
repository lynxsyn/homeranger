/**
 * Idempotent E2E / dev seed for the M3 listings table.
 *
 * Upserts the shared fixtures via `listingRepository.upsertByAddress` (keyed on
 * `addressNormalized`, so re-running is a no-op refresh — safe under Playwright
 * `reuseExistingServer`). Run via `pnpm --filter @homescout/api db:seed`
 * (`tsx prisma/seed.ts`), folded into the E2E api webServer command before the
 * server boots.
 *
 * The fixture module is the single source of truth shared with the spec; the
 * relative import carries `.js` because apps/api is module=Node16.
 */
import { listingRepository } from "@homescout/backend-core";
import { prisma } from "@homescout/backend-core/lib/prisma";
import { LISTING_FIXTURES } from "../../../e2e/fixtures/listings.fixture.js";

async function main(): Promise<void> {
  for (const fixture of LISTING_FIXTURES) {
    await listingRepository.upsertByAddress({
      addressNormalized: fixture.addressNormalized,
      postcode: fixture.postcode,
      outcode: fixture.outcode,
      pricePence: fixture.pricePence,
      bedrooms: fixture.bedrooms,
      tenure: null,
      propertyType: null,
      epcRating: null,
      listingStatus: fixture.listingStatus,
      isPreMarket: fixture.isPreMarket,
      listingUrl: fixture.listingUrl,
      primarySource: fixture.primarySource,
    });
  }
  console.log(`Seeded ${LISTING_FIXTURES.length} listing fixtures.`);
}

main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
