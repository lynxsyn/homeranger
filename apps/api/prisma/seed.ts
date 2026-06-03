/**
 * Idempotent E2E / dev seed for the M3 listings table.
 *
 * Upserts the shared fixtures via `listingRepository.upsertByAddress` (keyed on
 * `addressNormalized`, so re-running is a no-op refresh — safe under Playwright
 * `reuseExistingServer`). Run via `pnpm --filter @homeranger/api db:seed`
 * (`tsx prisma/seed.ts`), folded into the E2E api webServer command before the
 * server boots.
 *
 * The fixture module is the single source of truth shared with the spec; the
 * relative import carries `.js` because apps/api is module=Node16.
 */
import {
  listingRepository,
  searchProfileRepository,
} from "@homeranger/backend-core";
import { prisma } from "@homeranger/backend-core/lib/prisma";
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

  // M5: seed the single SearchProfile so the AI-analysis E2E has preferences to
  // match against. Empty outcodes → the preference recompute recalls every
  // embedded (analysed) listing, not just one area. Idempotent (singleton row).
  await searchProfileRepository.update({
    freeTextPreferences:
      "A bright, modern flat with good natural light and some outdoor space.",
    outcodes: [],
  });

  console.log(
    `Seeded ${LISTING_FIXTURES.length} listing fixtures + the search profile.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
