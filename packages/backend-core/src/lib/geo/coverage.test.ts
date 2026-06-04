/**
 * summariseCoverage unit tests — the place-led rollup behind the Agents
 * Coverage cell, resolved against the bundled UK outcode index (so this asserts
 * against REAL data: LL57 → Bangor / Gwynedd).
 */
import { describe, expect, it } from "vitest";
import { summariseCoverage } from "./coverage.js";

describe("summariseCoverage", () => {
  it("rolls a Welsh patch up to its principal area + real place names", () => {
    const s = summariseCoverage(["LL57", "LL55", "LL49"]);
    expect(s.count).toBe(3);
    // The chip reads as the principal area (the Gwynedd unitary), not "LL".
    expect(s.region).toBe("Gwynedd");
    expect(s.regions).toEqual(["Gwynedd"]);
    expect(s.primary).toBe("LL57");
    // Each outcode resolves to a real place (not a bare postcode) and is its
    // own town group; LL57's lead place is Bangor.
    expect(s.primaryTown).toBe("Bangor");
    expect(s.towns).toHaveLength(3);
    expect(s.groups.Bangor).toEqual(["LL57"]);
    for (const town of s.towns) {
      expect(town).not.toMatch(/^LL\d/); // a place name, not a postcode
    }
  });

  it("cleans ONS 'unparished area' suffixes off the town name", () => {
    const s = summariseCoverage(["SE16"]);
    expect(s.count).toBe(1);
    expect(s.primaryTown).not.toBeNull();
    expect(s.primaryTown).not.toMatch(/unparished/i);
    // SE16's record carries Southwark/Lewisham as the principal area.
    expect(s.region).not.toBeNull();
  });

  it("picks the dominant region by outcode count", () => {
    // 2 × Gwynedd + 1 unknown → Gwynedd dominates.
    const s = summariseCoverage(["LL57", "LL55", "ZZ9"]);
    expect(s.region).toBe("Gwynedd");
    expect(s.regions[0]).toBe("Gwynedd");
    expect(s.regions).toContain("ZZ");
  });

  it("falls back to the district as the town when the record has no places", () => {
    // EH1 (central Edinburgh) carries the City of Edinburgh district but an
    // empty parish/places list → the town label falls back to the district.
    const s = summariseCoverage(["EH1"]);
    expect(s.region).toBe("City of Edinburgh");
    expect(s.primaryTown).toBe("City of Edinburgh");
  });

  it("falls back to the postcode area + bare code for an unknown outcode", () => {
    const s = summariseCoverage(["ZZ9"]);
    expect(s.region).toBe("ZZ");
    expect(s.primaryTown).toBe("ZZ9");
    expect(s.groups.ZZ9).toEqual(["ZZ9"]);
  });

  it("dedupes and upper-cases the outcodes", () => {
    const s = summariseCoverage(["ll57", "LL57", " ll57 "]);
    expect(s.count).toBe(1);
    expect(s.primary).toBe("LL57");
  });

  it("handles an empty list", () => {
    const s = summariseCoverage([]);
    expect(s.count).toBe(0);
    expect(s.region).toBeNull();
    expect(s.regions).toEqual([]);
    expect(s.primary).toBeNull();
    expect(s.primaryTown).toBeNull();
    expect(s.towns).toEqual([]);
  });
});
