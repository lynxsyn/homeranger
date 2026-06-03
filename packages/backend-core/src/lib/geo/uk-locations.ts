/**
 * UK location resolution + autocomplete — the bundled, offline, deterministic
 * engine behind search locations. Replaces the hand-curated North-Wales seed
 * (the old uk-regions.ts) with a UK-wide index of every GB outcode and its admin
 * areas, sourced once from ONS/OS open data via postcodes.io (see
 * scripts/build-uk-outcodes.mts + data/uk-outcodes.data.ts).
 *
 * Two jobs:
 *   - suggestLocations(query): type-ahead suggestions as the operator types a
 *     search location — counties, unitaries/districts, regions (country), postcode
 *     areas & districts, towns/communities.
 *   - resolveLocationToOutcodes(location): the outcodes a search targets, derived
 *     from its (typed or picked) free-text location. Any of the above inputs
 *     resolve to the right outcodes — typing "Conwy" returns every outcode in the
 *     Conwy unitary, "LL3" the LL3x districts, "Wales" the whole country.
 *
 * Everything is in-memory: the ~3,120-record index loads once at module init
 * into normalised lookup maps. Resolution is a Map hit (<1ms) — no network, no
 * API key, no external service. That is the whole point of the bundled approach.
 *
 * CORRECTNESS NOTE: a name can collide across kinds — "Anglesey" is both the
 * Welsh county (Isle of Anglesey, LL58–78) AND a ward in Burton-upon-Trent
 * (DE14). The index keeps each kind SEPARATE per name and resolution picks the
 * single highest-priority kind (county/district before a far-flung ward), so a
 * county never gets polluted by an unrelated same-named place.
 */
import { UK_OUTCODES_JSON } from "./data/uk-outcodes.data.js";

/** One outcode's admin context, as bundled. */
export interface UkOutcodeRecord {
  outcode: string;
  districts: string[];
  counties: string[];
  country: string | null;
  places: string[];
  lat: number | null;
  lon: number | null;
}

/** What kind of place a suggestion / match is (drives ranking + the hint line). */
export type LocationMatchKind =
  | "outcode" // a single postcode district, e.g. "LL30"
  | "area" // a postcode area, e.g. "LL"
  | "district" // admin_district / unitary / borough
  | "county" // admin_county
  | "country" // England | Scotland | Wales | Northern Ireland
  | "place"; // civil parish / community / town

/** A type-ahead suggestion for the search location field. */
export interface LocationSuggestion {
  /** The label shown + stored as the search location (also the discovery query). */
  label: string;
  kind: LocationMatchKind;
  /** The outcodes this resolves to (sorted, deduped). */
  outcodes: string[];
  /** A short context line, e.g. "Wales · 16 outcodes". */
  hint: string;
}

/** A full/partial postcode or outcode token written into free text. */
const OUTCODE_PATTERN = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\b/gi;
/** A bare postcode area (1–2 letters, no digit) — e.g. "LL", "SW". */
const AREA_PATTERN = /^[A-Z]{1,2}$/;
/** A clean single outcode-ish token (area + at least one digit). */
const OUTCODE_TOKEN = /^[A-Z]{1,2}\d[A-Z0-9]*$/;

