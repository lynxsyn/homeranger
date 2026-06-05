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
/** A £-prefixed price (with optional thousands separators) — group 1 = digits. */
const PRICE_RE = /£\s*([\d,]+)/;
/**
 * A price-LABELLED £ amount (`Guide Price £…`, `Asking £…`, `Offers over £…`,
 * `Price: £…`) — group 1 = digits. Used as the body fallback so an UNLABELLED
 * mortgage-calculator value / monthly-repayment figure is never mis-read as the
 * listing price.
 */
const PRICE_LABEL_RE =
  /(?:guide|asking|offers(?:\s+(?:over|in excess of|around|invited))?|price)\b[^£\n]{0,16}£\s*([\d,]+)/i;
/** A markdown H1 line (`# …`), global — for the property-heading fallback. */
const H1_LINE_RE = /^#[^\S\r\n]+(.+)$/gm;

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
      // pughauctions is a NATIONAL catalogue (no per-region URL) — see
      // NATIONAL_INDEX_URLS; it is not mapped per REGION_TAXONOMY row.
      pughauctions: [],
    },
  },
];

/**
 * NATIONAL-catalogue sources: sites with a single current-stock catalogue and NO
 * per-region URL. siteRegionIndexUrls returns the catalogue URL(s) for these
 * whenever the scrape has target outcodes, and the provider outcode-filters the
 * parsed listings (the patch is applied AFTER parsing, not via the URL). Today:
 * pughauctions — the /auction-diary lists upcoming auction EVENTS, each event
 * page lists its lots inline (address + postcode + lot URL), parsed like a hub.
 */
const NATIONAL_INDEX_URLS: Partial<Record<ListingScrapeSite, readonly string[]>> =
  {
    pughauctions: ["https://www.pugh-auctions.com/auction-diary"],
  };

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

  // National-catalogue sources (no per-region URL): scrape the whole current
  // catalogue whenever the scrape has ANY target outcodes; the operator's patch
  // is applied by outcode-filtering the parsed lots, not by the URL. Returns []
  // with no outcodes (nothing to target) — same clean no-op as an unmapped region.
  const national = NATIONAL_INDEX_URLS[site];
  if (national) {
    return codes.length > 0 ? [...national] : [];
  }

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
  // A national-catalogue source is not region-mapped — it covers the whole UK,
  // filtered to whatever outcodes the operator searches. Report it as such.
  if (NATIONAL_INDEX_URLS[site]) {
    return { outcodes: [], regionLabels: ["nationwide"] };
  }
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

  if (site === "pughauctions") {
    // A Pugh LOT detail page: www.pugh-auctions.com/property/<ref>. NEVER /adm
    // (robots.txt); reject any query string (hygiene — Pugh lot URLs carry none).
    if (host !== "www.pugh-auctions.com") {
      return false;
    }
    if (lowerPath.startsWith("/adm")) {
      return false;
    }
    if (parsed.search.length > 0) {
      return false;
    }
    return isDeepPathUnder(path, "/property/");
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
  pughauctions: "https://www.pugh-auctions.com",
};

/**
 * A link-like token in markdown/HTML: an absolute http(s) URL, OR a root-relative
 * path. Bounded to URL-safe characters (stops at whitespace, quotes, parens,
 * angle brackets, brackets) so it cleanly lifts hrefs out of `[text](url)` /
 * `href="url"`.
 */
