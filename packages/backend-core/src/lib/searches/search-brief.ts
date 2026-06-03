/**
 * Pure search-brief helpers (M8) — UNIT-COVERED (not coverage-excluded):
 *
 *   - resolveSearchOutcodes(location): the outcodes a search targets, derived
 *     SERVER-SIDE from its free-text `location`. Delegates to the bundled UK
 *     location index (lib/geo/uk-locations.ts): the union of explicit
 *     postcodes/outcodes in the text and any county / unitary / district /
 *     country / town named in it. Deduped, sorted. The search form has NO
 *     outcodes field — this is the only place they come from.
 *
 *   - draftSearchEmail(search): a faithful port of the design's `draftEmail`
 *     (project/app/campaigns.jsx) — the templated first-contact email that
 *     reflects the brief live. Pure, deterministic, and graceful when the brief
 *     is empty. `maxPricePence` is PENCE here (the wire/storage unit); the design
 *     worked in pounds, so we divide by 100 before formatting.
 */
import {
  signatureBlock,
  urgencyLine,
  type ResolvedSender,
} from "@homeranger/shared";
import { resolveLocationToOutcodes } from "../geo/uk-locations.js";

/**
 * Resolve a search's free-text `location` to the set of outcodes it targets.
 * Delegates to the bundled UK location index (lib/geo/uk-locations.ts): the
 * union of explicit postcodes/outcodes in the text and any county / unitary /
 * district / country / town / postcode-area named in it (the whole string AND
 * each comma/dash segment). Deduped + sorted. An unknown / blank location
 * yields `[]` — the caller treats "no outcodes" as "nothing to target", never
 * an error. UK-wide via the index, not the old North-Wales curated seed.
 */
export function resolveSearchOutcodes(location: string): string[] {
  return resolveLocationToOutcodes(location);
}

/** The fields draftSearchEmail reads off a search row (a structural subset). */
export interface SearchBriefInput {
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
 * the first-contact email a search would send: greeting, the "I'm a private buyer
 * searching in {location} for a {beds}{types}{, up to £price}" line, an optional
 * taste line from `keywords`, an optional project-appetite + land + auction
 * paragraph (only the lines the brief opts into), and the closing. Pure,
 * deterministic, and graceful when the brief is empty.
 */
export function draftSearchEmail(
  search: SearchBriefInput,
  sender?: ResolvedSender | null,
): string {
  // `loc` is the first comma/dash-delimited segment; the design uses it as the
  // fallback location when the full string is blank.
  const loc = (search.location || "your area").split(/[,—–-]/)[0]!.trim();
  const locationPhrase = search.location.trim() || loc;

  const types = joinTypes(search.types);
  const beds = search.minBedrooms ? `${search.minBedrooms}+ bedroom ` : "";
  // A non-positive cap is treated as "no cap" — never email an agent "up to £0".
  const price =
    search.maxPricePence != null && search.maxPricePence > 0
      ? `, up to ${formatGbpFromPence(search.maxPricePence)}`
      : "";
  const taste = search.keywords.trim();

  // Project-appetite line, only for a renovation/restoration brief.
  let conditionLine = "";
  if (
    search.condition.includes("Restoration project") ||
    search.condition.includes("Full renovation")
  ) {
    conditionLine =
      "I'm glad to take on a renovation or full restoration — condition isn't a barrier. ";
  } else if (search.condition.includes("Some updating")) {
    conditionLine = "Some updating is fine. ";
  }

  // Land line, only on the terms chosen.
  let landLine = "";
  if (search.land.length > 0) {
    const parts: string[] = [];
    if (search.land.includes("Land with a building to convert")) {
      parts.push("land with a building to convert, such as a farmhouse or barn");
    }
    if (search.land.includes("Buildable land or planning potential")) {
      parts.push("a plot with planning permission or genuine potential");
    }
    if (parts.length > 0) {
      landLine = `I'd also consider ${parts.join(", or ")}. `;
    }
  }

  const auctionLine = search.saleMethods.includes("Auction")
    ? "I follow the auction lots too, so do flag anything coming under the hammer. "
    : "";

  const body = (conditionLine + landLine + auctionLine).trim();

  // The buyer's urgency line REPLACES the default closing sentence; "browsing"
  // or an unset urgency keeps the relaxed default (so an empty profile reads
  // identically to the pre-profile draft).
  const uLine = urgencyLine(sender?.urgency);
  const closing =
    "If anything's coming up that fits — including pre-market or off-portal — " +
    "I'd be glad to hear from you before it reaches the portals." +
    (uLine ? ` ${uLine}` : " Happy to move quickly for the right place.");

  return (
    `Hello,\n\n` +
    `I'm a private buyer searching in ${locationPhrase} for a ${beds}${types}${price}.\n\n` +
    (taste ? `In short: ${taste}\n\n` : "") +
    (body ? `${body}\n\n` : "") +
    `${closing}\n\n` +
    signatureBlock(sender?.name, sender?.phone)
  );
}
