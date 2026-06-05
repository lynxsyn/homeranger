/**
 * Pure listing-search helpers — UNIT-COVERED, NOT coverage-excluded. These carry
 * the whole REGION-TARGETING + URL-classification logic for the listing scrape;
 * the Firecrawl provider (firecrawl-listing-scrape.provider.ts) is a thin,
 * operator-proven network shell around them. Mirrors discovery-queries.ts (the
 * discovery-recall counterpart).
 *
 * STRATEGY (operator-confirmed against the live sites): DON'T rely on generic web
 * search to surface listing detail URLs — it returns each site's region INDEX /
 * HUB page, not the individual detail/lot URLs. Instead CONSTRUCT each site's
 * region index URL DETERMINISTICALLY from a small site-taxonomy map
 * (siteRegionIndexUrls), then hop to the listings:
 *
 *   - uklandandfarms: region index = /rural-property-for-sale/<region>/<area>/
 *     (e.g. North Wales / Conwy / LL2x-LL3x → wales/north-wales). The index lists
 *     TOWN-level locations but NOT the full postcode, so the provider scrapes the
 *     index → extractListingLinks (harvest detail URLs) → scrapes each detail page
 *     for the full postcode → keeps only the target outcodes.
 *   - auctionhouse: regional hub = /<room> (e.g. Wales → /wales). The hub lists
 *     CURRENT lots WITH full address + postcode AND the lot URL inline, so the
 *     provider scrapes the hub ONCE and parses ScrapedListings straight out of the
 *     markdown (parseAuctionHubListings) — no per-lot detail scrape needed — then
 *     keeps only the target outcodes.
 *
 * Unmapped regions resolve to [] (a clean no-op, never a wrong scrape).
 *
 * No network, no env reads in here — config is passed in as args. The provider
 * owns env + I/O.
 */
import type { ListingScrapeSite } from "./listing-scrape.provider.js";

/** A full UK postcode — capture groups split outcode + incode for normalising. */
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

/**
 * One row of a site-taxonomy mapping: a set of region aliases + outcode prefixes
 * that, when matched, resolve to the site-specific index/hub URLs. EXTENSIBLE —
 * add a row per region group as the operator confirms each site's path/room slug.
 */
interface RegionTaxonomyRow {
  /** Lower-cased region-label substrings that select this row. */
  readonly regionAliases: readonly string[];
  /** Upper-cased outcode prefixes that select this row (e.g. "LL30" → "LL3"). */
  readonly outcodePrefixes: readonly string[];
  /** The constructed region-index URLs per site. */
  readonly urls: Readonly<Record<ListingScrapeSite, readonly string[]>>;
}

/**
 * The seed taxonomy. Today: North Wales / Conwy / LL2x-LL3x → uklandandfarms
 * wales/north-wales index + auctionhouse /wales hub. Add rows here as more
 * regions are confirmed live; an unmatched region/outcode falls back to [].
 */
const REGION_TAXONOMY: readonly RegionTaxonomyRow[] = [
  {
    regionAliases: ["north wales", "conwy", "gwynedd", "denbighshire", "anglesey"],
    // LL20-LL39 (North Wales) — matched by the LL2/LL3 prefix below.
    outcodePrefixes: ["LL2", "LL3"],
    urls: {
      uklandandfarms: [
        "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/",
      ],
      auctionhouse: ["https://www.auctionhouse.co.uk/wales"],
    },
  },
];

/**
 * Construct the site-specific region INDEX / HUB URLs for a region, deterministic
 * from REGION_TAXONOMY. Matches on the region label (case-insensitive substring)
 * OR any target outcode (by prefix). Returns the site's mapped URLs (deduped,
 * stable order), or [] for an unmapped region (a clean no-op). Pure.
 */
export function siteRegionIndexUrls(
  site: ListingScrapeSite,
  regionLabel: string,
  outcodes: string[],
): string[] {
  const region = (regionLabel ?? "").trim().toLowerCase();
  const codes = (outcodes ?? [])
    .map((o) => (o ?? "").trim().toUpperCase())
    .filter((o) => o.length > 0);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of REGION_TAXONOMY) {
    const regionHit =
      region.length > 0 && row.regionAliases.some((a) => region.includes(a));
    const outcodeHit = codes.some((code) =>
      row.outcodePrefixes.some((p) => code.startsWith(p)),
    );
    if (!regionHit && !outcodeHit) {
      continue;
    }
    for (const url of row.urls[site]) {
      if (!seen.has(url)) {
        seen.add(url);
        result.push(url);
      }
    }
  }
  return result;
}