const LINK_TOKEN_RE = /(?:https?:\/\/[^\s"'()<>[\]]+|\/[^\s"'()<>[\]]+)/gi;

/** One lot parsed directly out of an auction HUB / event page's markdown. */
export interface ParsedHubListing {
  externalId: string;
  sourceUrl: string;
  addressRaw: string;
  postcode: string;
  /** Integer pence when the hub carries a guide price inline (pugh), else absent. */
  pricePence?: number;
  /** Hotlinkable thumbnail URL from the hub (the lot's `![…](url)` image). */
  imageUrl?: string;
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
  const imageById = auctionHubImagesById(markdown);
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
    const imageUrl = imageById.get(id);
    out.push({
      externalId,
      sourceUrl: lotUrl,
      addressRaw,
      postcode,
      ...(imageUrl ? { imageUrl } : {}),
    });
  }
  return out;
}

/**
 * Harvest the upcoming AUCTION-EVENT URLs from the Pugh `/auction-diary` markdown.
 * The diary lists each upcoming sale as a `…/auction/<id>` link (NOT a lot); the
 * provider then scrapes each event page and parsePughLots-es its inline lots.
 * Deduped, stable first-seen order. Pure.
 */
export function extractPughAuctionLinks(markdown: string): string[] {
  if (!markdown) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of markdown.matchAll(PUGH_AUCTION_LINK_RE)) {
    const url = `https://www.pugh-auctions.com/auction/${m[1]}`;
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * Parse the lots straight out of a Pugh auction-EVENT page's markdown. Like the
 * auctionhouse hub, each lot renders inline with its full address + postcode AND
 * the lot URL, so we recover the listing WITHOUT a per-lot detail scrape — and
 * Pugh additionally carries the guide price inline.
 *
 * REAL SHAPE (captured live): each lot is an image link to the lot, a "View
 * Property" link, then the ADDRESS as its own markdown link, then the price:
 *
 *   [![alt](https://asta.btgeddisons….com/…jpg)](https://www.pugh-auctions.com/property/<id>)
 *   [View Property](https://www.pugh-auctions.com/property/<id>)
 *   Multi-Lot Timed Auction
 *   [Land at Bent Street, Newsome, Huddersfield, West Yorkshire HD4 6NX](https://www.pugh-auctions.com/property/<id>)
 *   Guide Price: £130,000 plus
 *
 * PUGH_LOT_LINK_RE anchors on the opening `[` of the ADDRESS link (so it skips the
 * image link — whose text holds a `]` from the inner `![…]` — and "View Property",
 * which carries no postcode). g1 = the address ending in a postcode; g2 = the lot
 * URL; g3 = the lot id. The guide price (when present) is the first
 * `Guide Price: £X` within a bounded window AFTER the address link. The lot image
 * sits just BEFORE the lot id (paired by pughImagesById). Deduped by externalId
 * (a lot can appear twice), stable first-seen order. Pure.
 */
export function parsePughLots(markdown: string): ParsedHubListing[] {
  if (!markdown) {
    return [];
  }
  const out: ParsedHubListing[] = [];
  const seen = new Set<string>();
  const imageById = pughImagesById(markdown);
  for (const match of markdown.matchAll(PUGH_LOT_LINK_RE)) {
    const addressText = match[1] ?? "";
    const lotUrl = match[2] ?? "";
    const id = match[3] ?? "";
    const postcode = firstPostcode(addressText);
    if (!postcode) {
      continue; // no postcode in the link text → not placeable by outcode
    }
    const externalId = `pughauctions-${id}`;
    if (seen.has(externalId)) {
      continue; // a lot can appear twice on the page — first seen wins
    }
    seen.add(externalId);
    const addressRaw = cleanAddress(addressText) || postcode;
    // Guide price: the first labelled £ within a bounded window after the lot link
    // (never a stray £ elsewhere on the page).
    const priceMatch = markdown
      .slice(match.index! + match[0].length, match.index! + match[0].length + 200)
      .match(PUGH_GUIDE_PRICE_RE);
    const pricePence = priceMatch
      ? Number.parseInt(priceMatch[1]!.replace(/,/g, ""), 10) * 100
      : undefined;
    const imageUrl = imageById.get(id);
    out.push({
      externalId,
      sourceUrl: lotUrl,
      addressRaw,
      postcode,
      ...(pricePence !== undefined && Number.isFinite(pricePence) && pricePence > 0
        ? { pricePence }
        : {}),
      ...(imageUrl ? { imageUrl } : {}),
    });
  }
  return out;
}

/**
 * Map Pugh lot id -> its event-page thumbnail image URL. Each lot renders as
 * `[![alt](IMGURL)](…/property/<id>)`, so the image URL sits immediately before
 * its own lot id. Pair each `![…](url)` with the FIRST lot id within a bounded
 * window, keeping only hotlinkable URLs (first seen wins).
 */
function pughImagesById(markdown: string): Map<string, string> {
  const byId = new Map<string, string>();
  for (const m of markdown.matchAll(PUGH_LOT_IMAGE_RE)) {
    const url = m[1] ?? "";
    const id = m[2] ?? "";
    if (id && !byId.has(id) && isHotlinkableImageUrl(url)) {
      byId.set(id, url);
    }
  }
  return byId;
}

/** A Pugh `…/auction/<id>` diary link — g1 = the auction-event id. */
const PUGH_AUCTION_LINK_RE =
  /https?:\/\/www\.pugh-auctions\.com\/auction\/([a-z0-9_]+)/gi;

/**
 * A Pugh lot address link as the event page renders it. g1 = the address TEXT
 * ending in a UK postcode (anchored on the opening `[`, bounded so it never
 * crosses a `[`/`]`/newline — excludes the image-link text + the "View Property"
 * link); g2 = the lot URL; g3 = the lot id.
 */
const PUGH_LOT_LINK_RE =
  /\[([^[\]\n]*?[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\]\((https?:\/\/www\.pugh-auctions\.com\/property\/([a-z0-9_]+))\)/gi;

/** A Pugh `Guide Price: £X` (with optional thousands separators) — g1 = digits. */
const PUGH_GUIDE_PRICE_RE = /guide price:?\s*£\s*([\d,]+)/i;

/**
 * A Pugh `![alt](IMGURL)` image immediately preceding (within a bounded span) a
 * `/property/<id>` lot anchor. g1 = the image URL; g2 = the lot id.
 */
const PUGH_LOT_IMAGE_RE =
  /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)[\s\S]{0,300}?\/property\/([a-z0-9_]+)/gi;

/**
 * Map auctionhouse lot id -> its hub thumbnail image URL. The hub renders each
 * lot as `[![alt](IMGURL)\<newline>ADDR](.../lot/redirect/<id>)`, so the lot's
 * image URL sits a short span BEFORE its own lot id. We pair each `![…](url)`
 * with the FIRST lot id that follows within a bounded window (so it can never
 * bridge to a different lot), keeping only hotlinkable URLs (first seen wins).
 */
function auctionHubImagesById(markdown: string): Map<string, string> {
  const byId = new Map<string, string>();
  for (const m of markdown.matchAll(AUCTION_LOT_IMAGE_RE)) {
    const url = m[1] ?? "";
    const id = m[2] ?? "";
    if (id && !byId.has(id) && isHotlinkableImageUrl(url)) {
      byId.set(id, url);
    }
  }
  return byId;
}

/**
 * A hub `![alt](IMGURL)` image immediately preceding (within a bounded span) a
 * `/lot/redirect/<id>` anchor. g1 = the image URL; g2 = the lot id. The lazy
 * `{0,400}` bridge crosses only the address line between the image and its lot
 * link, never a neighbouring lot.
 */
const AUCTION_LOT_IMAGE_RE =
  /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)[\s\S]{0,400}?\/lot\/redirect\/(\d+)/gi;

/** Any markdown `![alt](https://url)` image — g1 = the URL. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;

/**
 * The FIRST hotlinkable property image URL in a detail page's markdown, or
 * undefined. Used for uklandandfarms detail pages (the auctionhouse hub carries
 * its image inline — see parseAuctionHubListings). Skips data/base64 +
 * off-allowlist artifacts via isHotlinkableImageUrl. Pure.
 */
export function extractImageUrl(markdown: string): string | undefined {
  if (!markdown) {
    return undefined;
  }
  for (const m of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    const url = m[1] ?? "";
    if (isHotlinkableImageUrl(url)) {
      return url;
    }
  }
  return undefined;
}

/** The minimal fields parsed out of a uklandandfarms DETAIL page. */
export interface ParsedDetailListing {
  addressRaw: string;
  postcode?: string;
  pricePence?: number;
}

/**
 * Parse a uklandandfarms DETAIL page's markdown into the minimal listing fields.
 *
 * The property's address + postcode are NOT the first text/postcode on the page:
 * the markdown opens with the site NAV (`[Home](…)`) and then a selling-AGENT
 * contact card carrying the AGENT's OWN office postcode (e.g. a Shropshire/Chester
 * branch). Reading the first markdown line + the first postcode therefore captured
 * the nav link as the address and the AGENT's office as the postcode — so every
 * real North-Wales listing was pruned by the provider's outcode filter (the
 * agent's outcode never matches the target patch). That was the 0-listings bug.
 *
 * The reliable property anchor is the page <title> (`<address>, <postcode> - UKLAF`),
 * with the first postcode-bearing H1 (`# <address>, <postcode>  For Sale …`) as the
 * fallback when the title is missing. Returns null when no usable heading exists.
 * Pure + UNIT-TESTED (the Firecrawl provider is a thin shell that feeds this the
 * scraped markdown + metadata title).
 */
export function parseUklfDetail(
  markdown: string,
  metadataTitle?: string,
): ParsedDetailListing | null {
  const heading = uklfPropertyHeading(markdown ?? "", metadataTitle);
  if (!heading) {
    return null;
  }
  const postcode = firstPostcode(heading);
  const addressRaw = uklfAddressFromHeading(heading);
  if (!addressRaw || addressRaw.length > 300) {
    return null;
  }
  // With a postcode the heading is definitely a real listing. Without one (a
  // postcode-less rural listing OR a generic index/brand <title> that leaked in
  // on a redirect), reject brand fragments + site-index titles so we never store
  // "UKLAF" / "Rural Property For Sale in Wales" as an address.
  if (!postcode && !isPlausibleAddressWithoutPostcode(addressRaw)) {
    return null;
  }
  const pricePence = uklfPrice(markdown ?? "");
  return {
    addressRaw,
    ...(postcode ? { postcode } : {}),
    ...(pricePence !== undefined ? { pricePence } : {}),
  };
}

/**
 * The property heading for a uklandandfarms detail page: the page <title>
 * (whitespace-collapsed, preferred when it carries a postcode), else the first
 * H1 line that carries a postcode, else the bare title (an address without a
 * postcode), else null.
 */
function uklfPropertyHeading(
  markdown: string,
  metadataTitle?: string,
): string | null {
  const title = (metadataTitle ?? "").replace(/\s+/g, " ").trim();
  if (title && POSTCODE_RE.test(title)) {
    return title;
  }
  for (const m of markdown.matchAll(H1_LINE_RE)) {
    const h1 = (m[1] ?? "").replace(/\s+/g, " ").trim();
    if (POSTCODE_RE.test(h1)) {
      return h1;
    }
  }
  return title || null;
}

/**
 * The clean property address from a heading. When the heading carries a postcode,
 * the address is everything up to + including it (dropping a trailing
 * " - UKLAF" site-name suffix or a "  For Sale - Guide Price £…" tail); without a
 * postcode, the bare heading sans the site-name suffix.
 */
function uklfAddressFromHeading(heading: string): string {
  const m = heading.match(POSTCODE_RE);
  if (m && m.index !== undefined) {
    return heading.slice(0, m.index + m[0].length).replace(/\s+/g, " ").trim();
  }
  // No postcode to anchor the cut: drop a trailing site-name suffix joined by
  // any separator (" - UKLAF", " | UKLAF", " - UKLandandFarms…").
  return heading
    .replace(/\s*[-|–—]?\s*UK\s?LandandFarms\b.*$/i, "")
    .replace(/\s*[-|–—]?\s*UK\s?LAF\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * TRUE when a postcode-LESS heading still looks like a real property address
 * (not a brand fragment or a site-index/category title that can leak in when a
 * dead detail URL redirects to the hub). Pure heuristic — only consulted when no
 * postcode anchors the listing.
 */
function isPlausibleAddressWithoutPostcode(addr: string): boolean {
  if (addr.length < 6) {
    return false; // a brand fragment ("UKLAF"), not an address
  }
  if (/\bUK\s?LAF\b|uklandandfarms/i.test(addr)) {
    return false; // the site brand, not an address
  }
  if (/\bfor sale in\b/i.test(addr) || /^(?:country|rural) propert/i.test(addr)) {
    return false; // a region/category INDEX title, not a single listing
  }
  return true;
}

/**
 * The guide/asking price (pence) for a uklandandfarms detail page. The property
 * H1 (`# <address>, <postcode>  For Sale - Guide Price £X`) carries the price, so
 * any £ in an H1 line is the listing price. We do NOT scan the whole body for the
 * first £ — a mortgage-calculator value or a monthly-repayment figure appears
 * before the guide price and would be mis-captured; the body fallback therefore
 * requires a price LABEL. Returns undefined when no price is found.
 */
function uklfPrice(markdown: string): number | undefined {
  for (const m of markdown.matchAll(H1_LINE_RE)) {
    const pence = priceToPence((m[1] ?? "").match(PRICE_RE)?.[1]);
    if (pence !== undefined) {
      return pence;
    }
  }
  return priceToPence(markdown.match(PRICE_LABEL_RE)?.[1]);
}

/** Parse a £ digit string ("1,500,000") to integer pence, or undefined. */
function priceToPence(digits: string | undefined): number | undefined {
  if (digits === undefined) {
    return undefined;
  }
  const pence = Number.parseInt(digits.replace(/,/g, ""), 10) * 100;
  return Number.isFinite(pence) && pence > 0 ? pence : undefined;
}

/**
 * The source image hosts we are willing to HOTLINK from (the listing sites' own
 * domains + their image CDNs). We display these URLs directly in the browser —
 * never download them — so pinning to the source's own hosts keeps the hotlink
 * pointing at the publisher's CDN (no arbitrary third-party URL injection).
 */
const IMAGE_HOST_SUFFIXES = [
  "eigpropertyauctions.co.uk", // auctionhouse lot images (AMS CDN)
  "auctionhouse.co.uk",
  "auctionhouse.uk.net",
  "uklandandfarms.co.uk",
  "pugh-auctions.com", // pugh lot images (own host)
  "btgeddisonspropertyauctions.com", // pugh/BTG-Eddisons lot image CDN (asta.*)
];

/**
 * TRUE for a safe hotlink image URL: an absolute https URL on a known SOURCE
 * host (the allowlist above), length-bounded, rejecting `<…>` / data-URI /
 * base64 placeholder artifacts. Host-allowlist ONLY — we hotlink exclusively
 * from the listing sites' own image hosts (no arbitrary third-party URL), which
 * matches the no-redistribution posture in docs/compliance/listing-sourcing-basis.md.
 * Extend IMAGE_HOST_SUFFIXES when a new source's CDN is confirmed live. Pure.
 */
export function isHotlinkableImageUrl(url: string): boolean {
  if (!url || url.length > 500 || url.includes("<")) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return IMAGE_HOST_SUFFIXES.some(
    (s) => host === s || host.endsWith(`.${s}`),
  );
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
