/**
 * UK region-name → postcode-outcode map (M7). The operator picks a region by
 * NAME (e.g. "Conwy County"); this resolves the outcodes used to target agent
 * discovery + outreach. CURATED + extensible by design — adding a region is a
 * data edit here, not a code change. Not exhaustive: seeded with the regions the
 * operator cares about (North Wales coast to start, incl. Conwy County).
 *
 * Each entry has a canonical `name`, optional `aliases` (so "Conwy" resolves to
 * "Conwy County"), and the `outcodes` (postcode-area prefixes) covering it.
 * Outcodes are curated from the postcode districts of each county; partial-county
 * districts are included where the bulk of the district falls in the region.
 */
export interface UkRegion {
  name: string;
  aliases?: string[];
  outcodes: string[];
}

const UK_REGIONS: readonly UkRegion[] = [
  {
    name: "Conwy County",
    aliases: ["Conwy", "Conwy County Borough"],
    // Llandudno/Colwyn Bay/Conwy/Llanrwst districts + Abergele (shared LL22).
    outcodes: ["LL22", "LL26", "LL27", "LL28", "LL29", "LL30", "LL31", "LL32", "LL33", "LL34"],
  },
  {
    name: "Gwynedd",
    aliases: ["Gwynedd County"],
    outcodes: ["LL23", "LL24", "LL25", "LL35", "LL36", "LL37", "LL38", "LL39", "LL40", "LL41", "LL42", "LL43", "LL44", "LL45", "LL46", "LL47", "LL48", "LL49", "LL51", "LL52", "LL53", "LL54", "LL55", "LL56", "LL57"],
  },
  {
    name: "Isle of Anglesey",
    aliases: ["Anglesey", "Ynys Mon"],
    outcodes: ["LL58", "LL59", "LL60", "LL61", "LL62", "LL63", "LL64", "LL65", "LL66", "LL67", "LL68", "LL69", "LL70", "LL71", "LL72", "LL73", "LL74", "LL75", "LL76", "LL77", "LL78"],
  },
  {
    name: "Denbighshire",
    aliases: ["Denbighshire County", "Sir Ddinbych"],
    outcodes: ["LL15", "LL16", "LL17", "LL18", "LL19", "LL20", "LL21"],
  },
];

/** Normalise a region name for matching: trim, lower-case, collapse whitespace. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// name (canonical + aliases, normalised) → the canonical region.
const REGION_INDEX: ReadonlyMap<string, UkRegion> = (() => {
  const index = new Map<string, UkRegion>();
  for (const region of UK_REGIONS) {
    index.set(normalise(region.name), region);
    for (const alias of region.aliases ?? []) {
      index.set(normalise(alias), region);
    }
  }
  return index;
})();

/**
 * Resolve a region name (canonical or alias, case/space-insensitive) to its
 * outcodes. Returns [] for an unknown/blank region (the caller treats an empty
 * region as "nothing to target", never an error).
 */
export function regionToOutcodes(name: string): string[] {
  const region = REGION_INDEX.get(normalise(name));
  return region ? [...region.outcodes] : [];
}

/** Whether a region name (canonical or alias) is supported. */
export function isSupportedRegion(name: string): boolean {
  return REGION_INDEX.has(normalise(name));
}

/** The canonical region names, sorted — for the scout region picker (M8). */
export function supportedRegionNames(): string[] {
  return UK_REGIONS.map((r) => r.name).sort();
}
