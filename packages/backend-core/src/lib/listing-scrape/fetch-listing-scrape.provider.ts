/**
 * In-process listing scrape — the REAL impl behind the ListingScrapeProvider
 * interface, and the FREE replacement for the Firecrawl-backed provider (chosen
 * by the 2026-06-06 architecture review). It fetches the public UK listing sites
 * with the shared SSRF-hardened in-process HTTP fetcher (lib/http/page-fetch) —
 * no headless browser, no per-call credits — and parses the MINIMAL fields
 * (address + postcode + price + source URL + hotlink image) with the PURE,
 * unit-tested HTML parsers in listing-search.ts.
 *
 * Why this works without a browser: the three sites are server-rendered HTML, so
 * the lots/details are in the raw markup (verified live). The expensive Firecrawl
 * scrape+markdown step is replaced by `fetchPage` + the listing-search HTML
 * parsers; everything else (the deterministic region-index construction, the
 * outcode filter, the crawl-delay, the dedup/upsert service) is unchanged.
 *
 * REGION-TARGETING (unchanged from the Firecrawl impl): construct each site's
 * region index/hub URL deterministically (siteRegionIndexUrls), then:
 *   - uklandandfarms: index → extractListingLinks (detail URLs) → fetch each
 *     detail page → parseUklfDetail (+ extractImageUrl, base-resolved) → outcode
 *     filter. Per-REQUEST crawl-delay + LISTING_SCRAPE_LIMIT cap.
 *   - auctionhouse: fetch the regional hub ONCE → parseAuctionHubListings (lots
 *     inline) → outcode filter. No per-lot fetch.
 *   - pughauctions: fetch the national diary → extractPughAuctionLinks → fetch up
 *     to maxIndex event pages → parsePughLots (lots inline) → outcode filter.
 *
 * COMPLIANCE (unchanged, enforced in OUR code — Firecrawl never did robots for
 * us): the parsers pin lot URLs to the allowed hosts/paths, isListingUrl rejects
 * the disallowed paths (/customers/, /agent/, /print-lot/, /search-results,
 * /adm), and CRAWL_DELAY_MS spaces requests (auctionhouse Crawl-delay: 5s). The
 * in-process fetcher sends a real browser UA (not on the auctionhouse bot
 * denylist) and follows the SSRF + byte-cap protections of lib/http/page-fetch.
 *
 * DORMANT unless LISTING_SCRAPE_SITES enables a site (the worker still uses the
 * deterministic Fake under LISTING_SCRAPE_FAKE=1). Construction-safe: never
 * throws in the constructor; a scrape() of a disabled site drops THAT job
 * (non-retryable), never the worker. Coverage-excluded network shell over the
 * pure listing-search.ts — VERIFY each site's HTML shape live before enabling.
 */
import { fetchPage } from "../http/page-fetch.js";
import {
  LISTING_SCRAPE_SITES,
  type ListingScrapeProvider,
  type ListingScrapeSite,
  type ScrapeListingsInput,
  type ScrapedListing,
} from "./listing-scrape.provider.js";
import {
  extractHtmlTitle,
  extractImageUrl,
  extractListingLinks,
  extractPughAuctionLinks,
  parseAuctionHubListings,
  parsePughLots,
  parseUklfDetail,
  siteRegionIndexUrls,
} from "./listing-search.js";

/** robots.txt Crawl-delay (ms) per site — auctionhouse asks for 5s; others none. */
const CRAWL_DELAY_MS: Record<ListingScrapeSite, number> = {
  uklandandfarms: 0,
  auctionhouse: 5_000,
  pughauctions: 0,
};

