/**
 * Pure scout-brief helpers (M8) — UNIT-COVERED (not coverage-excluded):
 *
 *   - resolveScoutOutcodes(location): the outcodes a scout targets, derived
 *     SERVER-SIDE from its free-text `location`. The union of (a) explicit
 *     outcodes parsed out of the text and (b) the curated region-name → outcode
 *     map (lib/geo/uk-regions.ts), applied to the whole string AND each
 *     comma/dash-delimited segment. Deduped, stable order. The scout form has NO
 *     outcodes field — this is the only place they come from.
 *
 *   - draftScoutEmail(scout): a faithful port of the design's `draftEmail`
 *     (project/app/campaigns.jsx) — the templated first-contact email that
 *     reflects the brief live. Pure, deterministic, and graceful when the brief
 *     is empty. `maxPricePence` is PENCE here (the wire/storage unit); the design
 *     worked in pounds, so we divide by 100 before formatting.
 */
import { regionToOutcodes } from "../geo/uk-regions.js";

/**
 * A UK outcode: 1–2 letters, 1–2 digits, an optional trailing letter
 * (e.g. SE1, SE16, EC1A, LL30). Word-bounded so it does not grab fragments of
 * longer tokens. Case-insensitive on the way in; we upper-case the captures.
 */
const OUTCODE_PATTERN = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\b/gi;

/** Split a location string into the segments a region name might live in. */
function segmentsOf(location: string): string[] {
  return location
    .split(/[,—–-]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Resolve a scout's free-text `location` to the set of outcodes it targets.
 *
 * Two independent sources, unioned:
 *   1. Explicit outcodes written into the text (uppercased), e.g. "SE16, SE1".
 *   2. Curated region names anywhere in the text — matched against the WHOLE
 *      string and each comma/dash-delimited segment (so "Snowdonia, Gwynedd"
 *      resolves Gwynedd's outcodes off the second segment).
 *
 * The result is deduped with a stable, first-seen order (parsed-outcodes first
 * in text order, then region outcodes in map order). An unknown / blank
 * location yields `[]` — the caller treats "no outcodes" as "nothing to
 * target", never an error.
 */
export function resolveScoutOutcodes(location: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (code: string): void => {
    const value = code.trim().toUpperCase();
    if (value.length > 0 && !seen.has(value)) {
      seen.add(value);
      ordered.push(value);
    }
  };

  // (a) explicit outcodes parsed out of the text (in text order).
  for (const match of location.matchAll(OUTCODE_PATTERN)) {
    add(match[0]);
  }

  // (b) region names — whole string first, then each segment.
  for (const code of regionToOutcodes(location)) {
    add(code);
  }
  for (const segment of segmentsOf(location)) {
    for (const code of regionToOutcodes(segment)) {
      add(code);
    }
  }

  return ordered;
}

/** The fields draftScoutEmail reads off a scout row (a structural subset). */
export interface ScoutBriefInput {
  location: string;
  types: string[];
  condition: string[];
  land: string[];
  saleMethods: string[];
  minBedrooms: number | null;
  maxPricePence: number | null;
  keywords: string;
}

/** Format a pence amount as a whole-pound GBP string, e.g. 42500000 → "£425,000". */
function formatGbpFromPence(pence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(pence / 100);
}

/**
 * Join a list of (lower-cased) type labels into the "a, b or c" phrase the
 * design uses. Empty → "home" (the design's fallback).
 */
function joinTypes(types: string[]): string {
  const list = types.length > 0 ? types.map((t) => t.toLowerCase()) : ["home"];
  if (list.length === 1) {
    return list[0]!;
  }
  return `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]!}`;
}

/**
 * Faithful port of the design's `draftEmail` (project/app/campaigns.jsx). Builds
 * the first-contact email a scout would send: greeting, the "I'm a private buyer
 * searching in {location} for a {beds}{types}{, up to £price}" line, an optional
 * taste line from `keywords`, an optional project-appetite + land + auction
 * paragraph (only the lines the brief opts into), and the closing. Pure,
 * deterministic, and graceful when the brief is empty.
 */
export function draftScoutEmail(scout: ScoutBriefInput): string {
  // `loc` is the first comma/dash-delimited segment; the design uses it as the
  // fallback location when the full string is blank.
  const loc = (scout.location || "your area").split(/[,—–-]/)[0]!.trim();
  const locationPhrase = scout.location.trim() || loc;

  const types = joinTypes(scout.types);
  const beds = scout.minBedrooms ? `${scout.minBedrooms}+ bedroom ` : "";
  // A non-positive cap is treated as "no cap" — never email an agent "up to £0".
  const price =
    scout.maxPricePence != null && scout.maxPricePence > 0
      ? `, up to ${formatGbpFromPence(scout.maxPricePence)}`
      : "";
  const taste = scout.keywords.trim();

  // Project-appetite line, only for a renovation/restoration brief.
  let conditionLine = "";
  if (
    scout.condition.includes("Restoration project") ||
    scout.condition.includes("Full renovation")
  ) {
    conditionLine =
      "I'm glad to take on a renovation or full restoration — condition isn't a barrier. ";
  } else if (scout.condition.includes("Some updating")) {
    conditionLine = "Some updating is fine. ";
  }

  // Land line, only on the terms chosen.
  let landLine = "";
  if (scout.land.length > 0) {
    const parts: string[] = [];
    if (scout.land.includes("Land with a building to convert")) {
      parts.push("land with a building to convert, such as a farmhouse or barn");
    }
    if (scout.land.includes("Buildable land or planning potential")) {
      parts.push("a plot with planning permission or genuine potential");
    }
    if (parts.length > 0) {
      landLine = `I'd also consider ${parts.join(", or ")}. `;
    }
  }

  const auctionLine = scout.saleMethods.includes("Auction")
    ? "I follow the auction lots too, so do flag anything coming under the hammer. "
    : "";

  const body = (conditionLine + landLine + auctionLine).trim();

  return (
    `Hello,\n\n` +
    `I'm a private buyer searching in ${locationPhrase} for a ${beds}${types}${price}.\n\n` +
    (taste ? `In short: ${taste}\n\n` : "") +
    (body ? `${body}\n\n` : "") +
    `If anything's coming up that fits — including pre-market or off-portal — I'd be glad to hear from you before it reaches the portals. Happy to move quickly for the right place.\n\n` +
    `Many thanks`
  );
}