/**
 * The coverage a site is CONFIGURED to crawl, derived from REGION_TAXONOMY: the
 * union of outcode prefixes + region labels across every taxonomy row that maps
 * at least one index/hub URL for this site. Pure + UNIT-tested. Today both sites
 * cover the single North-Wales row; grows automatically as rows are added.
 * `outcodes` = the configured PREFIXES ("LL2","LL3"); `regionLabels` = lower-cased aliases.
 */
export function siteCoverage(
  site: ListingScrapeSite,
): { outcodes: string[]; regionLabels: string[] } {
  const outcodes = new Set<string>();
  const labels = new Set<string>();
  for (const row of REGION_TAXONOMY) {
    if (row.urls[site].length === 0) {
      continue; // not configured to crawl this region for this site
    }
    for (const p of row.outcodePrefixes) outcodes.add(p);
    for (const a of row.regionAliases) labels.add(a);
  }
  return { outcodes: [...outcodes], regionLabels: [...labels] };
}

/**
 * TRUE only for a real listing DETAIL URL on the correct host(s), robots-safe.
 * Uses `new URL()` parsing (never a loose regex); an unparseable URL is rejected.
 *
 *   - uklandandfarms: host www.uklandandfarms.co.uk AND the path is a detail page
 *     — /search/detail.aspx with a non-empty PropertyRef query, OR a deep
 *     /rural-property-for-sale/<region>/<area>/<slug-or-id>/ page whose LAST
 *     segment carries a ref token (a digit, or a `<word>_<ref>` / `<word>-<ref>`
 *     slug). NEVER under /customers/ or /agent/ (robots.txt).
 *   - auctionhouse: host a *.auctionhouse.co.uk subdomain EXCEPT www (lots live on
 *     online./wales./regional rooms) AND path starts /lot/ but NOT /print-lot/
 *     (robots.txt). /lot/redirect/<id> is allowed; ANY query string is rejected
 *     (open-redirect guard).
 */
export function isListingUrl(site: ListingScrapeSite, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // unparseable — reject
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const lowerPath = path.toLowerCase();

  if (site === "uklandandfarms") {
    if (host !== "www.uklandandfarms.co.uk") {
      return false;
    }
    if (lowerPath.startsWith("/customers/") || lowerPath.startsWith("/agent/")) {
      return false;
    }
    if (lowerPath === "/search/detail.aspx") {
      const ref = parsed.searchParams.get("PropertyRef");
      return ref !== null && ref.trim().length > 0;
    }
    const prefix = UKLF_INDEX_PREFIXES.find((p) => lowerPath.startsWith(p));
    if (!prefix) {
      return false;
    }
    const segments = segmentsBelow(path, prefix);
    // A DETAIL page is deeper than the bare <region>/<area> index and its LAST
    // segment carries a ref token (e.g. `83440_chs250018`, `glyn_ceiriog-34141009`,
    // `99991_1283`). The area index (.../<area>/, no ref segment) is NOT a detail.
    return segments.length > 0 && isDetailRefSegment(segments[segments.length - 1]!);
  }

  // auctionhouse
  if (!host.endsWith(".auctionhouse.co.uk")) {
    return false;
  }
  if (host === "www.auctionhouse.co.uk") {
    return false; // the marketing www site is not a lot host
  }
  if (parsed.search.length > 0) {
    return false; // reject ANY query string (open-redirect guard)
  }
  if (lowerPath.startsWith("/print-lot/")) {
    return false; // robots.txt disallows the printable lot view
  }
  // A real lot detail page (/lot/<id> or /lot/redirect/<id>) — require a segment
  // beneath /lot/ so the bare section index is not accepted.
  return isDeepPathUnder(path, "/lot/");
}

/** uklandandfarms section roots that hold the area listing index pages. */
const UKLF_INDEX_PREFIXES = [
  "/rural-property-for-sale/",
  "/rural-properties-for-sale/",
];

