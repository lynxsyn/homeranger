/**
 * Unit tests for the bundled UK location engine (uk-locations.ts) — the offline
 * county/district/region/postcode → outcode index behind scout locations + the
 * location type-ahead. Pure logic over the committed index, so it is unit-proven
 * here (NOT coverage-excluded). The generated data module itself is excluded.
 */
import { describe, expect, it } from "vitest";
import {
  bundledOutcodeCount,
  resolveLocationToOutcodes,
  suggestLocations,
} from "./uk-locations.js";

describe("resolveLocationToOutcodes", () => {
  it("resolves a unitary/district name UK-wide (Conwy ⇒ its 16 outcodes)", () => {
    const out = resolveLocationToOutcodes("Conwy County");
    expect(out).toContain("LL30");
    expect(out).toContain("LL22");
    // The authoritative ONS unitary is broader than the old curated seed of 10.
    expect(out.length).toBeGreaterThanOrEqual(16);
    // The administrative scaffolding word is stripped — "Conwy" == "Conwy County".
    expect(resolveLocationToOutcodes("Conwy")).toEqual(out);
  });

  it("does NOT pollute a county with an unrelated same-named ward", () => {
    // "Anglesey" is the Welsh county (Isle of Anglesey, LL58–78) AND a ward in
    // Burton-upon-Trent (DE14). Resolution must take the county, not union both.
    const out = resolveLocationToOutcodes("Anglesey");
    expect(out).toContain("LL58");
    expect(out).not.toContain("DE14");
    expect(out.every((c) => c.startsWith("LL"))).toBe(true);
  });

  it("resolves ONS comma-suffix + leading-County names typed naturally", () => {
    // ONS names many areas "<Name>, City of" / "<Name>, County of" / leading
    // "County <Name>". An operator types the NATURAL name and saves without
    // picking a suggestion — it must still resolve to the full district.
    expect(resolveLocationToOutcodes("Bristol")).toContain("BS1");
    expect(resolveLocationToOutcodes("Herefordshire")).toContain("HR1");
    expect(resolveLocationToOutcodes("Kingston upon Hull")).toContain("HU1");
    const durham = resolveLocationToOutcodes("Durham");
    expect(durham).toContain("DH1");
    expect(durham.length).toBeGreaterThanOrEqual(30); // the COUNTY, not the village
    expect(resolveLocationToOutcodes("County Durham")).toEqual(durham);
  });

  it("matches a name off a comma/dash-delimited segment", () => {
    // "Snowdonia" is not an admin area, but the "Gwynedd" segment is.
    const out = resolveLocationToOutcodes("Snowdonia, Gwynedd");
    expect(out).toContain("LL23");
    expect(out).toContain("LL55");
  });

  it("parses explicit complete outcodes out of free text (sorted, deduped)", () => {
    expect(resolveLocationToOutcodes("se16, se1 and EC1A")).toEqual([
      "EC1A",
      "SE1",
      "SE16",
    ]);
  });

  it("expands a partial outcode prefix (LL3 ⇒ LL30…LL39)", () => {
    const out = resolveLocationToOutcodes("LL3");
    expect(out).toContain("LL30");
    expect(out).toContain("LL34");
    expect(out.every((c) => c.startsWith("LL3"))).toBe(true);
  });

  it("expands a bare postcode area (LL ⇒ every LL outcode)", () => {
    const out = resolveLocationToOutcodes("LL");
    expect(out).toContain("LL11");
    expect(out).toContain("LL78");
    expect(out.length).toBeGreaterThan(40);
    expect(out.every((c) => c.startsWith("LL"))).toBe(true);
  });

  it("resolves a country to the whole nation", () => {
    const wales = resolveLocationToOutcodes("Wales");
    expect(wales).toContain("CF10");
    expect(wales).toContain("LL30");
    expect(wales.length).toBeGreaterThan(100);
  });

  it("resolves a shire county (admin_county) — Kent ⇒ CT/ME/…", () => {
    const kent = resolveLocationToOutcodes("Kent");
    expect(kent).toContain("CT1");
    expect(kent.length).toBeGreaterThan(40);
  });

  it("unions explicit outcodes with a named area, deduped + sorted", () => {
    const out = resolveLocationToOutcodes("SW1A, Conwy County");
    expect(out).toContain("SW1A");
    expect(out).toContain("LL30");
    // Sorted, stable.
    expect([...out].sort()).toEqual(out);
  });

  it("keeps an outcode once even when also covered by a named area", () => {
    const out = resolveLocationToOutcodes("LL30, Conwy County");
    expect(out.filter((c) => c === "LL30")).toHaveLength(1);
  });

  it("honours an explicit outcode the index does not know (verbatim, not dropped)", () => {
    // A well-formed but unknown outcode (a brand-new district, or a synthetic
    // test code) is kept verbatim rather than silently dropped — but only if it
    // is not a prefix of real outcodes (which would expand instead).
    expect(resolveLocationToOutcodes("Test patch — ZZ7")).toEqual(["ZZ7"]);
    expect(resolveLocationToOutcodes("ZZ7")).toEqual(["ZZ7"]);
  });

  it("returns [] for an unknown location or blank input", () => {
    expect(resolveLocationToOutcodes("Atlantis")).toEqual([]);
    expect(resolveLocationToOutcodes("")).toEqual([]);
    expect(resolveLocationToOutcodes("   ")).toEqual([]);
  });
});

