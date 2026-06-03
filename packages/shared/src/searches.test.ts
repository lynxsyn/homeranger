import { describe, expect, it } from "vitest";
import {
  searchByIdInputSchema,
  searchCreateInputSchema,
  searchSetStatusInputSchema,
  searchUpdateInputSchema,
} from "./searches.js";

describe("searchCreateInputSchema", () => {
  it("parses a full valid input verbatim", () => {
    const input = {
      name: "Cotswolds barn hunt",
      location: "Stow-on-the-Wold, Gloucestershire",
      types: ["Barn", "Farmhouse"],
      condition: ["Restoration project"],
      land: ["Buildable land or planning potential"],
      saleMethods: ["Auction"],
      minBedrooms: 3,
      maxPricePence: 75_000_000,
      keywords: "exposed beams, south-facing, paddock",
      status: "paused",
    };
    expect(searchCreateInputSchema.parse(input)).toEqual(input);
  });

  it("applies the documented defaults", () => {
    const parsed = searchCreateInputSchema.parse({ name: "Bare brief" });
    expect(parsed.location).toBe("");
    expect(parsed.types).toEqual([]);
    expect(parsed.condition).toEqual([]);
    expect(parsed.land).toEqual([]);
    expect(parsed.saleMethods).toEqual(["Private treaty"]);
    expect(parsed.keywords).toBe("");
    expect(parsed.status).toBe("active");
    // pence/bedrooms stay absent (optional, no default) when omitted.
    expect(parsed.minBedrooms).toBeUndefined();
    expect(parsed.maxPricePence).toBeUndefined();
  });

  it("trims the name and rejects an empty one", () => {
    expect(searchCreateInputSchema.parse({ name: "  Hi  " }).name).toBe("Hi");
    expect(searchCreateInputSchema.safeParse({ name: "   " }).success).toBe(
      false,
    );
    expect(searchCreateInputSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects an unknown property type", () => {
    expect(
      searchCreateInputSchema.safeParse({ name: "x", types: ["Castle"] }).success,
    ).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(
      searchCreateInputSchema.safeParse({ name: "x", status: "archived" })
        .success,
    ).toBe(false);
  });

  it("rejects a negative maxPricePence", () => {
    expect(
      searchCreateInputSchema.safeParse({ name: "x", maxPricePence: -1 }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    // outcodes are resolved server-side and must NOT be accepted on the wire.
    expect(
      searchCreateInputSchema.safeParse({ name: "x", outcodes: ["SW1A"] })
        .success,
    ).toBe(false);
  });
});

describe("searchUpdateInputSchema", () => {
  it("requires a uuid id alongside the full brief", () => {
    expect(
      searchUpdateInputSchema.safeParse({ name: "x" }).success,
    ).toBe(false);
    const parsed = searchUpdateInputSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Renamed",
    });
    expect(parsed.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.saleMethods).toEqual(["Private treaty"]);
    expect(parsed.status).toBe("active");
  });

  it("rejects a non-uuid id", () => {
    expect(
      searchUpdateInputSchema.safeParse({ id: "nope", name: "x" }).success,
    ).toBe(false);
  });
});

describe("searchSetStatusInputSchema", () => {
  it("accepts a uuid + valid status", () => {
    expect(
      searchSetStatusInputSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        status: "paused",
      }).status,
    ).toBe("paused");
  });

  it("rejects an unknown status", () => {
    expect(
      searchSetStatusInputSchema.safeParse({
        id: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      }).success,
    ).toBe(false);
  });
});

describe("searchByIdInputSchema", () => {
  it("accepts a uuid and rejects junk", () => {
    expect(
      searchByIdInputSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
      }).id,
    ).toBe("11111111-1111-4111-8111-111111111111");
    expect(searchByIdInputSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});
