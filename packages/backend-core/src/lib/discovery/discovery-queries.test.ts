/**
 * Unit tests for the pure discovery-recall helpers (M7 recall improvement).
 * These are NOT coverage-excluded — buildDiscoveryQueries / extractEmails /
 * agencyNameFrom / hostnameOf / dedupeByEmail carry the whole recall behaviour
 * (the Firecrawl provider is a thin operator-proven shell over them), so they
 * are unit-proven here.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_QUERIES,
  agencyNameFrom,
  buildDiscoveryQueries,
  dedupeByEmail,
  extractEmails,
  hostnameOf,
  isLikelyAgencyEmail,
  isNonAgencyResult,
} from "./discovery-queries.js";

describe("buildDiscoveryQueries", () => {
  it("fans out a region into estate/letting/independent queries + per-outcode", () => {
    const queries = buildDiscoveryQueries("Conwy County", ["LL30", "LL31"]);
    expect(queries).toEqual([
      "estate agents in Conwy County, UK",
      "letting agents in Conwy County, UK",
      "independent estate agents Conwy County UK",
      "estate agents LL30 UK",
      "estate agents LL31 UK",
    ]);
  });

  it("upper-cases the per-outcode queries", () => {
    const queries = buildDiscoveryQueries("Bath", ["ba1"]);
    expect(queries).toContain("estate agents BA1 UK");
  });

  it("caps the fan-out at maxQueries (region queries first)", () => {
    const queries = buildDiscoveryQueries(
      "Conwy County",
      ["LL30", "LL31", "LL32", "LL33", "LL34"],
      { maxQueries: 4 },
    );
    expect(queries).toHaveLength(4);
    expect(queries).toEqual([
      "estate agents in Conwy County, UK",
      "letting agents in Conwy County, UK",
      "independent estate agents Conwy County UK",
      "estate agents LL30 UK",
    ]);
  });

  it("defaults the cap to DEFAULT_MAX_QUERIES (~6)", () => {
    const queries = buildDiscoveryQueries("Conwy County", [
      "LL30",
      "LL31",
      "LL32",
      "LL33",
      "LL34",
      "LL35",
    ]);
    expect(queries).toHaveLength(DEFAULT_MAX_QUERIES);
    expect(DEFAULT_MAX_QUERIES).toBe(6);
  });

  it("clamps a zero/negative/NaN maxQueries to at least 1", () => {
    expect(buildDiscoveryQueries("Bath", ["BA1"], { maxQueries: 0 })).toEqual([
      "estate agents in Bath, UK",
    ]);
    expect(buildDiscoveryQueries("Bath", ["BA1"], { maxQueries: -5 })).toHaveLength(
      1,
    );
    expect(
      buildDiscoveryQueries("Bath", ["BA1"], { maxQueries: Number.NaN }),
    ).toHaveLength(4); // NaN → default 6, but only 4 candidates exist
  });

  it("falls back to outcode-only queries when the region is blank", () => {
    expect(buildDiscoveryQueries("   ", ["LL30", "LL31"])).toEqual([
      "estate agents LL30 UK",
      "estate agents LL31 UK",
    ]);
    expect(buildDiscoveryQueries("", ["LL30"])).toEqual(["estate agents LL30 UK"]);
  });

  it("dedups case-insensitively and skips blank outcodes", () => {
    const queries = buildDiscoveryQueries("Bath", ["BA1", " ba1 ", "", "BA2"]);
    expect(queries).toEqual([
      "estate agents in Bath, UK",
      "letting agents in Bath, UK",
      "independent estate agents Bath UK",
      "estate agents BA1 UK",
      "estate agents BA2 UK",
    ]);
  });

  it("never emits an empty query (blank region AND no usable outcodes)", () => {
    expect(buildDiscoveryQueries("", ["", "   "])).toEqual([]);
    expect(buildDiscoveryQueries("   ", [])).toEqual([]);
    expect(buildDiscoveryQueries("", [])).toEqual([]);
  });

  it("trims the region before interpolating", () => {
    expect(buildDiscoveryQueries("  Conwy County  ", [])).toEqual([
      "estate agents in Conwy County, UK",
      "letting agents in Conwy County, UK",
      "independent estate agents Conwy County UK",
    ]);
  });
});

describe("extractEmails", () => {
  it("extracts, lower-cases and dedups emails (stable first-seen order)", () => {
    const text =
      "Contact Info@Agency.co.uk or SALES@agency.co.uk, also info@agency.co.uk again.";
    expect(extractEmails(text)).toEqual([
      "info@agency.co.uk",
      "sales@agency.co.uk",
    ]);
  });

  it("returns [] for empty/whitespace text with no emails", () => {
    expect(extractEmails("")).toEqual([]);
    expect(extractEmails("no addresses here at all")).toEqual([]);
  });

  it("drops absurdly long matches (page noise, not a real address)", () => {
    const longLocal = "a".repeat(300);
    expect(extractEmails(`${longLocal}@agency.co.uk info@agency.co.uk`)).toEqual([
      "info@agency.co.uk",
    ]);
  });

  it("drops asset-filename noise mis-parsed as addresses", () => {
    const text = "logo@2x.png sprite@3x.jpg icon@2x.svg real@agency.co.uk";
    expect(extractEmails(text)).toEqual(["real@agency.co.uk"]);
  });

  it("strips a phone number fused onto the local part (collapsed-PDF artifact)", () => {
    // "Tel 01492 640415 llanrwst@bobparry..." / "543111info@..." collapse to a
    // phone-prefixed local part on directory PDFs — drop the leading digit run.
    const text =
      "543111info@wilsonslettings.co.uk 01492640415llanrwst@bobparry.co.uk 545665sales@wynnedavies.co.uk";
    expect(extractEmails(text)).toEqual([
      "info@wilsonslettings.co.uk",
      "llanrwst@bobparry.co.uk",
      "sales@wynnedavies.co.uk",
    ]);
  });

  it("leaves a short or all-digit local part untouched (not a phone prefix)", () => {
    // <5 leading digits, or all-digits with no trailing letter, are valid locals.
    expect(extractEmails("2024team@agency.co.uk")).toEqual([
      "2024team@agency.co.uk",
    ]);
    expect(extractEmails("12345@agency.co.uk")).toEqual(["12345@agency.co.uk"]);
  });
});

describe("hostnameOf", () => {
  it("returns the lower-cased hostname of a URL", () => {
    expect(hostnameOf("https://WWW.Agency.CO.uk/contact")).toBe("www.agency.co.uk");
  });

  it("returns undefined for a missing or unparseable URL", () => {
    expect(hostnameOf(undefined)).toBeUndefined();
    expect(hostnameOf("")).toBeUndefined();
    expect(hostnameOf("not a url")).toBeUndefined();
  });
});

describe("agencyNameFrom", () => {
  it("prefers the title, then metadata.title, then hostname, then a fallback", () => {
    expect(
      agencyNameFrom({ title: "Fletcher & Poole", url: "https://fp.com" }),
    ).toBe("Fletcher & Poole");
    expect(
      agencyNameFrom({ metadata: { title: "Meta Agency" }, url: "https://m.com" }),
    ).toBe("Meta Agency");
    expect(agencyNameFrom({ url: "https://agency.co.uk/contact" })).toBe(
      "agency.co.uk",
    );
    expect(agencyNameFrom({})).toBe("Unknown agency");
  });

  it("ignores a blank/whitespace title and falls through", () => {
    expect(
      agencyNameFrom({ title: "   ", metadata: { title: "Meta" } }),
    ).toBe("Meta");
    expect(agencyNameFrom({ title: "  ", url: "https://h.co.uk" })).toBe("h.co.uk");
  });

  it("rejects a directory/document title (council PDF, managing-agents index) → hostname", () => {
    // The bug: a directory page's title got stamped on every email it yielded.
    expect(
      agencyNameFrom({
        title: "[PDF] Main Housing Landlord Details - Conwy County Borough Council",
        url: "https://www.conwy.gov.uk/x.pdf",
      }),
    ).toBe("www.conwy.gov.uk");
    expect(
      agencyNameFrom({
        title: "Managing agents | The Crown Estate",
        url: "https://thecrownestate.co.uk/agents",
      }),
    ).toBe("thecrownestate.co.uk");
  });
});

describe("isNonAgencyResult", () => {
  it("flags a council / social-housing / directory page", () => {
    expect(
      isNonAgencyResult({
        title: "[PDF] Main Housing Landlord Details - Conwy County Borough Council",
        url: "https://www.conwy.gov.uk/.../Main-Housing-Landlord-Details.pdf",
      }),
    ).toBe(true);
    expect(isNonAgencyResult({ url: "https://denbighshire.gov.uk/housing" })).toBe(
      true,
    ); // any .gov.uk host
    expect(
      isNonAgencyResult({ title: "Managing agents | The Crown Estate" }),
    ).toBe(true);
    expect(
      isNonAgencyResult({ title: "North Wales Housing Association — homes to rent" }),
    ).toBe(true);
  });

  it("does NOT flag a normal single estate-agency result", () => {
    expect(
      isNonAgencyResult({
        title: "Fletcher & Poole — Estate Agents in Conwy",
        url: "https://www.fletcherandpoole.co.uk/",
      }),
    ).toBe(false);
    expect(
      isNonAgencyResult({ title: "Wynne Davies Estate Agents | Rhos On Sea" }),
    ).toBe(false);
  });
});

describe("isLikelyAgencyEmail", () => {
  it("rejects local-authority (.gov.uk) addresses", () => {
    expect(isLikelyAgencyEmail("housingsolutions@conwy.gov.uk")).toBe(false);
    expect(isLikelyAgencyEmail("info@gov.uk")).toBe(false);
  });

  it("accepts a normal agency address + rejects a malformed one", () => {
    expect(isLikelyAgencyEmail("sales@wynnedavies.co.uk")).toBe(true);
    expect(isLikelyAgencyEmail("post@grwpcynefin.org")).toBe(true); // type-filter is gov.uk only; page-skip catches housing assocs
    expect(isLikelyAgencyEmail("no-at-sign")).toBe(false);
  });
});

describe("dedupeByEmail", () => {
  it("lower-cases + trims emails and keeps the FIRST (richer) record", () => {
    const result = dedupeByEmail([
      { email: " Info@Agency.co.uk ", agencyName: "Agency", websiteUrl: "https://a" },
      { email: "info@agency.co.uk", agencyName: "Agency (bare)" },
    ]);
    expect(result).toEqual([
      { email: "info@agency.co.uk", agencyName: "Agency", websiteUrl: "https://a" },
    ]);
  });

  it("drops malformed addresses (no local-part / no domain / no dot)", () => {
    const result = dedupeByEmail([
      { email: "info@agency.co.uk", agencyName: "OK" },
      { email: "not-an-email", agencyName: "Broken" },
      { email: "@leading.com", agencyName: "No local" },
      { email: "x@nodot", agencyName: "No dot" },
      { email: "trailing@", agencyName: "No domain" },
    ]);
    expect(result).toEqual([{ email: "info@agency.co.uk", agencyName: "OK" }]);
  });

  it("returns [] for an empty input", () => {
    expect(dedupeByEmail([])).toEqual([]);
  });
});
