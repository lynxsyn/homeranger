import { describe, expect, it } from "vitest";
import {
  OUTREACH_URGENCY_LEVELS,
  OutreachUrgencyEnum,
  DEFAULT_OUTREACH_URGENCY,
  urgencyLine,
  buyerFullName,
  resolveSender,
  signatureBlock,
} from "./profile.js";
import { searchProfileUpdateSchema } from "./preferences.js";

describe("OUTREACH_URGENCY_LEVELS", () => {
  it("covers every enum id exactly once, in the design's order", () => {
    expect(OUTREACH_URGENCY_LEVELS.map((u) => u.id)).toEqual([
      "browsing",
      "active",
      "ready",
      "soon",
    ]);
    expect(OutreachUrgencyEnum.options).toEqual(
      OUTREACH_URGENCY_LEVELS.map((u) => u.id),
    );
    expect(DEFAULT_OUTREACH_URGENCY).toBe("active");
  });

  it("only 'browsing' has an empty closing line", () => {
    for (const level of OUTREACH_URGENCY_LEVELS) {
      if (level.id === "browsing") {
        expect(level.line).toBe("");
      } else {
        expect(level.line.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("urgencyLine", () => {
  it("returns the matching level's line", () => {
    expect(urgencyLine("ready")).toContain("I'm in a strong position to proceed");
  });

  it("returns '' for browsing, unknown, null, and undefined", () => {
    expect(urgencyLine("browsing")).toBe("");
    expect(urgencyLine("nope")).toBe("");
    expect(urgencyLine(null)).toBe("");
    expect(urgencyLine(undefined)).toBe("");
  });
});

describe("buyerFullName", () => {
  it("joins + trims first and last names", () => {
    expect(buyerFullName({ firstName: " Jane ", lastName: "Whitfield" })).toBe(
      "Jane Whitfield",
    );
  });

  it("is empty when both names are blank/missing", () => {
    expect(buyerFullName({ firstName: "  ", lastName: "" })).toBe("");
    expect(buyerFullName({})).toBe("");
  });

  it("keeps a single present name", () => {
    expect(buyerFullName({ firstName: "Jane" })).toBe("Jane");
    expect(buyerFullName({ lastName: "Whitfield" })).toBe("Whitfield");
  });
});

describe("resolveSender", () => {
  it("prefers the buyer's full name over the fallback", () => {
    expect(
      resolveSender(
        { firstName: "Jane", lastName: "Whitfield", phone: "07700 900123", urgency: "ready" },
        "Bryan",
      ),
    ).toEqual({ name: "Jane Whitfield", phone: "07700 900123", urgency: "ready" });
  });

  it("falls back to the RESEND_FROM name when no buyer name is set", () => {
    expect(resolveSender({ phone: "", urgency: "active" }, "Bryan")).toEqual({
      name: "Bryan",
      phone: null,
      urgency: "active",
    });
  });

  it("name is null when neither profile nor fallback has one", () => {
    expect(resolveSender({}, null).name).toBeNull();
    expect(resolveSender({}, "  ").name).toBeNull();
  });
});

describe("signatureBlock", () => {
  it("builds name + phone sign-off", () => {
    expect(signatureBlock("Jane Whitfield", "07700 900123")).toBe(
      "Many thanks,\nJane Whitfield\n07700 900123",
    );
  });

  it("name only", () => {
    expect(signatureBlock("Bryan", null)).toBe("Many thanks,\nBryan");
  });

  it("falls back to a bare 'Many thanks' with neither name nor phone", () => {
    expect(signatureBlock(null, null)).toBe("Many thanks");
    expect(signatureBlock("  ", "  ")).toBe("Many thanks");
  });
});

describe("searchProfileUpdateSchema (identity fields)", () => {
  it("accepts the identity fields", () => {
    const parsed = searchProfileUpdateSchema.parse({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });
    expect(parsed.firstName).toBe("Jane");
    expect(parsed.urgency).toBe("ready");
  });

  it("rejects an unknown urgency", () => {
    expect(() => searchProfileUpdateSchema.parse({ urgency: "whenever" })).toThrow();
  });

  it("rejects an over-long name", () => {
    expect(() =>
      searchProfileUpdateSchema.parse({ firstName: "x".repeat(121) }),
    ).toThrow();
  });
});
