/**
 * Single source of truth for the M3 E2E listing fixtures.
 *
 * Imported by BOTH the seed (apps/api/prisma/seed.ts, Node16 → `.js` extension)
 * and the Playwright spec (e2e/listings.spec.ts). Keeping one module means the
 * seed and the assertions can never drift.
 *
 * Prices are integer pence (£X = X * 100 pence). The SE1 set exercises the
 * outcode + max-price filter; one row is a pre-market flat with a null
 * `listingUrl` (the email-only "no broken link" case, AC#4).
 */

/** A seedable listing fixture (the upsertByAddress input shape). */
export interface ListingFixture {
  addressNormalized: string;
  postcode: string | null;
  outcode: string | null;
  pricePence: number | null;
  bedrooms: number | null;
  listingStatus: "pre_market" | "live" | "under_offer" | "sold" | "withdrawn";
  isPreMarket: boolean;
  listingUrl: string | null;
  primarySource: "agent_email" | "manual";
}

/** £600,000 expressed in integer pence = 60,000,000. */
export const FILTER_MAX_PRICE_PENCE = 600_000_00;

export const LISTING_FIXTURES: ListingFixture[] = [
  {
    addressNormalized: "rivington street se1",
    postcode: "SE1 1AA",
    outcode: "SE1",
    pricePence: 425_000_00, // £425,000
    bedrooms: 2,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://listings.example.test/rivington-se1",
    primarySource: "agent_email",
  },
  {
    addressNormalized: "union street se1",
    postcode: "SE1 0LR",
    outcode: "SE1",
    pricePence: 575_000_00, // £575,000
    bedrooms: 3,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://listings.example.test/union-se1",
    primarySource: "agent_email",
  },
  {
    addressNormalized: "hatfields se1",
    postcode: "SE1 9PG",
    outcode: "SE1",
    pricePence: 845_000_00, // £845,000 — EXCLUDED by the £600k ceiling
    bedrooms: 4,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://listings.example.test/hatfields-se1",
    primarySource: "agent_email",
  },
  {
    // Pre-market, email-only: no listingUrl (AC#4 "no broken link" case).
    addressNormalized: "pre market flat se1",
    postcode: "SE1 7TY",
    outcode: "SE1",
    pricePence: 510_000_00, // £510,000 (<= £600k, so passes the price filter)
    bedrooms: 2,
    listingStatus: "pre_market",
    isPreMarket: true,
    listingUrl: null,
    primarySource: "agent_email",
  },
  {
    // A different outcode so the SE1 filter must exclude it.
    addressNormalized: "deansgate m3",
    postcode: "M3 4LZ",
    outcode: "M3",
    pricePence: 320_000_00, // £320,000
    bedrooms: 1,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://listings.example.test/deansgate-m3",
    primarySource: "agent_email",
  },
];

/** Fixtures that match outcode=SE1 AND price <= £600,000 (the filter test). */
export const SE1_UNDER_600K = LISTING_FIXTURES.filter(
  (l) =>
    l.outcode === "SE1" &&
    l.pricePence !== null &&
    l.pricePence <= FILTER_MAX_PRICE_PENCE,
);