describe("suggestLocations", () => {
  it("ranks the unitary/district above same-prefix towns", () => {
    const s = suggestLocations("Conw");
    expect(s[0]?.label).toBe("Conwy");
    expect(s[0]?.kind).toBe("district");
    expect(s[0]?.outcodes).toContain("LL30");
  });

  it("surfaces the county for a county name", () => {
    const s = suggestLocations("Kent");
    expect(s[0]?.label).toBe("Kent");
    expect(s[0]?.kind).toBe("county");
  });

  it("ranks a major district/county above a same-substring tiny parish", () => {
    // "Durham" must surface County Durham (district, ~34) not the village; the
    // ONS comma-form normalisation makes it an exact match → tops the list.
    const durham = suggestLocations("Durham");
    expect(durham[0]?.kind).toBe("district");
    expect(durham[0]?.outcodes.length).toBeGreaterThanOrEqual(30);
    // "Hull" must lead with Kingston upon Hull (whole-word match) — NOT Solihull
    // (mid-word "hull", a Birmingham district 150mi away) nor the "Hulland" parish.
    const hull = suggestLocations("Hull")[0];
    expect(hull?.kind).toBe("district");
    expect(hull?.label).toContain("Kingston upon Hull");
    // "Bristol" (ONS "Bristol, City of") leads as a district.
    expect(suggestLocations("Bristol")[0]?.kind).toBe("district");
  });

  it("returns a clean, unpolluted county suggestion (no DE14 under Anglesey)", () => {
    const s = suggestLocations("Anglesey");
    expect(s[0]?.label).toBe("Isle of Anglesey");
    expect(s[0]?.outcodes).not.toContain("DE14");
  });

  it("suggests outcodes for a postcode-shaped query", () => {
    const s = suggestLocations("LL3");
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.outcodes.every((c) => c.startsWith("LL3")))).toBe(
      true,
    );
    expect(s.map((x) => x.label)).toContain("LL30");
  });

  it("suggests a town when only a place matches", () => {
    const s = suggestLocations("Llandud");
    expect(s[0]?.label).toBe("Llandudno");
    expect(s[0]?.kind).toBe("place");
  });

  it("respects the limit and returns [] for a blank query", () => {
    expect(suggestLocations("")).toEqual([]);
    expect(suggestLocations("   ")).toEqual([]);
    expect(suggestLocations("Lon", 3).length).toBeLessThanOrEqual(3);
  });

  it("attaches a human hint with the outcode count", () => {
    const s = suggestLocations("Conw");
    expect(s[0]?.hint).toMatch(/District · \d+ outcodes/);
  });

  it("leads with the postcode AREA for a bare area query", () => {
    const s = suggestLocations("LL");
    expect(s[0]?.kind).toBe("area");
    expect(s[0]?.label).toBe("LL");
    expect(s[0]?.hint).toMatch(/Postcode area · \d+ outcodes/);
  });

  it("surfaces a country with a nation hint", () => {
    const s = suggestLocations("Wales");
    expect(s[0]?.kind).toBe("country");
    expect(s[0]?.label).toBe("Wales");
    expect(s[0]?.hint).toMatch(/Wales · \d+ outcodes/);
  });
});

describe("bundledOutcodeCount", () => {
  it("loads the full GB outcode index", () => {
    expect(bundledOutcodeCount()).toBeGreaterThan(3000);
  });
});
