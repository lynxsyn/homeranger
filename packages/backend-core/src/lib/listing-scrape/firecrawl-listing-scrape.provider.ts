/**
 * Firecrawl-backed listing scrape — the REAL impl behind the
 * ListingScrapeProvider interface. Scrapes two public UK listing sites
 * (uklandandfarms.co.uk + auctionhouse.co.uk) for properties in the target
 * outcodes and extracts the MINIMAL fields (address + postcode + price +
 * source URL) homeranger needs to dedup + link out.
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
 * network I/O. VERIFY each site's request shape, robots.txt, and Crawl-delay
 * against the LIVE site when first enabling it — the discovery/extraction below
 * is a best-effort scaffold:
 *   - uklandandfarms: robots.txt disallows only /customers/ + /agent/; the
 *     sitemap /propertylink.xml lists /search/detail.aspx?PropertyRef=<id> URLs.
 *     We scrape candidate detail pages (markdown) and extract address/postcode/
 *     price, keeping only those whose derived outcode is in input.outcodes.
 *   - auctionhouse: robots.txt disallows /search-results + /print-lot/ and sets
 *     Crawl-delay: 5 — reach lots via the allowed regional-room pages and follow
 *     to /lot/... pages; SPACE requests ~5s. Extract address/postcode/guide
 *     price + the lot URL.
 * Minimal extraction ONLY (no images/description/metadata) per
 * docs/compliance/listing-sourcing-basis.md.
 */
import {
  type ListingScrapeProvider,
  type ListingScrapeSite,
  type ScrapeListingsInput,
  type ScrapedListing,
} from "./listing-scrape.provider.js";

/** A full UK postcode anywhere in the page text. */
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
/** A £-prefixed price (with optional thousands separators). */
const PRICE_RE = /£\s*([\d,]+)/;

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

export class FirecrawlListingScrapeProvider implements ListingScrapeProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly limit: number;
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
    const parsedLimit = Number.parseInt(
      process.env.LISTING_SCRAPE_LIMIT ?? "25",
      10,
    );
    this.limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25;
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

    const candidateUrls = await this.discoverCandidateUrls(input);
    const results: ScrapedListing[] = [];
    const delayMs = CRAWL_DELAY_MS[input.site];
    let requestsMade = 0;

    for (const url of candidateUrls) {
      if (results.length >= this.limit) {
        break;
      }
      // Respect the site's Crawl-delay before EVERY detail-page fetch (the
      // robots.txt Crawl-delay is per-REQUEST, not per-kept-result): pages the
      // outcode filter later prunes still count as a request, so key the delay
      // on requests issued, never on results accepted.
      if (delayMs > 0 && requestsMade > 0) {
        await sleep(delayMs);
      }
      requestsMade += 1;
      const scraped = await this.scrapeDetail(url, input.site);
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
   * Resolve the candidate listing-detail URLs to scrape for a site. Best-effort
   * — VERIFY the real sitemap/room-page shapes against the live site before
   * enabling. Returns at most `limit` URLs (the per-detail outcode filter prunes
   * further).
   */
  private async discoverCandidateUrls(
    input: ScrapeListingsInput,
  ): Promise<string[]> {
    if (input.site === "uklandandfarms") {
      // The sitemap lists /search/detail.aspx?PropertyRef=<id> detail URLs. The
      // PropertyRef token is bounded to safe ref chars (no `/`, so a malicious
      // sitemap can't smuggle a path-traversal ref), and every absolutised URL
      // is re-validated to the exact site origin before we hand it to Firecrawl.
      const base = "https://www.uklandandfarms.co.uk";
      const sitemap = await this.fetchText(`${base}/propertylink.xml`);
      return boundToOrigins(
        extractUrls(
          sitemap,
          /\/search\/detail\.aspx\?PropertyRef=[\w.%=_-]+/gi,
        ).map((u) => absolutise(u, base)),
        [base],
      ).slice(0, this.limit);
    }
    // auctionhouse: reach lots via the allowed regional-room pages (NEVER
    // /search-results or /print-lot/, which robots disallows), then follow to
    // /lot/... pages on the online./wales. subdomains. The regex binds to those
    // two subdomains + a word-char path only (no query string), so an embedded
    // open-redirect lot URL (`/lot/redirect/1?next=https://evil`) can't carry an
    // off-domain target into Firecrawl; boundToOrigins is the belt-and-braces.
    const room = await this.fetchText("https://www.auctionhouse.co.uk/");
    return boundToOrigins(
      extractUrls(
        room,
        /https?:\/\/(?:online|wales)\.auctionhouse\.co\.uk\/lot\/[\w/-]+/gi,
      ),
      [
        "https://online.auctionhouse.co.uk",
        "https://wales.auctionhouse.co.uk",
      ],
    ).slice(0, this.limit);
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

    const addressRaw = firstLine(text);
    // A usable property address is short; a multi-hundred-char first line is page
    // noise (a banner, an inline asset, an error) — drop it rather than storing
    // an oversized blob as the address + in rawPayload.
    if (!addressRaw || addressRaw.length > 300) {
      return null;
    }
    const postcodeMatch = text.match(POSTCODE_RE);
    const priceMatch = text.match(PRICE_RE);
    const pricePence = priceMatch
      ? Number.parseInt(priceMatch[1]!.replace(/,/g, ""), 10) * 100
      : undefined;

    return {
      externalId: `${site}-${externalIdOf(sourceUrl)}`,
      sourceUrl,
      addressRaw,
      ...(postcodeMatch ? { postcode: postcodeMatch[0] } : {}),
      ...(pricePence !== undefined && Number.isFinite(pricePence)
        ? { pricePence }
        : {}),
    };
  }

  /** Plain GET of a sitemap/room page (NOT through Firecrawl — raw HTML/XML). */
  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throwOnHttp(response.status, `fetch ${url} failed: ${response.status}`);
    }
    return response.text();
  }
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

function extractUrls(text: string, re: RegExp): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(re)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/**
 * Keep only URLs whose parsed origin is in `allowed` — the SSRF backstop for the
 * URL sets we extract from remote (untrusted) sitemaps/room pages before handing
 * them to Firecrawl. An unparseable or off-origin URL is dropped.
 */
function boundToOrigins(urls: string[], allowed: string[]): string[] {
  const ok = new Set(allowed);
  return urls.filter((u) => {
    try {
      return ok.has(new URL(u).origin);
    } catch {
      return false;
    }
  });
}

function absolutise(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

/** The first non-empty markdown line, with leading markdown noise stripped. */
function firstLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[#>*\-\s]+/, "").trim();
    if (line.length > 0) {
      return line;
    }
  }
  return null;
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
