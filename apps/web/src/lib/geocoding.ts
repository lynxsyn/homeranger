/**
 * Client-side UK postcode geocoder for the map view.
 *
 * Resolves postcodes to lat/lng via postcodes.io (free, keyless, UK open data
 * sourced from ONS/OS), caching every hit in localStorage so a postcode is
 * fetched at most once across sessions. Failures degrade silently: an
 * unresolved postcode is simply omitted and its home is not placed on the map.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
export interface LatLng {
  lat: number;
  lng: number;
}

const ENDPOINT = "https://api.postcodes.io/postcodes";
const CACHE_PREFIX = "hs-geo:";
const CHUNK = 100; // postcodes.io bulk cap is 100 per request

/** Canonical form for cache keys + lookups: trimmed, upper-cased, single-spaced. */
export function normalizePostcode(postcode: string): string {
  return postcode.trim().toUpperCase().replace(/\s+/g, " ");
}

function readCache(pc: string): LatLng | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + pc);
    if (!raw) {
      return null;
    }
    const v = JSON.parse(raw) as Partial<LatLng>;
    return typeof v.lat === "number" && typeof v.lng === "number"
      ? { lat: v.lat, lng: v.lng }
      : null;
  } catch {
    return null;
  }
}

function writeCache(pc: string, ll: LatLng): void {
  try {
    localStorage.setItem(CACHE_PREFIX + pc, JSON.stringify(ll));
  } catch {
    /* storage quota / disabled — non-fatal, we just re-fetch next time */
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface BulkResponse {
  result?: Array<{
    query: string;
    result: { latitude: number; longitude: number } | null;
  }> | null;
}

async function fetchBulk(postcodes: string[], out: Map<string, LatLng>): Promise<void> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postcodes }),
    });
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as BulkResponse;
    for (const entry of data.result ?? []) {
      if (entry.result) {
        const pc = normalizePostcode(entry.query);
        const ll: LatLng = { lat: entry.result.latitude, lng: entry.result.longitude };
        out.set(pc, ll);
        writeCache(pc, ll);
      }
    }
  } catch {
    /* network / parse failure — leave these homes unplaced, never throw */
  }
}

/**
 * Resolve a batch of postcodes to coordinates. Input may contain null/blank
 * entries (skipped). Returns a Map keyed by the normalized postcode; a missing
 * key means "couldn't place this one".
 */
export async function geocodePostcodes(
  postcodes: Array<string | null | undefined>,
): Promise<Map<string, LatLng>> {
  const out = new Map<string, LatLng>();

  // Normalize + de-duplicate, dropping blanks (preserves first-seen order).
  const unique = new Set<string>();
  for (const raw of postcodes) {
    if (raw && raw.trim()) {
      unique.add(normalizePostcode(raw));
    }
  }

  // Serve from the localStorage cache; collect the misses for the network.
  const misses: string[] = [];
  for (const pc of unique) {
    const cached = readCache(pc);
    if (cached) {
      out.set(pc, cached);
    } else {
      misses.push(pc);
    }
  }

  for (const batch of chunk(misses, CHUNK)) {
    await fetchBulk(batch, out);
  }

  return out;
}
