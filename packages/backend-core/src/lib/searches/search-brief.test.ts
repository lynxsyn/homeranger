/**
 * Unit tests for the pure search-brief helpers (M8). These are NOT
 * coverage-excluded — resolveSearchOutcodes + draftSearchEmail are pure logic and
 * carry the brief's whole behaviour, so they are unit-proven here.
 *
 * Covers:
 *   - resolveSearchOutcodes: region-name resolution, parsed explicit outcodes,
 *     the union of both, dedup + stable order, segment-level region matching,
 *     and unknown/blank → [].
 *   - draftSearchEmail: the full interpolation (location/beds/types/price), the
 *     taste line, the condition/land/auction lines (incl. their absence), the
 *     pence → pounds conversion, and graceful behaviour on an empty brief.
 */
import { describe, expect, it } from "vitest";
import {
  draftSearchEmail,
  resolveSearchOutcodes,
  type SearchBriefInput,
} from "./search-brief.js";

describe("resolveSearchOutcodes", () => {
  // resolveSearchOutcodes delegates to the bundled UK index (uk-locations.ts,
  // exhaustively tested there). These assert the delegation + the search-facing
  // contract: a name/postcode location → its outcodes, UK-wide, deduped, sorted.
  it("resolves a unitary/district NAME to its outcodes (UK-wide)", () => {
    const outcodes = resolveSearchOutcodes("Conwy County");
    expect(outcodes).toContain("LL30");
    expect(outcodes).toContain("LL22");
    // Welsh county name resolves too.
    expect(resolveSearchOutcodes("Anglesey")).toContain("LL58");
  });

  it("resolves a name off a comma/dash-delimited segment", () => {
    // The whole string "Snowdonia, Gwynedd" is not an area, but "Gwynedd" is.
    const outcodes = resolveSearchOutcodes("Snowdonia, Gwynedd");
    expect(outcodes).toContain("LL23");
    expect(outcodes).toContain("LL55");
  });

  it("parses EXPLICIT outcodes out of free text (uppercased, sorted)", () => {
    const outcodes = resolveSearchOutcodes("se16, se1 and EC1A");
    expect(outcodes).toEqual(["EC1A", "SE1", "SE16"]);
  });

  it("unions parsed outcodes with a named area (deduped, sorted)", () => {
    const outcodes = resolveSearchOutcodes("SW1A, Conwy County");
    expect(outcodes).toContain("SW1A"); // the parsed outcode
    expect(outcodes).toContain("LL30"); // the named-area outcodes
    expect([...outcodes].sort()).toEqual(outcodes); // sorted, stable
  });

  it("keeps a parsed outcode once even when a named area also covers it", () => {
    const outcodes = resolveSearchOutcodes("LL30, Conwy County");
    expect(outcodes.filter((c) => c === "LL30")).toHaveLength(1);
  });

  it("returns [] for an unknown location with no parseable outcodes", () => {
    expect(resolveSearchOutcodes("Atlantis")).toEqual([]);
    expect(resolveSearchOutcodes("")).toEqual([]);
    expect(resolveSearchOutcodes("   ")).toEqual([]);
  });
});

function brief(overrides: Partial<SearchBriefInput> = {}): SearchBriefInput {
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

describe("draftSearchEmail", () => {
  it("interpolates location, beds, joined types and pence→pounds price", () => {
    const email = draftSearchEmail(
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
    const email = draftSearchEmail(brief({ location: "Bath", types: ["Flat"] }));
    expect(email).toContain("searching in Bath for a flat.");
    expect(email).not.toContain("+ bedroom");
    expect(email).not.toContain("up to");
  });

  it("adds the taste line from keywords when present", () => {
    const email = draftSearchEmail(brief({ keywords: "light, character, a garden" }));
    expect(email).toContain("In short: light, character, a garden");
  });

  it("omits the taste line when keywords are blank", () => {
    expect(draftSearchEmail(brief({ keywords: "   " }))).not.toContain("In short:");
  });

  it("emits the renovation line for Restoration project / Full renovation", () => {
    const reno = draftSearchEmail(brief({ condition: ["Full renovation"] }));
    expect(reno).toContain(
      "I'm glad to take on a renovation or full restoration — condition isn't a barrier.",
    );
    const resto = draftSearchEmail(brief({ condition: ["Restoration project"] }));
    expect(resto).toContain("condition isn't a barrier.");
  });

  it("emits the 'Some updating is fine.' line and not the renovation line", () => {
    const email = draftSearchEmail(brief({ condition: ["Some updating"] }));
    expect(email).toContain("Some updating is fine.");
    expect(email).not.toContain("condition isn't a barrier.");
  });

  it("emits the land line on the chosen terms, joined with 'or'", () => {
    const email = draftSearchEmail(
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
    const withAuction = draftSearchEmail(brief({ saleMethods: ["Auction"] }));
    expect(withAuction).toContain(
      "I follow the auction lots too, so do flag anything coming under the hammer.",
    );
    const privateTreaty = draftSearchEmail(brief({ saleMethods: ["Private treaty"] }));
    expect(privateTreaty).not.toContain("auction lots");
  });

  it("is graceful on a fully empty brief — falls back to 'your area' and 'home'", () => {
    const email = draftSearchEmail(brief());
    expect(email).toContain("searching in your area for a home.");
    expect(email.startsWith("Hello,\n\n")).toBe(true);
    expect(email.endsWith("Many thanks")).toBe(true);
    // No optional paragraphs leak in.
    expect(email).not.toContain("In short:");
    expect(email).not.toContain("condition isn't a barrier.");
    expect(email).not.toContain("I'd also consider");
    expect(email).not.toContain("auction lots");
  });

  it("signs off with the resolved sender name when one is given", () => {
    expect(
      draftSearchEmail(brief(), { name: "Bryan", phone: null, urgency: null }).endsWith(
        "Many thanks,\nBryan",
      ),
    ).toBe(true);
    // No name (null / undefined) → the bare "Many thanks" closing.
    expect(draftSearchEmail(brief(), null).endsWith("Many thanks")).toBe(true);
    expect(draftSearchEmail(brief()).endsWith("Many thanks")).toBe(true);
  });

  it("appends the buyer's phone to the sign-off when set", () => {
    const email = draftSearchEmail(brief(), {
      name: "Jane Whitfield",
      phone: "07700 900123",
      urgency: null,
    });
    expect(email.endsWith("Many thanks,\nJane Whitfield\n07700 900123")).toBe(true);
  });

  it("injects the urgency line, replacing the default closing sentence", () => {
    const ready = draftSearchEmail(brief(), {
      name: "Jane",
      phone: null,
      urgency: "ready",
    });
    expect(ready).toContain("I'm in a strong position to proceed");
    expect(ready).not.toContain("Happy to move quickly for the right place.");
  });

  it("keeps the relaxed default closing for browsing / unset urgency", () => {
    const browsing = draftSearchEmail(brief(), {
      name: "Jane",
      phone: null,
      urgency: "browsing",
    });
    expect(browsing).toContain("Happy to move quickly for the right place.");
    expect(draftSearchEmail(brief())).toContain(
      "Happy to move quickly for the right place.",
    );
  });
});
