/**
 * coverage helper unit tests — the pure rollup logic behind the Agents
 * Coverage cell: outcode→place mapping + the dominant-region/town-group
 * summary. No DOM, no React; just the data transform.
 */
import { describe, expect, it } from "vitest";
import { coverageSummary, placeFor } from "./coverage";

describe("placeFor", () => {
  it("maps a known outcode to [town, region]", () => {
    expect(placeFor("LL55")).toEqual(["Caernarfon", "Gwynedd"]);
    expect(placeFor("SE16")).toEqual(["Bermondsey", "South East London"]);
    expect(placeFor("NW3")).toEqual(["Hampstead", "North London"]);
  });

  it("is case-insensitive", () => {
    expect(placeFor("se16")).toEqual(["Bermondsey", "South East London"]);
  });

  it("falls back to [outcode, letter-prefix] for an unknown outcode", () => {
    expect(placeFor("ZZ9")).toEqual(["ZZ9", "ZZ"]);
    expect(placeFor("DEMO1")).toEqual(["DEMO1", "DEMO"]);
  });
});

describe("coverageSummary", () => {
  it("rolls a multi-outcode patch up to its dominant region with a count", () => {
    const s = coverageSummary(["LL55", "LL54", "LL49"]);
    expect(s.count).toBe(3);
    expect(s.region).toBe("Gwynedd");
    expect(s.primary).toBe("LL55");
    expect(s.primaryTown).toBe("Caernarfon");
  });

  it("groups outcodes by town in first-seen order and tracks the primary (HQ)", () => {
    // Caernarfon (LL55) · Porthmadog (LL49) · Caernarfon again (LL51)
    const s = coverageSummary(["LL55", "LL49", "LL51"]);
    expect(s.towns).toEqual(["Caernarfon", "Porthmadog"]);
    expect(s.groups.Caernarfon).toEqual(["LL55", "LL51"]);
    expect(s.groups.Porthmadog).toEqual(["LL49"]);
    expect(s.primary).toBe("LL55");
    expect(s.townRegion.Caernarfon).toBe("Gwynedd");
  });

  it("picks the dominant region by outcode count, dominant-first", () => {
    // 2 × South East London (SE1, SE16) + 1 unknown (DEMO1 → region "DEMO")
    const s = coverageSummary(["SE1", "SE16", "DEMO1"]);
    expect(s.count).toBe(3);
    expect(s.region).toBe("South East London");
    expect(s.regions[0]).toBe("South East London");
    expect(s.regions).toContain("DEMO");
  });

  it("upper-cases outcodes and treats a single outcode as count 1", () => {
    const s = coverageSummary(["se16"]);
    expect(s.count).toBe(1);
    expect(s.primary).toBe("SE16");
    expect(s.primaryTown).toBe("Bermondsey");
    expect(s.region).toBe("South East London");
  });

  it("handles an empty list", () => {
    const s = coverageSummary([]);
    expect(s.count).toBe(0);
    expect(s.region).toBeNull();
    expect(s.primary).toBeNull();
    expect(s.primaryTown).toBeNull();
    expect(s.towns).toEqual([]);
  });
});