/** Lower-case, trim, collapse whitespace. */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Normalise an AREA NAME for matching: drop the administrative scaffolding words
 * ("County", "County Borough", "Council", "City of", "Isle of", …) so the way an
 * operator types a place ("Conwy County", "City of Edinburgh", "Anglesey")
 * matches the way ONS names it ("Conwy", "City of Edinburgh", "Isle of
 * Anglesey"). Applied identically to the index keys AND the query.
 */
function normaliseAreaName(value: string): string {
  let s = normalise(value);
  // ONS comma-suffix forms: "Bristol, City of", "Herefordshire, County of",
  // "Kingston upon Hull, City of" → "bristol" / "herefordshire" / "kingston …".
  s = s.replace(/,\s*(?:city|county|borough) of$/, "");
  // Leading article forms: "City of Edinburgh", "Isle of Anglesey", "County of X".
  s = s.replace(/^(?:city|county|isle) of /, "");
  // Leading bare "County" — "County Durham" → "durham".
  s = s.replace(/^county /, "");
  // Trailing administrative scaffolding.
  s = s.replace(
    / (county borough council|county borough|county council|borough council|district council|unitary authority|county|borough|council|district|unitary)$/,
    "",
  );
  return s.trim();
}

/** The postcode area (leading letters) of an outcode — "LL30" → "LL". */
function areaOf(outcode: string): string {
  const m = outcode.match(/^[A-Z]{1,2}/);
  return m ? m[0] : outcode;
}

interface NamedArea {
  label: string;
  kind: LocationMatchKind;
  outcodes: Set<string>;
}

/** Priority when one normalised name maps to several kinds (higher wins). */
const KIND_PRIORITY: Record<LocationMatchKind, number> = {
  county: 6,
  district: 5,
  country: 4,
  area: 3,
  place: 2,
  outcode: 1,
};

/**
 * Tier for ranking NAME-query suggestions (lower = better). Broad admin areas
 * lead; a small place is tiered far below so a county/district beats a same-
 * substring parish even when the parish prefix-matches and the area only
 * substring-matches. (area/outcode never reach name-query ranking.)
 */
const NAME_QUERY_TIER: Record<LocationMatchKind, number> = {
  county: 0,
  district: 1,
  country: 2,
  place: 10,
  area: 10,
  outcode: 10,
};

const RECORDS: readonly UkOutcodeRecord[] = JSON.parse(
  UK_OUTCODES_JSON,
) as UkOutcodeRecord[];

const BY_OUTCODE = new Map<string, UkOutcodeRecord>();
/** normalised name → its NamedArea per kind (kept SEPARATE — never unioned). */
const NAMED_AREAS = new Map<string, NamedArea[]>();
/** Every known outcode, sorted, for postcode-shaped queries + prefix expansion. */
const ALL_OUTCODES: string[] = [];

function keyFor(label: string, kind: LocationMatchKind): string {
  return kind === "outcode" || kind === "area"
    ? normalise(label)
    : normaliseAreaName(label);
}

(function buildIndex(): void {
  const add = (
    rawLabel: string,
    kind: LocationMatchKind,
    outcode: string,
  ): void => {
    const label = rawLabel.trim();
    if (!label) return;
    // Drop redundant "X, unparished area" place noise — the district covers it.
    if (kind === "place" && /unparished/i.test(label)) return;
    const key = keyFor(label, kind);
    if (!key) return;
    let list = NAMED_AREAS.get(key);
    if (!list) {
      list = [];
      NAMED_AREAS.set(key, list);
    }
    const entry = list.find((a) => a.kind === kind);
    if (entry) entry.outcodes.add(outcode);
    else list.push({ label, kind, outcodes: new Set([outcode]) });
  };

  for (const rec of RECORDS) {
    BY_OUTCODE.set(rec.outcode, rec);
    ALL_OUTCODES.push(rec.outcode);
    add(rec.outcode, "outcode", rec.outcode);
    add(areaOf(rec.outcode), "area", rec.outcode);
    for (const d of rec.districts) add(d, "district", rec.outcode);
    for (const c of rec.counties) add(c, "county", rec.outcode);
    if (rec.country) add(rec.country, "country", rec.outcode);
    for (const p of rec.places) add(p, "place", rec.outcode);
  }
  ALL_OUTCODES.sort();
})();

/** The single highest-priority NamedArea for a normalised key (no cross-union). */
function bestArea(key: string): NamedArea | undefined {
  const list = NAMED_AREAS.get(key);
  if (!list || list.length === 0) return undefined;
  return list.reduce((best, a) =>
    KIND_PRIORITY[a.kind] > KIND_PRIORITY[best.kind] ? a : best,
  );
}

function sortedOutcodes(set: Set<string>): string[] {
  return [...set].sort();
}

function hintFor(area: NamedArea): string {
  const n = area.outcodes.size;
  const unit = n === 1 ? "outcode" : "outcodes";
  switch (area.kind) {
    case "county":
      return `County · ${n} ${unit}`;
    case "district":
      return `District · ${n} ${unit}`;
    case "country":
      return `${area.label} · ${n} ${unit}`;
    case "area":
      return `Postcode area · ${n} ${unit}`;
    case "place":
      return `Town/area · ${n} ${unit}`;
    case "outcode":
      return "Postcode district";
  }
}

function toSuggestion(area: NamedArea): LocationSuggestion {
  return {
    label: area.label,
    kind: area.kind,
    outcodes: sortedOutcodes(area.outcodes),
    hint: hintFor(area),
  };
}

/**
 * Add a single outcode-shaped token to the result set, resolving by intent:
 *   - a KNOWN outcode (LL30) → itself;
 *   - an unknown PREFIX of known outcodes (LL3) → every match (LL30…LL39);
 *   - otherwise → the token VERBATIM, honouring an explicit outcode the index
 *     doesn't know (a brand-new or synthetic district) rather than silently
 *     dropping what the operator typed.
 */
function addOutcodeToken(token: string, out: Set<string>): void {
  if (BY_OUTCODE.has(token)) {
    out.add(token);
    return;
  }
  let expanded = false;
  for (const o of ALL_OUTCODES) {
    if (o.startsWith(token)) {
      out.add(o);
      expanded = true;
    }
  }
  if (!expanded) out.add(token);
}

/**
 * Resolve a free-text location to the set of outcodes it targets. The union of:
 *   (a) every outcode-shaped token in the text — known outcode, prefix-expanded
 *       (LL3 → LL30…LL39), or honoured verbatim if the index doesn't know it;
 *   (b) bare postcode areas (LL → every LL outcode);
 *   (c) named-area matches (county / district / country / town) on the WHOLE
 *       string AND each comma/dash/slash-delimited segment, taking the single
 *       highest-priority kind per name (so a county is never polluted by an
 *       unrelated same-named ward).
 * Deduped, sorted. Unknown / blank → [] (caller treats as "nothing to target").
 */
export function resolveLocationToOutcodes(location: string): string[] {
  const out = new Set<string>();

  // (a) every outcode-shaped token anywhere in the text.
  for (const m of location.matchAll(OUTCODE_PATTERN)) {
    addOutcodeToken(m[0].toUpperCase(), out);
  }

  const consider = (segment: string): void => {
    const trimmed = segment.trim();
    if (!trimmed) return;
    const up = trimmed.toUpperCase();
    // (b) bare postcode area, e.g. "LL".
    if (AREA_PATTERN.test(up)) {
      const area = bestArea(normalise(up));
      if (area) for (const c of area.outcodes) out.add(c);
      return;
    }
    // An outcode token was already handled in (a).
    if (OUTCODE_TOKEN.test(up)) return;
    // (c) named area — highest-priority kind for the name.
    const named =
      bestArea(normaliseAreaName(trimmed)) ?? bestArea(normalise(trimmed));
    if (named) for (const c of named.outcodes) out.add(c);
  };

  consider(location);
  for (const segment of location.split(/[,—–/]/)) consider(segment);

  return [...out].sort();
}

/**
 * Type-ahead suggestions for a search location query. Postcode-shaped queries
 * surface matching outcodes + the area; name queries surface counties /
 * districts / countries / towns, ranked exact → prefix → substring, then by kind
 * (broad admin areas before towns). One suggestion per distinct name (its
 * highest-priority kind). Capped at `limit` (default 8).
 */
export function suggestLocations(
  query: string,
  limit = 8,
): LocationSuggestion[] {
  const q = normalise(query);
  if (q.length === 0) return [];
  const upper = query.trim().toUpperCase();

  // Postcode-shaped query → area + outcode suggestions by prefix.
  if (/^[A-Z]{1,2}\d/.test(upper) || AREA_PATTERN.test(upper)) {
    const results: LocationSuggestion[] = [];
    if (AREA_PATTERN.test(upper)) {
      const area = bestArea(normalise(upper));
      if (area && area.kind === "area") results.push(toSuggestion(area));
    }
    for (const code of ALL_OUTCODES.filter((o) => o.startsWith(upper))) {
      const named = bestArea(normalise(code));
      if (named) results.push(toSuggestion(named));
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }

  // Name query → rank named areas by match quality, with a STRONG kind tier so a
  // major county/district outranks a tiny same-substring parish (e.g. "Durham"
  // surfaces County Durham, not the village; "Hull" surfaces Kingston upon Hull,
  // not "Hulland"). An EXACT match always wins regardless of kind; for non-exact
  // matches the kind tier dominates the prefix-vs-substring gap.
  const qa = normaliseAreaName(query);
  // Whole-word match bonus: "Kingston upon Hull" (word "hull") must beat
  // "Solihull" (mid-word "hull") when both only substring-match. Built once.
  const wordRe = new RegExp(`(^|\\s)${qa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const scored: { s: LocationSuggestion; rank: number }[] = [];
  for (const key of NAMED_AREAS.keys()) {
    const area = bestArea(key);
    if (!area || area.kind === "outcode" || area.kind === "area") continue;
    const label = normalise(area.label);
    let matchRank: number;
    if (key === qa || label === q) matchRank = 0;
    else if (key.startsWith(qa) || label.startsWith(q)) matchRank = 1;
    else if (key.includes(qa)) matchRank = 2;
    else continue;
    const tier = NAME_QUERY_TIER[area.kind];
    const wordPenalty =
      matchRank === 0 || wordRe.test(key) || wordRe.test(label) ? 0 : 5;
    const rank =
      matchRank === 0 ? tier : 100 + tier * 10 + wordPenalty + matchRank;
    scored.push({ s: toSuggestion(area), rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.s.label.length - b.s.label.length ||
      a.s.label.localeCompare(b.s.label),
  );
  return scored.slice(0, limit).map((x) => x.s);
}

/** Total bundled outcode count — exposed for diagnostics / tests. */
export function bundledOutcodeCount(): number {
  return RECORDS.length;
}
