/**
 * Firecrawl-backed listing scrape — the REAL impl behind the
 * ListingScrapeProvider interface. Scrapes two public UK listing sites
 * (uklandandfarms.co.uk + auctionhouse.co.uk) for properties in the target
 * outcodes and extracts the MINIMAL fields (address + postcode + price +
 * source URL) homeranger needs to dedup + link out.
 *
 * REGION-TARGETING MODEL (operator-confirmed against the live sites): generic web
 * search does NOT surface listing detail URLs — it returns each site's region
 * INDEX / HUB page. So instead of searching, we CONSTRUCT each site's region index
 * URL DETERMINISTICALLY from a small site-taxonomy map (siteRegionIndexUrls), then
 * hop to the listings. The two sites diverge:
 *
 *   - uklandandfarms: region index = /rural-property-for-sale/<region>/<area>/
 *     (e.g. North Wales / Conwy / LL2x-LL3x → wales/north-wales). The index lists
 *     TOWN-level locations but NOT the full postcode, so we scrape the index
 *     (markdown) → extractListingLinks (harvest detail URLs) → scrape each detail
 *     page for the full postcode + price → keep only the target outcodes. Detail
 *     fetches honour the per-REQUEST Crawl-delay + the LISTING_SCRAPE_LIMIT cap.
 *   - auctionhouse: regional hub = /<room> (e.g. Wales → /wales). The hub lists
 *     CURRENT lots WITH a full address + postcode AND the lot URL inline, so we
 *     scrape the hub ONCE and parse ScrapedListings STRAIGHT out of the markdown
 *     (parseAuctionHubListings) — NO per-lot detail scrape (cheaper, the data is
 *     right there) — then keep only the target outcodes.
 *
 * An unmapped region resolves to [] index URLs → a clean empty scrape (never a
 * wrong-region scrape). The region-targeting + parsing LOGIC lives in the PURE,
 * UNIT-TESTED listing-search.ts; this file is the thin network shell around it
 * (mirrors the agent-discovery adapter + discovery-queries.ts split).
 *
 * DORMANT by default — two gates must BOTH be set before this provider does any
 * network I/O:
 *   - FIRECRAWL_API_KEY (the vendor key), and
 *   - LISTING_SCRAPE_SITES (a comma list of the sites that are ENABLED).
 * The worker only constructs this provider when LISTING_SCRAPE_FAKE !== "1", so
 * E2E/CI always use the deterministic fake and incur no spend/network. Like
 * FirecrawlAgentDiscoveryProvider this is CONSTRUCTION-SAFE: it NEVER throws in
 * the constructor (the worker must boot regardless of env); a scrape() with no
 * key / a disabled site fails THAT job (non-retryable drop), never the worker.
 *
 * NB: this is integration-/operator-proven (like RealResendHydrator + the
 * Firecrawl agent-discovery adapter), NOT unit-tested — coverage-excluded as
 * network I/O. VERIFY each site's taxonomy paths, robots.txt, and Crawl-delay
 * against the LIVE site BEFORE enabling it. Verified Firecrawl shape (context7,
 * 2026-06-05), same as the agent-discovery adapter:
 *   - /v1/scrape → POST {url,formats:["markdown"]} → {data:{markdown,metadata}}.
 * robots: auctionhouse disallows /search-results + /print-lot/ and sets
 * Crawl-delay: 5 — we never touch those paths (isListingUrl + the hub-only scrape
 * enforce it) and SPACE uklandandfarms detail fetches by the per-site delay;
 * uklandandfarms disallows only /customers/ + /agent/ (isListingUrl enforces it).
 * Minimal extraction ONLY (no images/description/metadata) per
 * docs/compliance/listing-sourcing-basis.md.
 */
import {
  type ListingScrapeProvider,
  type ListingScrapeSite,
  type ScrapeListingsInput,
  type ScrapedListing,
} from "./listing-scrape.provider.js";
import {
  extractImageUrl,
  extractListingLinks,
  parseAuctionHubListings,
  parseUklfDetail,
  siteRegionIndexUrls,
} from "./listing-search.js";

