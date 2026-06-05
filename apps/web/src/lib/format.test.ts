import { describe, expect, it } from "vitest";
import {
  ageHoursSince,
  gbp,
  humanizePropertyType,
  penceToPounds,
  prettyAddress,
  relativeTime,
} from "./format";

describe("prettyAddress", () => {
  it("title-cases an ALL CAPS address but keeps UK postcode tokens uppercase", () => {
    expect(prettyAddress("RIVINGTON STREET SE1")).toBe("Rivington Street SE1");
    expect(prettyAddress("23 DEGANWY AVENUE LLANDUDNO LL30 2YB")).toBe(
      "23 Deganwy Avenue Llandudno LL30 2YB",
    );
  });

  it("title-cases an all-lowercase address (the seeded/dedup form)", () => {
    expect(prettyAddress("pre market flat se1")).toBe("Pre Market Flat SE1");
  });

  it("keeps hyphenated place names readable", () => {
    expect(prettyAddress("STOKE-ON-TRENT ST1 1AA")).toBe(
      "Stoke-On-Trent ST1 1AA",
    );
  });

  it("preserves an apostrophe in a name", () => {
    expect(prettyAddress("KING'S ROAD CHELSEA SW3 4LY")).toBe(
      "King's Road Chelsea SW3 4LY",
    );
  });

  it("collapses extra whitespace and handles the empty string", () => {
    expect(prettyAddress("  union   street  se1 ")).toBe("Union Street SE1");
    expect(prettyAddress("")).toBe("");
  });
});

describe("gbp", () => {
  it("formats whole pounds as GBP with no decimals", () => {
    expect(gbp(625_000)).toBe("£625,000");
    expect(gbp(0)).toBe("£0");
  });
  it("renders an em dash for null", () => {
    expect(gbp(null)).toBe("—");
  });
});

describe("penceToPounds", () => {
  it("converts pence to whole pounds", () => {
    expect(penceToPounds(62_500_000)).toBe(625_000);
  });
  it("passes null through", () => {
    expect(penceToPounds(null)).toBeNull();
  });
});

describe("humanizePropertyType", () => {
  it("title-cases and hyphenates snake_case values", () => {
    expect(humanizePropertyType("semi_detached")).toBe("Semi-detached");
    expect(humanizePropertyType("terraced")).toBe("Terraced");
    expect(humanizePropertyType("flat")).toBe("Flat");
  });
  it("returns null for unknown / null (caller omits the segment)", () => {
    expect(humanizePropertyType("unknown")).toBeNull();
    expect(humanizePropertyType(null)).toBeNull();
  });
});

describe("ageHoursSince", () => {
  it("returns whole-ish hours since the timestamp", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    expect(ageHoursSince(new Date("2026-01-01T09:00:00.000Z"), now)).toBe(3);
  });
  it("never goes negative for a future timestamp", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    expect(ageHoursSince(new Date("2026-01-01T13:00:00.000Z"), now)).toBe(0);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-01-10T12:00:00.000Z");
  it("renders sub-minute as 'just now'", () => {
    expect(relativeTime(new Date("2026-01-10T11:59:30.000Z"), now)).toBe("just now");
  });
  it("renders minutes / hours / days / weeks", () => {
    expect(relativeTime(new Date("2026-01-10T11:45:00.000Z"), now)).toBe("15m ago");
    expect(relativeTime(new Date("2026-01-10T09:00:00.000Z"), now)).toBe("3h ago");
    expect(relativeTime(new Date("2026-01-08T12:00:00.000Z"), now)).toBe("2d ago");
    expect(relativeTime(new Date("2025-12-27T12:00:00.000Z"), now)).toBe("2w ago");
  });
  it("renders months and years for older timestamps", () => {
    expect(relativeTime(new Date("2025-11-01T12:00:00.000Z"), now)).toBe("2mo ago");
    expect(relativeTime(new Date("2024-01-10T12:00:00.000Z"), now)).toBe("2y ago");
  });
  it("accepts an ISO string as well as a Date", () => {
    expect(relativeTime("2026-01-10T10:00:00.000Z", now)).toBe("2h ago");
  });
});
