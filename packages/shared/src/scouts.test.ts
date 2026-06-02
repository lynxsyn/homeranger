import { describe, expect, it } from "vitest";
import {
  scoutByIdInputSchema,
  scoutCreateInputSchema,
  scoutSetStatusInputSchema,
  scoutUpdateInputSchema,
} from "./scouts.js";

describe("scoutCreateInputSchema", () => {
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
    expect(scoutCreateInputSchema.parse(input)).toEqual(input);
  });

  it("applies the documented defaults", () => {
    const parsed = scoutCreateInputSchema.parse({ name: "Bare brief" });
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
    expect(scoutCreateInputSchema.parse({ name: "  Hi  " }).name).toBe("Hi");
    expect(scoutCreateInputSchema.safeParse({ name: "   " }).success).toBe(
      false,
    );
    expect(scoutCreateInputSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects an unknown property type", () => {
    expect(
      scoutCreateInputSchema.safeParse({ name: "x", types: ["Castle"] }).success,
    ).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(
      scoutCreateInputSchema.safeParse({ name: "x", status: "archived" })
        .success,
    ).toBe(false);
  });

  it("rejects a negative maxPricePence", () => {
    expect(
      scoutCreateInputSchema.safeParse({ name: "x", maxPricePence: -1 }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    // outcodes are resolved server-side and must NOT be accepted on the wire.
    expect(
      scoutCreateInputSchema.safeParse({ name: "x", outcodes: ["SW1A"] })
        .success,
    ).toBe(false);
  });
});

describe("scoutUpdateInputSchema", () => {
  it("requires a uuid id alongside the full brief", () => {
    expect(
      scoutUpdateInputSchema.safeParse({ name: "x" }).success,
    ).toBe(false);
    const parsed = scoutUpdateInputSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Renamed",
    });
    expect(parsed.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.saleMethods).toEqual(["Private treaty"]);
    expect(parsed.status).toBe("active");
  });

  it("rejects a non-uuid id", () => {
    expect(
      scoutUpdateInputSchema.safeParse({ id: "nope", name: "x" }).success,
    ).toBe(false);
  });
});

describe("scoutSetStatusInputSchema", () => {
  it("accepts a uuid + valid status", () => {
    expect(
      scoutSetStatusInputSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        status: "paused",
      }).status,
    ).toBe("paused");
  });

  it("rejects an unknown status", () => {
    expect(
      scoutSetStatusInputSchema.safeParse({
        id: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      }).success,
    ).toBe(false);
  });
});

describe("scoutByIdInputSchema", () => {
  it("accepts a uuid and rejects junk", () => {
    expect(
      scoutByIdInputSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
      }).id,
    ).toBe("11111111-1111-4111-8111-111111111111");
    expect(scoutByIdInputSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});