interface FirecrawlScrapeResult {
  url?: string;
  markdown?: string;
  metadata?: { title?: string; sourceURL?: string };
}

/** robots.txt Crawl-delay (ms) per site — auctionhouse asks for 5s. */
const CRAWL_DELAY_MS: Record<ListingScrapeSite, number> = {
  uklandandfarms: 0,
  auctionhouse: 5_000,
};

/** Default cap on region INDEX pages expanded per scrape (bounds spend). */
const DEFAULT_MAX_LISTING_INDEX = 2;

/** Parse a positive-int env var with a default + a >0 clamp. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class FirecrawlListingScrapeProvider implements ListingScrapeProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly limit: number;
  /** Max region INDEX pages to expand per scrape (uklandandfarms; bounds spend). */
  private readonly maxIndex: number;
  private readonly enabledSites: ReadonlySet<ListingScrapeSite>;

  // Construction-safe: does NOT throw when FIRECRAWL_API_KEY / LISTING_SCRAPE_SITES
  // are unset, so the worker boots regardless (the M6 env-wiring lesson). A
  // scrape() with no key OR a disabled site fails THAT job (non-retryable drop),
  // never the worker — listing scraping is dormant until the operator opts in.
  constructor(
    apiKey: string | undefined = process.env.FIRECRAWL_API_KEY,
    baseUrl: string = process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev",
  ) {
    this.apiKey = apiKey?.trim() || undefined;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.limit = parsePositiveInt(process.env.LISTING_SCRAPE_LIMIT, 25);
    this.maxIndex = parsePositiveInt(
      process.env.LISTING_SCRAPE_MAX_INDEX,
      DEFAULT_MAX_LISTING_INDEX,
    );
    this.enabledSites = parseEnabledSites(process.env.LISTING_SCRAPE_SITES);
  }

  async scrape(input: ScrapeListingsInput): Promise<ScrapedListing[]> {
    if (!this.apiKey) {
      // Config gap, not transient — drop the job (don't retry forever).
      throw Object.assign(
        new Error("FIRECRAWL_API_KEY not set — listing scraping is disabled"),
        { retryable: false },
      );
    }
    if (!this.enabledSites.has(input.site)) {
      // The site has not been enabled by the operator — drop (non-retryable).
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

    // Construct the region index/hub URLs deterministically; an unmapped region
    // yields [] → a clean empty scrape (no wrong-region work).
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

    return input.site === "auctionhouse"
      ? this.scrapeAuctionHub(indexUrls, wanted)
      : this.scrapeUklfIndexes(indexUrls, wanted);
  }

  /**
   * auctionhouse: scrape each regional HUB ONCE and parse lots straight out of the
   * markdown (full address + postcode + lot URL are inline) — no per-lot detail
   * scrape. Best-effort per hub (a failed hub scrape logs + yields nothing for
   * that hub, never aborts). Crawl-delay between hub requests; outcode-filter +
   * cap at LISTING_SCRAPE_LIMIT.
   */
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
      let markdown: string;
      try {
        markdown = await this.scrapePageMarkdown(hubUrl);
      } catch (error) {
        warnScrapeFailure("listing-scrape.hub.failed", "auctionhouse", hubUrl, error);
        continue;
      }
      for (const lot of parseAuctionHubListings(markdown)) {
        if (results.length >= this.limit) {
          break;
        }
        if (seenExternalIds.has(lot.externalId)) {
          continue;
        }
        const outcode = outcodeOf(lot.postcode);
        if (!outcode || !wanted.has(outcode)) {
          continue; // outside the target patch
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

  /**
   * uklandandfarms: scrape up to maxIndex region INDEX pages (markdown), harvest
   * the detail URLs (extractListingLinks), then scrape each detail page for the
   * full postcode + price and keep only the target outcodes. Best-effort per index
   * page (a failed index scrape logs + skips, never aborts). Crawl-delay before
   * every network REQUEST (index + detail); cap at LISTING_SCRAPE_LIMIT.
   */
  private async scrapeUklfIndexes(
    indexUrls: string[],
    wanted: ReadonlySet<string>,
  ): Promise<ScrapedListing[]> {
    const delayMs = CRAWL_DELAY_MS.uklandandfarms;
    let requestsMade = 0;

    // 1. Harvest detail URLs from up to maxIndex index pages.
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
      let markdown: string;
      try {
        markdown = await this.scrapePageMarkdown(indexUrl);
      } catch (error) {
        warnScrapeFailure(
          "listing-scrape.index.failed",
          "uklandandfarms",
          indexUrl,
          error,
        );
        continue;
      }
      for (const detailUrl of extractListingLinks("uklandandfarms", markdown)) {
        detailUrls.add(detailUrl);
        if (detailUrls.size >= this.limit) {
          break;
        }
      }
    }

    // 2. Scrape each detail page; keep only the target outcodes.
    const results: ScrapedListing[] = [];
    for (const url of detailUrls) {
      if (results.length >= this.limit) {
        break;
      }
      // Crawl-delay before EVERY request (the robots Crawl-delay is per-REQUEST,
      // not per-kept-result): a detail the outcode filter later prunes still
      // counts as a request.
      if (delayMs > 0 && requestsMade > 0) {
        await sleep(delayMs);
      }
      requestsMade += 1;
      const scraped = await this.scrapeDetail(url, "uklandandfarms");
      if (!scraped) {
        continue;
      }
      const outcode = outcodeOf(scraped.postcode);
      if (!outcode || !wanted.has(outcode)) {
        continue; // outside the target patch
      }
      results.push(scraped);
    }
    return results;
  }

  /**
   * Firecrawl-scrape ONE page and return its raw markdown so the caller can
   * harvest detail/lot links or parse hub rows. HTTP errors map to the retryable
   * flag.
   */
  private async scrapePageMarkdown(url: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/scrape`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!response.ok) {
      throwOnHttp(response.status, `Firecrawl scrape failed: ${response.status}`);
    }
    const body = (await response.json()) as { data?: FirecrawlScrapeResult };
    return body.data?.markdown ?? "";
  }

  /**
   * Firecrawl-scrape ONE detail page (markdown) and extract the minimal fields.
   * Returns null when the page yields no usable address.
   */
  private async scrapeDetail(
    url: string,
    site: ListingScrapeSite,
  ): Promise<ScrapedListing | null> {
    const response = await fetch(`${this.baseUrl}/v1/scrape`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!response.ok) {
      throwOnHttp(response.status, `Firecrawl scrape failed: ${response.status}`);
    }
    const body = (await response.json()) as { data?: FirecrawlScrapeResult };
    const data = body.data;
    const text = data?.markdown ?? "";
    const sourceUrl = data?.metadata?.sourceURL ?? data?.url ?? url;

    // Parse the PROPERTY address + postcode from the page heading / <title> — NOT
    // the first line (the nav) or the first postcode (the selling agent's office).
    // See parseUklfDetail for the bug this fixes. Returns null on an unusable page.
    const parsed = parseUklfDetail(text, data?.metadata?.title);
    if (!parsed) {
      return null;
    }
    // Hotlink the first property image off the detail page (display-only; never
    // downloaded — see the listing-sourcing-basis). Off-allowlist / base64
    // artifacts are rejected by isHotlinkableImageUrl → undefined (placeholder).
    const imageUrl = extractImageUrl(text);

    return {
      externalId: `${site}-${externalIdOf(sourceUrl)}`,
      sourceUrl,
      addressRaw: parsed.addressRaw,
      ...(parsed.postcode ? { postcode: parsed.postcode } : {}),
      ...(parsed.pricePence !== undefined ? { pricePence: parsed.pricePence } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    };
  }
}

/** Structured warn-log for a best-effort scrape failure (never throws). */
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

/** Map an HTTP status to a thrown error with the retryable flag set correctly. */
function throwOnHttp(status: number, message: string): never {
  // 429/5xx are transient (retryable); 4xx are not.
  throw Object.assign(new Error(message), {
    retryable: status === 429 || status >= 500,
  });
}

function parseEnabledSites(raw: string | undefined): ReadonlySet<ListingScrapeSite> {
  const valid = new Set<ListingScrapeSite>(["uklandandfarms", "auctionhouse"]);
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
    return `${u.pathname}${u.search}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || u.hostname;
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