/** Default cap on region INDEX/event pages expanded per scrape (bounds work). */
const DEFAULT_MAX_LISTING_INDEX = 2;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class FetchListingScrapeProvider implements ListingScrapeProvider {
  private readonly limit: number;
  private readonly maxIndex: number;
  private readonly enabledSites: ReadonlySet<ListingScrapeSite>;

  constructor() {
    this.limit = parsePositiveInt(process.env.LISTING_SCRAPE_LIMIT, 25);
    this.maxIndex = parsePositiveInt(
      process.env.LISTING_SCRAPE_MAX_INDEX,
      DEFAULT_MAX_LISTING_INDEX,
    );
    this.enabledSites = parseEnabledSites(process.env.LISTING_SCRAPE_SITES);
  }

  async scrape(input: ScrapeListingsInput): Promise<ScrapedListing[]> {
    if (!this.enabledSites.has(input.site)) {
      throw Object.assign(
        new Error(
          `listing scrape site not enabled: ${input.site} (set LISTING_SCRAPE_SITES)`,
        ),
        { retryable: false },
      );
    }

    const wanted = new Set(
      input.outcodes.map((o) => o.trim().toUpperCase()).filter((o) => o.length > 0),
    );
    if (wanted.size === 0) {
      return [];
    }

    const indexUrls = siteRegionIndexUrls(
      input.site,
      input.regionLabel ?? "",
      input.outcodes,
    );
    if (indexUrls.length === 0) {
      console.warn(
        JSON.stringify({
          type: "warn",
          scope: "listing-scrape.region.unmapped",
          site: input.site,
          regionLabel: input.regionLabel ?? "",
          message: "no region-index URL mapped — add a REGION_TAXONOMY row",
        }),
      );
      return [];
    }

    if (input.site === "auctionhouse") {
      return this.scrapeAuctionHub(indexUrls, wanted);
    }
    if (input.site === "pughauctions") {
      return this.scrapePugh(indexUrls, wanted);
    }
    return this.scrapeUklfIndexes(indexUrls, wanted);
  }

  private async scrapePugh(
    diaryUrls: string[],
    wanted: ReadonlySet<string>,
  ): Promise<ScrapedListing[]> {
    const delayMs = CRAWL_DELAY_MS.pughauctions;
    let requestsMade = 0;

    const eventUrls = new Set<string>();
    for (const diaryUrl of diaryUrls) {
      if (delayMs > 0 && requestsMade > 0) {
        await sleep(delayMs);
      }
      requestsMade += 1;
      let html: string;
      try {
        html = await this.fetchHtml(diaryUrl);
      } catch (error) {
        warnScrapeFailure("listing-scrape.diary.failed", "pughauctions", diaryUrl, error);
        continue;
      }
      for (const url of extractPughAuctionLinks(html)) {
        eventUrls.add(url);
      }
    }

    const results: ScrapedListing[] = [];
    const seenExternalIds = new Set<string>();
    let eventFetches = 0;
    for (const eventUrl of eventUrls) {
      if (results.length >= this.limit || eventFetches >= this.maxIndex) {
        break;
      }
      if (delayMs > 0 && requestsMade > 0) {
        await sleep(delayMs);
      }
      requestsMade += 1;
      eventFetches += 1;
      let html: string;
      try {
        html = await this.fetchHtml(eventUrl);
      } catch (error) {
        warnScrapeFailure("listing-scrape.event.failed", "pughauctions", eventUrl, error);
        continue;
      }
      for (const lot of parsePughLots(html)) {
        if (results.length >= this.limit) {
          break;
        }
        if (seenExternalIds.has(lot.externalId)) {
          continue;
        }
        const outcode = outcodeOf(lot.postcode);
        if (!outcode || !wanted.has(outcode)) {
          continue;
        }
        seenExternalIds.add(lot.externalId);
        results.push({
          externalId: lot.externalId,
          sourceUrl: lot.sourceUrl,
          addressRaw: lot.addressRaw,
          postcode: lot.postcode,
          ...(lot.pricePence !== undefined ? { pricePence: lot.pricePence } : {}),
          ...(lot.imageUrl ? { imageUrl: lot.imageUrl } : {}),
        });
      }
    }
    return results;
  }

  private async scrapeAuctionHub(
    hubUrls: string[],
    wanted: ReadonlySet<string>,
  ): Promise<ScrapedListing[]> {
    const results: ScrapedListing[] = [];
    const seenExternalIds = new Set<string>();
    const delayMs = CRAWL_DELAY_MS.auctionhouse;
    let requestsMade = 0;
    for (const hubUrl of hubUrls) {
      if (results.length >= this.limit) {
        break;
      }
      if (delayMs > 0 && requestsMade > 0) {
        await sleep(delayMs);
      }
      requestsMade += 1;
      let html: string;
      try {
        html = await this.fetchHtml(hubUrl);
      } catch (error) {
        warnScrapeFailure("listing-scrape.hub.failed", "auctionhouse", hubUrl, error);
        continue;
      }
      for (const lot of parseAuctionHubListings(html)) {
        if (results.length >= this.limit) {
          break;
        }
        if (seenExternalIds.has(lot.externalId)) {
          continue;
        }
        const outcode = outcodeOf(lot.postcode);
        if (!outcode || !wanted.has(outcode)) {
          continue;
        }
        seenExternalIds.add(lot.externalId);
        results.push({
          externalId: lot.externalId,
          sourceUrl: lot.sourceUrl,
          addressRaw: lot.addressRaw,
          postcode: lot.postcode,
          ...(lot.imageUrl ? { imageUrl: lot.imageUrl } : {}),
        });
      }
    }
    return results;
  }

  private async scrapeUklfIndexes(
    indexUrls: string[],
    wanted: ReadonlySet<string>,
  ): Promise<ScrapedListing[]> {
    const delayMs = CRAWL_DELAY_MS.uklandandfarms;
    let requestsMade = 0;

    const detailUrls = new Set<string>();
    let indexFetches = 0;
    for (const indexUrl of indexUrls) {
      if (detailUrls.size >= this.limit || indexFetches >= this.maxIndex) {
        break;
      }
      if (delayMs > 0 && requestsMade > 0) {
        await sleep(delayMs);
      }
      requestsMade += 1;
      indexFetches += 1;
      let html: string;
      try {
        html = await this.fetchHtml(indexUrl);
      } catch (error) {
        warnScrapeFailure("listing-scrape.index.failed", "uklandandfarms", indexUrl, error);
        continue;
      }
      for (const detailUrl of extractListingLinks("uklandandfarms", html)) {
        detailUrls.add(detailUrl);
        if (detailUrls.size >= this.limit) {
          break;
        }
      }
    }

    const results: ScrapedListing[] = [];
    for (const url of detailUrls) {
      if (results.length >= this.limit) {
        break;
      }
      if (delayMs > 0 && requestsMade > 0) {
        await sleep(delayMs);
      }
      requestsMade += 1;
      let scraped: ScrapedListing | null;
      try {
        scraped = await this.scrapeUklfDetail(url);
      } catch (error) {
        warnScrapeFailure("listing-scrape.detail.failed", "uklandandfarms", url, error);
        continue;
      }
      if (!scraped) {
        continue;
      }
      const outcode = outcodeOf(scraped.postcode);
      if (!outcode || !wanted.has(outcode)) {
        continue;
      }
      results.push(scraped);
    }
    return results;
  }

  /** Fetch one page's HTML via the shared SSRF-hardened fetcher (throws on non-OK). */
  private async fetchHtml(url: string): Promise<string> {
    const { html } = await fetchPage(url);
    return html;
  }

  /** Fetch + parse ONE uklandandfarms detail page into the minimal fields. */
  private async scrapeUklfDetail(url: string): Promise<ScrapedListing | null> {
    const { finalUrl, html } = await fetchPage(url);
    if (!html) {
      return null;
    }
    const parsed = parseUklfDetail(html, extractHtmlTitle(html));
    if (!parsed) {
      return null;
    }
    // Hotlink the first property image (base-resolved — uklandandfarms uses
    // root-relative /media/properties/*.jpg paths).
    const imageUrl = extractImageUrl(html, finalUrl);
    return {
      externalId: `uklandandfarms-${externalIdOf(finalUrl)}`,
      sourceUrl: finalUrl,
      addressRaw: parsed.addressRaw,
      ...(parsed.postcode ? { postcode: parsed.postcode } : {}),
      ...(parsed.pricePence !== undefined ? { pricePence: parsed.pricePence } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    };
  }
}

function warnScrapeFailure(
  scope: string,
  site: ListingScrapeSite,
  url: string,
  error: unknown,
): void {
  console.warn(
    JSON.stringify({
      type: "warn",
      scope,
      site,
      url,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

function parseEnabledSites(raw: string | undefined): ReadonlySet<ListingScrapeSite> {
  const valid = new Set<ListingScrapeSite>(LISTING_SCRAPE_SITES);
  const enabled = new Set<ListingScrapeSite>();
  for (const token of (raw ?? "").split(",")) {
    const t = token.trim() as ListingScrapeSite;
    if (valid.has(t)) {
      enabled.add(t);
    }
  }
  return enabled;
}

/** Derive a stable external-id token from a source URL (path + query). */
function externalIdOf(url: string): string {
  try {
    const u = new URL(url);
    return (
      `${u.pathname}${u.search}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
      u.hostname
    );
  } catch {
    return url.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
}

/** Derive the upper-cased outcode from a full postcode (or null). */
function outcodeOf(postcode: string | undefined): string | null {
  if (!postcode) {
    return null;
  }
  const compact = postcode.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)) {
    return null;
  }
  return compact.slice(0, -3);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
