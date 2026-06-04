/**
 * Coverage rollup — turns an agent's covered outcodes into a human geographic
 * summary for the Agents table, using the bundled UK outcode index so an LL
 * code resolves to "Bangor, Gwynedd" rather than a bare "LL". Computed
 * SERVER-SIDE on purpose: the ~874KB index lives in backend-core and must NOT
 * ship to the browser — the web app consumes only this summary's TYPE via
 * `inferRouterOutputs`, so the index is erased from the SPA bundle (the same
 * pattern as `LocationSuggestion`).
 *
 * The cell reads as a place: a wide patch rolls up to its dominant principal
 * area + a count ("Gwynedd · 5 outcodes"), with the town-by-town breakdown
 * (the HQ / first outcode marked) in the popover; a single-outcode agent reads
 * as its town + the code. Postcode letters are a sorting code, not a place.
 */
import { outcodeRecord, type UkOutcodeRecord } from "./uk-locations.js";

/** A coverage list rolled up for the Agents table cell + its detail popover. */
export interface CoverageSummary {
  /** Number of (deduped) outcodes covered. */
  count: number;
  /** Dominant principal area (most outcodes; first-seen breaks ties), or null. */
  region: string | null;
  /** Every principal area touched, dominant-first. */
  regions: string[];
  /** Outcodes grouped by town, in first-seen order. */
  groups: Record<string, string[]>;
  /** Towns in first-seen order (the keys of `groups`). */
  towns: string[];
  /** The HQ outcode (the first in the list), or null. */
  primary: string | null;
  /** The HQ outcode's town, or null. */
  primaryTown: string | null;
}

/** The postcode area (leading letters) of an outcode — "LL30" → "LL". */
function areaOf(outcode: string): string {
  return outcode.match(/^[A-Z]{1,2}/)?.[0] ?? outcode;
}

/**
 * Strip ONS administrative scaffolding from a place name so it reads as a place,
 * not a record: "Southwark, unparished area" → "Southwark", "Bristol, City of"
 * → "Bristol".
 */
function cleanPlaceName(name: string): string {
  return name
    .replace(/,\s*unparished area$/i, "")
    .replace(/,\s*(?:city|county|borough) of$/i, "")
    .trim();
}

/**
 * The principal area for the chip + rollup label: the county/unitary/district
 * (modern UK records mostly carry the unitary in `districts`, `counties` empty),
 * falling back to country, then the postcode area for an unknown outcode.
 */
function regionFor(rec: UkOutcodeRecord | null, outcode: string): string {
  const region = rec?.counties[0] ?? rec?.districts[0] ?? rec?.country;
  return region ?? areaOf(outcode);
}

/**
 * The town/community for the popover groups + single-outcode display: the first
 * meaningful `places` entry (cleaned of ONS scaffolding), falling back to the
 * district / county / country, then the bare outcode.
 */
function townFor(rec: UkOutcodeRecord | null, outcode: string): string {
  if (rec) {
    for (const place of rec.places) {
      const cleaned = cleanPlaceName(place);
      if (cleaned) {
        return cleaned;
      }
    }
    const fallback = rec.districts[0] ?? rec.counties[0] ?? rec.country;
    if (fallback) {
      return fallback;
    }
  }
  return outcode;
}

/**
 * Roll an agent's covered outcodes up to a place-led summary. The first outcode
 * is treated as the HQ (primary); the dominant region is the principal area with
 * the most outcodes (first-seen order breaks ties). Outcodes are deduped +
 * upper-cased; an unknown outcode degrades to its postcode area / itself rather
 * than being dropped.
 */
export function summariseCoverage(outcodes: readonly string[]): CoverageSummary {
  const list: string[] = [];
  const seen = new Set<string>();
  for (const raw of outcodes ?? []) {
    const oc = raw.trim().toUpperCase();
    if (oc && !seen.has(oc)) {
      seen.add(oc);
      list.push(oc);
    }
  }

  const regionCount: Record<string, number> = {};
  const regionOrder: string[] = [];
  const groups: Record<string, string[]> = {};
  const towns: string[] = [];
  let primaryTown: string | null = null;

  list.forEach((oc, index) => {
    const rec = outcodeRecord(oc);
    const region = regionFor(rec, oc);
    const town = townFor(rec, oc);
    if (regionCount[region] == null) {
      regionCount[region] = 0;
      regionOrder.push(region);
    }
    regionCount[region] += 1;
    if (!groups[town]) {
      groups[town] = [];
      towns.push(town);
    }
    groups[town].push(oc);
    if (index === 0) {
      primaryTown = town;
    }
  });

  const regions = [...regionOrder].sort(
    (a, b) => (regionCount[b] ?? 0) - (regionCount[a] ?? 0),
  );

  return {
    count: list.length,
    region: regions[0] ?? null,
    regions,
    groups,
    towns,
    primary: list[0] ?? null,
    primaryTown,
  };
}
