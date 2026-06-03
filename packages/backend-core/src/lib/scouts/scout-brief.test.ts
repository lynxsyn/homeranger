/**
 * Unit tests for the pure scout-brief helpers (M8). These are NOT
 * coverage-excluded — resolveScoutOutcodes + draftScoutEmail are pure logic and
 * carry the brief's whole behaviour, so they are unit-proven here.
 *
 * Covers:
 *   - resolveScoutOutcodes: region-name resolution, parsed explicit outcodes,
 *     the union of both, dedup + stable order, segment-level region matching,
 *     and unknown/blank → [].
 *   - draftScoutEmail: the full interpolation (location/beds/types/price), the
 *     taste line, the condition/land/auction lines (incl. their absence), the
 *     pence → pounds conversion, and graceful behaviour on an empty brief.
 */
import { describe, expect, it } from "vitest";
import {
  draftScoutEmail,
  resolveScoutOutcodes,
  type ScoutBriefInput,
} from "./scout-brief.js";

describe("resolveScoutOutcodes", () => {
  // resolveScoutOutcodes delegates to the bundled UK index (uk-locations.ts,
  // exhaustively tested there). These assert the delegation + the scout-facing
  // contract: a name/postcode location → its outcodes, UK-wide, deduped, sorted.
  it("resolves a unitary/district NAME to its outcodes (UK-wide)", () => {
    const outcodes = resolveScoutOutcodes("Conwy County");
    expect(outcodes).toContain("LL30");
    expect(outcodes).toContain("LL22");
    // Welsh county name resolves too.
    expect(resolveScoutOutcodes("Anglesey")).toContain("LL58");
  });

  it("resolves a name off a comma/dash-delimited segment", () => {
    // The whole string "Snowdonia, Gwynedd" is not an area, but "Gwynedd" is.
    const outcodes = resolveScoutOutcodes("Snowdonia, Gwynedd");
    expect(outcodes).toContain("LL23");
    expect(outcodes).toContain("LL55");
  });

  it("parses EXPLICIT outcodes out of free text (uppercased, sorted)", () => {
    const outcodes = resolveScoutOutcodes("se16, se1 and EC1A");
    expect(outcodes).toEqual(["EC1A", "SE1", "SE16"]);
  });

  it("unions parsed outcodes with a named area (deduped, sorted)", () => {
    const outcodes = resolveScoutOutcodes("SW1A, Conwy County");
    expect(outcodes).toContain("SW1A"); // the parsed outcode
    expect(outcodes).toContain("LL30"); // the named-area outcodes
    expect([...outcodes].sort()).toEqual(outcodes); // sorted, stable
  });

  it("keeps a parsed outcode once even when a named area also covers it", () => {
    const outcodes = resolveScoutOutcodes("LL30, Conwy County");
    expect(outcodes.filter((c) => c === "LL30")).toHaveLength(1);
  });

  it("returns [] for an unknown location with no parseable outcodes", () => {
    expect(resolveScoutOutcodes("Atlantis")).toEqual([]);
    expect(resolveScoutOutcodes("")).toEqual([]);
    expect(resolveScoutOutcodes("   ")).toEqual([]);
  });
});

function brief(overrides: Partial<ScoutBriefInput> = {}): ScoutBriefInput {
  return {
    location: "",
    types: [],
    condition: [],
    land: [],
    saleMethods: [],
    minBedrooms: null,
    maxPricePence: null,
    keywords: "",
    ...overrides,
  };
}

describe("draftScoutEmail", () => {
  it("interpolates location, beds, joined types and pence→pounds price", () => {
    const email = draftScoutEmail(
      brief({
        location: "Conwy County",
        types: ["Cottage", "Farmhouse", "Barn"],
        minBedrooms: 3,
        maxPricePence: 42_500_000, // £425,000
      }),
    );
    expect(email).toContain(
      "I'm a private buyer searching in Conwy County for a 3+ bedroom cottage, farmhouse or barn, up to £425,000.",
    );
  });

  it("formats a single type without an 'or' and omits beds/price when absent", () => {
    const email = draftScoutEmail(brief({ location: "Bath", types: ["Flat"] }));
    expect(email).toContain("searching in Bath for a flat.");
    expect(email).not.toContain("+ bedroom");
    expect(email).not.toContain("up to");
  });

  it("adds the taste line from keywords when present", () => {
    const email = draftScoutEmail(brief({ keywords: "light, character, a garden" }));
    expect(email).toContain("In short: light, character, a garden");
  });

  it("omits the taste line when keywords are blank", () => {
    expect(draftScoutEmail(brief({ keywords: "   " }))).not.toContain("In short:");
  });

  it("emits the renovation line for Restoration project / Full renovation", () => {
    const reno = draftScoutEmail(brief({ condition: ["Full renovation"] }));
    expect(reno).toContain(
      "I'm glad to take on a renovation or full restoration — condition isn't a barrier.",
    );
    const resto = draftScoutEmail(brief({ condition: ["Restoration project"] }));
    expect(resto).toContain("condition isn't a barrier.");
  });

  it("emits the 'Some updating is fine.' line and not the renovation line", () => {
    const email = draftScoutEmail(brief({ condition: ["Some updating"] }));
    expect(email).toContain("Some updating is fine.");
    expect(email).not.toContain("condition isn't a barrier.");
  });

  it("emits the land line on the chosen terms, joined with 'or'", () => {
    const email = draftScoutEmail(
      brief({
        land: [
          "Land with a building to convert",
          "Buildable land or planning potential",
        ],
      }),
    );
    expect(email).toContain(
      "I'd also consider land with a building to convert, such as a farmhouse or barn, or a plot with planning permission or genuine potential.",
    );
  });

  it("emits the auction line only when Auction is a sale method", () => {
    const withAuction = draftScoutEmail(brief({ saleMethods: ["Auction"] }));
    expect(withAuction).toContain(
      "I follow the auction lots too, so do flag anything coming under the hammer.",
    );
    const privateTreaty = draftScoutEmail(brief({ saleMethods: ["Private treaty"] }));
    expect(privateTreaty).not.toContain("auction lots");
  });

  it("is graceful on a fully empty brief — falls back to 'your area' and 'home'", () => {
    const email = draftScoutEmail(brief());
    expect(email).toContain("searching in your area for a home.");
    expect(email.startsWith("Hello,\n\n")).toBe(true);
    expect(email.endsWith("Many thanks")).toBe(true);
    // No optional paragraphs leak in.
    expect(email).not.toContain("In short:");
    expect(email).not.toContain("condition isn't a barrier.");
    expect(email).not.toContain("I'd also consider");
    expect(email).not.toContain("auction lots");
  });

  it("signs off with the sender's name when one is given", () => {
    expect(draftScoutEmail(brief(), "Bryan").endsWith("Many thanks,\nBryan")).toBe(
      true,
    );
    // No name (null / undefined) → the bare "Many thanks" closing.
    expect(draftScoutEmail(brief(), null).endsWith("Many thanks")).toBe(true);
    expect(draftScoutEmail(brief()).endsWith("Many thanks")).toBe(true);
  });
});
