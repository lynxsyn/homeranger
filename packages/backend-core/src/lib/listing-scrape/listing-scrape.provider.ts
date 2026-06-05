/**
 * ListingScrapeProvider — the swappable seam that scrapes public UK listing
 * sites (uklandandfarms.co.uk + auctionhouse.co.uk) for properties to LINK OUT
 * to. The real impl (firecrawl-listing-scrape.provider.ts) does the network
 * scrape; this module owns the interface + types + the deterministic, network-
 * free fake the worker uses under LISTING_SCRAPE_FAKE=1 (E2E/CI never hit the
 * network or spend). Mirrors the AgentDiscoveryProvider seam from M7.
 *
 * Scraping only SOURCES candidates; the ListingScrapeService dedups + upserts
 * them as Listings and enqueues analyze:listing. Extraction is MINIMAL by design
 * (address + postcode + price + source URL only — no images, no description, no
 * beds) per docs/compliance/listing-sourcing-basis.md: we read the bare minimum
 * to dedup + link out, and the canonical record stays on the source site.
 */

/** The two public listing sites we scrape (mirror the new ListingSource enum values). */
export type ListingScrapeSite = "uklandandfarms" | "auctionhouse";

/** The enabled-by-default ordering used when looping every site. */
export const LISTING_SCRAPE_SITES: readonly ListingScrapeSite[] = [
  "uklandandfarms",
  "auctionhouse",
];

export interface ScrapeListingsInput {
  /** Which site to scrape. */
  site: ListingScrapeSite;
  /** Target outcodes — only listings whose derived outcode is in this set are kept. */
  outcodes: string[];
  /** Optional human region label (search-query context + a log/fixture label). */
  regionLabel?: string;
}

/**
 * The MINIMAL listing fields we extract from a source site. Deliberately lean
 * (no images / description / beds / tenure) — homeranger links OUT to the source
 * rather than re-publishing the listing (docs/compliance/listing-sourcing-basis.md).
 * `pricePence` is integer pence (never float); `postcode` is optional because not
 * every source page exposes a full postcode.
 */
export interface ScrapedListing {
  /** Stable per-site external id (the source's listing ref) — the idempotency key. */
  externalId: string;
  /** The clickable source URL the listings table links out to. */
  sourceUrl: string;
  /** The raw human address text (used to build the dedup key). */
  addressRaw: string;
  /** Full UK postcode when the source exposes one. */
  postcode?: string;
  /** Integer pence (never float). */
  pricePence?: number;
}

export interface ListingScrapeProvider {
  scrape(input: ScrapeListingsInput): Promise<ScrapedListing[]>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Title-case a slug-ish token for the human-readable address area. */
function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** A site-specific, stable base price (pence) so fixtures are byte-stable. */
const FAKE_BASE_PRICE_PENCE: Record<ListingScrapeSite, number> = {
  uklandandfarms: 65_000_000, // £650,000
  auctionhouse: 18_500_000, // £185,000 (auction guide)
};

/**
 * Deterministic, network-free scrape for E2E/CI (LISTING_SCRAPE_FAKE=1). Derives
 * a STABLE pair of listings from the site + the FIRST target outcode so the
 * output is byte-stable AND every fake listing falls in a target outcode (so it
 * matches an active operator search by outcode downstream). Zero spend, no
 * network. Empty outcodes ⇒ [] (nothing to target).
 */
export class FakeListingScrapeProvider implements ListingScrapeProvider {
  async scrape(input: ScrapeListingsInput): Promise<ScrapedListing[]> {
    const firstOutcode = input.outcodes
      .map((o) => o.trim().toUpperCase())
      .find((o) => o.length > 0);
    if (!firstOutcode) {
      // No target outcodes — nothing to scrape.
      return [];
    }

    const siteSlug = slugify(input.site);
    const area = titleCase(input.regionLabel?.trim() || firstOutcode);
    const basePrice = FAKE_BASE_PRICE_PENCE[input.site];

    return [1, 2].map((n) => {
      const slug = `${siteSlug}-${slugify(firstOutcode)}-${n}`;
      return {
        externalId: `${input.site}-${slug}`,
        sourceUrl: `https://${input.site}.example/listing/${slug}`,
        addressRaw: `${n} Fake ${titleCase(siteSlug)} Way, ${area}`,
        // A full postcode within the first target outcode so the derived outcode
        // matches the search (e.g. "LL30" → "LL30 1AA").
        postcode: `${firstOutcode} ${n}AA`,
        // Deterministic per-listing price (base + a stable per-index offset).
        pricePence: basePrice + n * 1_000_00,
      };
    });
  }
}
