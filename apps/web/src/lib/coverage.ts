/**
 * Coverage rollup — turns an agent's raw covered-outcodes into a human
 * geographic summary for the Agents table. Ported from the claude.ai/design
 * handoff (project/app/agent-data.jsx: OUTCODE_PLACE / placeFor /
 * coverageSummary).
 *
 * Postcode letters (LL, SE, NW) are a sorting code, not a place — so the
 * Coverage cell reads "Gwynedd · 5 outcodes" (a county/region + a count), one
 * fixed-height line, with the town-level breakdown a click away, instead of a
 * wall of chips that grows each row's height with the patch. A single-outcode
 * agent reads as its town + the code.
 *
 * This is purely presentational: the rollup is derived on the client from the
 * outcodes the agents router already returns, so there is no backend twin.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */

/** A coverage list rolled up for display: dominant region + town groups. */
export interface CoverageSummary {
  /** Number of outcodes covered. */
  count: number;
  /** Dominant county/region (most outcodes; first-seen breaks ties), or null. */
  region: string | null;
  /** Every region touched, dominant-first. */
  regions: string[];
  /** Outcodes grouped by town, in first-seen order. */
  groups: Record<string, string[]>;
  /** Towns in first-seen order (the keys of `groups`). */
  towns: string[];
  /** Town → its region. */
  townRegion: Record<string, string>;
  /** The HQ outcode (the first in the list), or null. */
  primary: string | null;
  /** The HQ outcode's town, or null. */
  primaryTown: string | null;
}

/**
 * Outcode → [town, county/region]. Extend as new patches are worked. An unknown
 * outcode falls back to [outcode, its letter-prefix] so the cell still renders.
 */
const OUTCODE_PLACE: Record<string, [string, string]> = {
  // Gwynedd (Snowdonia)
  LL55: ["Caernarfon", "Gwynedd"],
  LL54: ["Caernarfon", "Gwynedd"],
  LL56: ["Y Felinheli", "Gwynedd"],
  LL57: ["Bangor", "Gwynedd"],
  LL49: ["Porthmadog", "Gwynedd"],
  LL51: ["Caernarfon", "Gwynedd"],
  LL48: ["Penrhyndeudraeth", "Gwynedd"],
  LL52: ["Criccieth", "Gwynedd"],
  LL47: ["Harlech", "Gwynedd"],
  LL40: ["Dolgellau", "Gwynedd"],
  LL42: ["Barmouth", "Gwynedd"],
  LL43: ["Talybont", "Gwynedd"],
  LL44: ["Dyffryn Ardudwy", "Gwynedd"],
  LL36: ["Tywyn", "Gwynedd"],
  LL35: ["Aberdyfi", "Gwynedd"],
  LL77: ["Llangefni", "Anglesey"],
  // Powys (Mid Wales)
  SY18: ["Llanidloes", "Powys"],
  SY17: ["Caersws", "Powys"],
  SY19: ["Llanbrynmair", "Powys"],
  SY16: ["Newtown", "Powys"],
  SY20: ["Machynlleth", "Powys"],
  SY21: ["Welshpool", "Powys"],
  SY22: ["Llanfechain", "Powys"],
  SY15: ["Montgomery", "Powys"],
  LD1: ["Llandrindod Wells", "Powys"],
  LD2: ["Builth Wells", "Powys"],
  LD3: ["Brecon", "Powys"],
  LD6: ["Knighton", "Powys"],
  // North London
  NW3: ["Hampstead", "North London"],
  NW6: ["West Hampstead", "North London"],
  NW8: ["St John's Wood", "North London"],
  NW1: ["Camden", "North London"],
  NW5: ["Kentish Town", "North London"],
  NW11: ["Golders Green", "North London"],
  N6: ["Highgate", "North London"],
  N2: ["East Finchley", "North London"],
  N19: ["Archway", "North London"],
  W1: ["Marylebone", "Central London"],
  // South East London
  SE16: ["Bermondsey", "South East London"],
  SE1: ["Southwark", "South East London"],
  SE8: ["Deptford", "South East London"],
  SE15: ["Peckham", "South East London"],
  SE14: ["New Cross", "South East London"],
  SE22: ["East Dulwich", "South East London"],
  SE4: ["Brockley", "South East London"],
  SE5: ["Camberwell", "South East London"],
  SE10: ["Greenwich", "South East London"],
  SE17: ["Walworth", "South East London"],
  SE11: ["Kennington", "South East London"],
};

/** [town, county/region] for an outcode (unknown → [outcode, letter-prefix]). */
export function placeFor(outcode: string): [string, string] {
  const oc = (outcode ?? "").toUpperCase();
  const hit = OUTCODE_PLACE[oc];
  if (hit) {
    return hit;
  }
  const prefix = oc.match(/^[A-Z]+/)?.[0] ?? oc;
  return [oc, prefix];
}

/**
 * Roll a coverage list up to its dominant county/region for the table summary
 * ("Gwynedd · 5 outcodes") and group the outcodes by town for the detail
 * popover — so the cell reads as a place, not a sort code. The first outcode is
 * treated as the HQ (primary); the dominant region is the one with the most
 * outcodes (first-seen breaks ties).
 */
export function coverageSummary(coverage: readonly string[]): CoverageSummary {
  const list = (coverage ?? []).map((o) => o.toUpperCase());
  const regionCount: Record<string, number> = {};
  const regionOrder: string[] = [];
  const groups: Record<string, string[]> = {};
  const towns: string[] = [];
  const townRegion: Record<string, string> = {};

  for (const oc of list) {
    const [town, region] = placeFor(oc);
    if (regionCount[region] == null) {
      regionCount[region] = 0;
      regionOrder.push(region);
    }
    regionCount[region] += 1;
    if (!groups[town]) {
      groups[town] = [];
      towns.push(town);
      townRegion[town] = region;
    }
    groups[town].push(oc);
  }

  // Dominant region = most outcodes; first-seen order breaks ties.
  const regions = [...regionOrder].sort(
    (a, b) => (regionCount[b] ?? 0) - (regionCount[a] ?? 0),
  );
  const region = regions[0] ?? null;
  const primary = list[0] ?? null;
  const primaryTown = primary ? placeFor(primary)[0] : null;

  return {
    count: list.length,
    region,
    regions,
    groups,
    towns,
    townRegion,
    primary,
    primaryTown,
  };
}
