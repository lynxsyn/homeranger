import { describe, expect, it } from "vitest";
import {
  regionToOutcodes,
  supportedRegionNames,
  isSupportedRegion,
} from "./uk-regions.js";

describe("regionToOutcodes", () => {
  it("resolves Conwy County to its LL outcodes", () => {
    const outcodes = regionToOutcodes("Conwy County");
    expect(outcodes).toContain("LL30"); // Llandudno
    expect(outcodes).toContain("LL32"); // Conwy
    expect(outcodes.length).toBeGreaterThan(3);
    // Outcodes are upper-cased, de-duplicated.
    expect(new Set(outcodes).size).toBe(outcodes.length);
    expect(outcodes.every((o) => o === o.toUpperCase())).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(regionToOutcodes("  conwy   county ")).toEqual(
      regionToOutcodes("Conwy County"),
    );
    // A bare 'Conwy' alias resolves too.
    expect(regionToOutcodes("conwy")).toEqual(regionToOutcodes("Conwy County"));
  });

  it("returns [] for an unknown region (no throw)", () => {
    expect(regionToOutcodes("Atlantis")).toEqual([]);
    expect(regionToOutcodes("")).toEqual([]);
  });
});

describe("supportedRegionNames / isSupportedRegion", () => {
  it("lists canonical region names including Conwy County", () => {
    const names = supportedRegionNames();
    expect(names).toContain("Conwy County");
    expect(names.length).toBeGreaterThan(1);
    // Sorted, unique.
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
  });

  it("isSupportedRegion matches case-insensitively", () => {
    expect(isSupportedRegion("Conwy County")).toBe(true);
    expect(isSupportedRegion("conwy")).toBe(true);
    expect(isSupportedRegion("Atlantis")).toBe(false);
  });
});
