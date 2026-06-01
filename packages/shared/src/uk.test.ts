import { describe, expect, it } from "vitest";
import { isValidOutcode, normaliseOutcode, normalisePostcode } from "./uk.js";

describe("normalisePostcode", () => {
  it("canonicalises spacing and case", () => {
    expect(normalisePostcode("sw1a1aa")).toBe("SW1A 1AA");
    expect(normalisePostcode("  ec1a 1bb ")).toBe("EC1A 1BB");
    expect(normalisePostcode("m11ae")).toBe("M1 1AE");
  });

  it("returns null for structurally invalid input", () => {
    expect(normalisePostcode("not a postcode")).toBeNull();
    expect(normalisePostcode("SW1A")).toBeNull();
  });
});

describe("normaliseOutcode", () => {
  it("extracts the outward code from a full postcode", () => {
    expect(normaliseOutcode("SW1A 1AA")).toBe("SW1A");
    expect(normaliseOutcode("m1 1ae")).toBe("M1");
  });

  it("normalises a bare outcode", () => {
    expect(normaliseOutcode("ec1")).toBe("EC1");
  });

  it("returns null for invalid input", () => {
    expect(normaliseOutcode("zzz")).toBeNull();
  });
});

describe("isValidOutcode", () => {
  it("accepts valid outcodes and rejects others", () => {
    expect(isValidOutcode("B33")).toBe(true);
    expect(isValidOutcode("SW1A")).toBe(true);
    expect(isValidOutcode("SW1A 1AA")).toBe(false);
  });
});
