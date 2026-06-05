/**
 * Single source of truth for the M3 E2E listing fixtures.
 *
 * Imported by BOTH the seed (apps/api/prisma/seed.ts, Node16 → `.js` extension)
 * and the Playwright spec (e2e/listings.spec.ts). Keeping one module means the
 * seed and the assertions can never drift.
 *
 * Prices are integer pence (£X = X * 100 pence). The set spans outcodes +
 * statuses so the table's sort can be asserted in rendered order; one row is a
 * pre-market flat with a null `listingUrl` (the email-only "no broken link"
 * case — the table shows an email-only marker, never a dead link).
 *
 * The Sources tab (PR #80/#81/#82) crawls listing-scrape sources. The last
 * three fixtures are SCRAPED lots (auctionhouse / uklandandfarms) seeded with a
 * `ListingSourceRecord` so the Sources screen has real per-source telemetry
 * (lotsFound, latest lot) and the Listings From-column shows a SOURCE name
 * instead of an agency. Their outcodes sit in the LL2x/LL3x North-Wales
 * taxonomy (REGION_TAXONOMY) so the source coverage derivation matches the
 * seeded data. `externalId` is the composite-unique key for the source record.
 */

/** The scraped link-out sources (a subset of the ListingSource enum). */
export type ScrapedSource = "uklandandfarms" | "auctionhouse";

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
  primarySource: "agent_email" | "manual" | ScrapedSource;
  /**
   * For SCRAPED fixtures only: the composite-unique key for the
   * ListingSourceRecord upsert (keyed on `(sourceType, externalId)`). Absent on
   * agent/manual fixtures, which carry no source-record provenance row.
   */
  externalId?: string;
}

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
    // A different outcode + the lowest price (sorts last by price-desc).
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
  {
    // SCRAPED — Auction House lot #1 (North Wales, LL30 Llandudno). The
    // From-column shows "Auction House"; the source-link points at the lot URL.
    addressNormalized: "deganwy avenue llandudno ll30",
    postcode: "LL30 2YB",
    outcode: "LL30",
    pricePence: 185_000_00, // £185,000
    bedrooms: 3,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://online.auctionhouse.co.uk/lot/redirect/346219",
    primarySource: "auctionhouse",
    externalId: "auctionhouse-lot-346219",
  },
  {
    // SCRAPED — Auction House lot #2 (North Wales, LL28 Conwy). A second
    // auctionhouse lot so the Sources screen asserts a distinct lotsFound (2).
    addressNormalized: "bryn road conwy ll28",
    postcode: "LL28 5RD",
    outcode: "LL28",
    pricePence: 142_500_00, // £142,500
    bedrooms: 2,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://online.auctionhouse.co.uk/lot/redirect/351804",
    primarySource: "auctionhouse",
    externalId: "auctionhouse-lot-351804",
  },
  {
    // SCRAPED — UK Land & Farms lot (North Wales, LL26 Llanrwst, Conwy valley).
    // The land source (green-trees mark); From-column shows "UK Land & Farms".
    // Outcode LL26 sits inside the source's declared LL2x/LL3x coverage so the
    // seeded lot and the Sources coverage chips it advertises stay consistent.
    addressNormalized: "nant farm llanrwst ll26",
    postcode: "LL26 0AB",
    outcode: "LL26",
    pricePence: 275_000_00, // £275,000
    bedrooms: null,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://www.uklandandfarms.co.uk/property/nant-farm-llanrwst",
    primarySource: "uklandandfarms",
    externalId: "uklandandfarms-nant-farm-llanrwst",
  },
];
