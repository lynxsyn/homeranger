/**
 * Build the bundled UK outcode index — the offline, deterministic data behind
 * scout location resolution + autocomplete (no runtime API dependency).
 *
 * INPUT  : scripts/uk-outcodes-list.txt — the canonical list of ~3,120 GB
 *          postcode outcodes (districts). Sourced once from doogal.co.uk's
 *          "Postcode districts" CSV (OGL v3 — ONS Postcode Directory + OS Open
 *          Names). Committed so regeneration is reproducible without doogal.
 * ENRICH : api.postcodes.io/outcodes/{outcode} (MIT; ONS/OS, OGL v3) supplies
 *          the AUTHORITATIVE, CONSISTENT admin fields — admin_district,
 *          admin_county, country, parish, lon/lat. Consistency matters:
 *          LL30/LL31/LL32 ALL return admin_district "Conwy", so typing "Conwy"
 *          resolves to every outcode in that unitary (doogal's per-outcode
 *          locality lists do not surface the unitary consistently).
 * OUTPUT : src/lib/geo/data/uk-outcodes.data.ts — a generated module exporting
 *          UK_OUTCODES_JSON (a single JSON string parsed once at load). Emitted
 *          as a .ts (not a .json) ON PURPOSE: `tsc` compiles it into dist/, so
 *          the data survives the prod image build; a sibling .json would not be
 *          copied to dist and would CrashLoop at runtime.
 *
 * Run:  pnpm --filter @homeranger/backend-core exec tsx scripts/build-uk-outcodes.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface OutcodeRecord {
  /** The outward code, upper-cased — e.g. "LL30". */
  outcode: string;
  /** admin_district names (the unitary/borough/district — primary county term). */
  districts: string[];
  /** admin_county names (often empty for unitary authorities). */
  counties: string[];
  /** Country: England | Scotland | Wales | Northern Ireland (first if multiple). */
  country: string | null;
  /** Civil parish / community names — town-level typeahead terms. */
  places: string[];
  /** Centroid latitude (for future nearest-outcode lookups). */
  lat: number | null;
  /** Centroid longitude. */
  lon: number | null;
}

const LIST_PATH = fileURLToPath(
  new URL("./uk-outcodes-list.txt", import.meta.url),
);
const OUT_PATH = fileURLToPath(
  new URL("../src/lib/geo/data/uk-outcodes.data.ts", import.meta.url),
);
const CONCURRENCY = 16;
const RETRIES = 3;

function dedupe(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = (v ?? "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

async function fetchOutcode(outcode: string): Promise<OutcodeRecord> {
  const url = `https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        // Outcode not in postcodes.io (retired/edge) — keep it so postcode-area
        // matching stays complete; admin fields stay empty.
        return {
          outcode,
          districts: [],
          counties: [],
          country: null,
          places: [],
          lat: null,
          lon: null,
        };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        result: {
          admin_district?: string[];
          admin_county?: string[];
          country?: string[];
          parish?: string[];
          longitude?: number | null;
          latitude?: number | null;
        };
      };
      const r = body.result;
      return {
        outcode,
        districts: dedupe(r.admin_district ?? []),
        counties: dedupe(r.admin_county ?? []),
        country: (r.country ?? [])[0] ?? null,
        places: dedupe(r.parish ?? []),
        lat: typeof r.latitude === "number" ? r.latitude : null,
        lon: typeof r.longitude === "number" ? r.longitude : null,
      };
    } catch (err) {
      if (attempt === RETRIES) {
        throw new Error(`failed ${outcode} after ${RETRIES}: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw new Error(`unreachable ${outcode}`);
}

async function main(): Promise<void> {
  const outcodes = readFileSync(LIST_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => /^[A-Z]{1,2}[0-9R][0-9A-Z]?$/.test(l));
  console.info(`enriching ${outcodes.length} outcodes via postcodes.io…`);

  const records: OutcodeRecord[] = [];
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < outcodes.length) {
      const i = next++;
      records.push(await fetchOutcode(outcodes[i]));
      if (++done % 250 === 0) console.info(`  ${done}/${outcodes.length}`);
    }
  }
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker()),
  );

  records.sort((a, b) => a.outcode.localeCompare(b.outcode));
  const withAdmin = records.filter((r) => r.districts.length > 0).length;
  console.info(`done: ${records.length} outcodes, ${withAdmin} with a district`);

  const header = `/**
 * GENERATED by scripts/build-uk-outcodes.mts — DO NOT EDIT BY HAND.
 *
 * The bundled UK outcode index: every GB postcode outcode with its
 * admin_district / admin_county / country / parish (place) names, sourced from
 * api.postcodes.io (ONS Postcode Directory + OS Open Names, OGL v3). Stored as a
 * single JSON string so tsc compiles it straight into dist/ (a sibling .json
 * would not survive the prod image build) and it parses once at module load.
 *
 * Records: ${records.length}.
 */
export const UK_OUTCODES_JSON =
  ${JSON.stringify(JSON.stringify(records))};
`;
  writeFileSync(OUT_PATH, header, "utf8");
  console.info(`wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