/**
 * Harvest candidate listing DETAIL URLs from a uklandandfarms region INDEX page's
 * markdown/HTML. Pulls every link-like token (absolute OR root-relative),
 * absolutises relative ones against the site's www origin, then keeps ONLY those
 * that pass isListingUrl(site, ...). Deduped, stable first-seen order. Pure — the
 * provider feeds it the scraped index body.
 */
export function extractListingLinks(
  site: ListingScrapeSite,
  text: string,
): string[] {
  if (!text) {
    return [];
  }
  const base = SITE_BASE_ORIGIN[site];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of text.matchAll(LINK_TOKEN_RE)) {
    const raw = match[0];
    let absolute: string;
    try {
      absolute = new URL(raw, base).toString();
    } catch {
      continue; // unparseable token — skip
    }
    if (!isListingUrl(site, absolute)) {
      continue;
    }
    if (!seen.has(absolute)) {
      seen.add(absolute);
      links.push(absolute);
    }
  }
  return links;
}

/** The www origin each site's relative index links resolve against. */
const SITE_BASE_ORIGIN: Record<ListingScrapeSite, string> = {
  uklandandfarms: "https://www.uklandandfarms.co.uk",
  auctionhouse: "https://www.auctionhouse.co.uk",
};

/**
 * A link-like token in markdown/HTML: an absolute http(s) URL, OR a root-relative
 * path. Bounded to URL-safe characters (stops at whitespace, quotes, parens,
 * angle brackets, brackets) so it cleanly lifts hrefs out of `[text](url)` /
 * `href="url"`.
 */
const LINK_TOKEN_RE = /(?:https?:\/\/[^\s"'()<>[\]]+|\/[^\s"'()<>[\]]+)/gi;

/** One lot parsed directly out of the auctionhouse regional HUB markdown. */
export interface ParsedHubListing {
  externalId: string;
  sourceUrl: string;
  addressRaw: string;
  postcode: string;
}

/**
 * Parse the CURRENT lots straight out of an auctionhouse regional HUB page's
 * markdown. The hub lists each lot WITH a full address + postcode inline AND the
 * lot URL, so we recover {addressRaw, postcode, sourceUrl, externalId} per lot
 * WITHOUT a per-lot detail scrape (cheaper, and the data is right there). Pure.
 *
 * REAL SHAPE (captured live): each lot renders as a markdown IMAGE link that
 * spans two lines, the address sitting on the line immediately before the closing
 * `](<lot-url>)`, e.g.
 *
 *   [![Property for Auction in Wales - 23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB](https://cdn.../image)\
 *   23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB](https://online.auctionhouse.co.uk/lot/redirect/346219 "View property details")
 *
 * The plain `[text](url)` matcher can't see this (the `[` opens back at the image,
 * and the text contains `]`). The reliable signal is: a `](<LOTURL>)` close whose
 * preceding link TEXT — a run of chars NOT crossing a `]` or a newline — is the
 * ADDRESS ending in a UK postcode, and whose LOTURL is
 * `https?://(online|wales).auctionhouse.co.uk/lot/redirect/<id>`. We scan the
 * WHOLE markdown (not line-by-line) for that pattern, pull the clean postcode out
 * of the captured address text, and emit one lot per match. A match whose text has
 * no postcode is skipped. Deduped by externalId (a lot can appear twice), stable
 * first-seen order.
 */
export function parseAuctionHubListings(markdown: string): ParsedHubListing[] {
  if (!markdown) {
    return [];
  }
  const out: ParsedHubListing[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(AUCTION_LOT_LINK_RE)) {
    // Strip any leading image-artifact: if Firecrawl collapses the lot onto ONE
    // line (no newline before the address), the captured text can begin with the
    // image link's trailing `...image)` + the `\` markdown hard-break. Drop a
    // leading `<...>)` and any leading backslash/whitespace so the address is
    // clean. With the normal two-line shape the address is already clean (the
    // newline bounded the capture) and this is a no-op.
    const addressText = sanitiseHubAddress(match[1] ?? "");
    const lotUrl = match[2] ?? "";
    const id = match[3] ?? "";
    const postcode = firstPostcode(addressText);
    if (!postcode) {
      continue; // no postcode in the link text → not placeable by outcode
    }
    const externalId = `auctionhouse-${id}`;
    if (seen.has(externalId)) {
      continue; // a lot can appear twice in the hub — first seen wins
    }
    const addressRaw = cleanAddress(addressText) || postcode;
    seen.add(externalId);
    out.push({ externalId, sourceUrl: lotUrl, addressRaw, postcode });
  }
  return out;
}

/**
 * An auctionhouse lot link as the live hub renders it. Group 1 = the link TEXT
 * ending in a UK postcode (the address — bounded to not cross a `]` or newline,
 * so it captures only the trailing address line, never the image-alt prefix);
 * group 2 = the lot URL; group 3 = the numeric lot id. The URL host is pinned to
 * the online./wales. lot subdomains + the /lot/redirect/<id> path (matches
 * isListingUrl's intent; no query string captured).
 */
const AUCTION_LOT_LINK_RE =
  /([^\]\n]*?[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\]\((https?:\/\/(?:online|wales)\.auctionhouse\.co\.uk\/lot\/redirect\/(\d+))/gi;

/**
 * Strip a leading image-link artifact from a captured hub address. Removes a
 * leading `...)` (the image URL's closing paren when the lot collapsed to one
 * line) and any leading `\`/whitespace (the markdown hard-break). A normal
 * two-line capture has none of this, so it is returned trimmed unchanged.
 */
function sanitiseHubAddress(text: string): string {
  return text
    // Only strip a leading "...://...)" — i.e. a real (image) URL artifact, so a
    // legitimate address containing "(...)" is never truncated.
    .replace(/^[^)]*:\/\/[^)]*\)\s*/, "")
    .replace(/^[\\\s]+/, "") // drop a leading backslash hard-break / whitespace
    .trim();
}

/** The first full UK postcode in a string (normalised "OUT IN"), or null. */
function firstPostcode(text: string): string | null {
  const m = text.match(POSTCODE_RE);
  if (!m) {
    return null;
  }
  return `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}`;
}

/**
 * Tidy an anchor-text address: collapse whitespace, strip a trailing postcode
 * fragment's duplication, drop leading markdown noise. Returns "" when nothing
 * usable remains. Keep simple — the address is stored as-is for the dedup key.
 */
function cleanAddress(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0 || collapsed.length > 300) {
    return "";
  }
  return collapsed;
}


/** The `/`-split, non-empty path segments BELOW a (trailing-slashed) prefix. */
function segmentsBelow(path: string, prefix: string): string[] {
  const lower = path.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lower.startsWith(lowerPrefix)) {
    return [];
  }
  return path
    .slice(prefix.length)
    .split("/")
    .filter((s) => s.trim().length > 0);
}

/**
 * TRUE when a uklandandfarms path segment is a DETAIL ref (not an area index
 * segment). A detail ref is purely numeric (`1283`), OR a slug carrying a ref
 * suffix joined by `_` or `-` (`83440_chs250018`, `glyn_ceiriog-34141009`,
 * `sychdyn_mold_flintshire-nm7holkr`). A bare area slug (`north-wales`, `conwy`)
 * has no such ref token and is NOT a detail.
 */
function isDetailRefSegment(segment: string): boolean {
  if (/^[0-9][0-9_]*$/.test(segment)) {
    return true; // pure numeric ref
  }
  // A slug with a trailing ref token containing at least one digit
  // (e.g. `..._chs250018`, `...-34141009`, `...-nm7holkr`). The last `_`/`-`
  // delimited token must contain a digit AND be alphanumeric (a ref, not a word).
  const tokens = segment.split(/[_-]/).filter((t) => t.length > 0);
  if (tokens.length < 2) {
    return false; // a single word slug is an area index segment, not a detail
  }
  const last = tokens[tokens.length - 1]!;
  return /\d/.test(last) && /^[a-z0-9]+$/i.test(last);
}

/**
 * TRUE when `path` is a non-empty page BENEATH `prefix` (a trailing-slashed
 * section root) — it starts with the prefix AND has at least one more non-empty
 * segment. The bare section index (the prefix itself) is NOT a detail page.
 */
function isDeepPathUnder(path: string, prefix: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.startsWith(prefix)) {
    return false;
  }
  const rest = path.slice(prefix.length).replace(/\/+$/, "");
  return rest.trim().length > 0;
}
