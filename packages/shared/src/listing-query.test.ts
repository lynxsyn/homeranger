import { describe, expect, it } from "vitest";
import {
  listListingsInputSchema,
  listingFilterSchema,
  listingSortFieldSchema,
  outcodeSchema,
} from "./listing-query.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./pagination.js";

describe("outcodeSchema", () => {
  it("accepts and upper-cases a valid outcode", () => {
    expect(outcodeSchema.parse(" sw1a ")).toBe("SW1A");
    expect(outcodeSchema.parse("ec1")).toBe("EC1");
    expect(outcodeSchema.parse("m1")).toBe("M1");
  });

  it("rejects a full postcode or junk", () => {
    expect(outcodeSchema.safeParse("SW1A 1AA").success).toBe(false);
    expect(outcodeSchema.safeParse("!!!").success).toBe(false);
  });
});

describe("listingFilterSchema", () => {
  it("treats every field as optional", () => {
    expect(listingFilterSchema.parse({})).toEqual({});
  });

  it("validates pence as a non-negative integer", () => {
    expect(listingFilterSchema.safeParse({ maxPricePence: 1.5 }).success).toBe(
      false,
    );
    expect(listingFilterSchema.safeParse({ maxPricePence: -1 }).success).toBe(
      false,
    );
    expect(
      listingFilterSchema.parse({ maxPricePence: 50000000 }).maxPricePence,
    ).toBe(50000000);
  });

  it("rejects unknown keys (strict)", () => {
    expect(listingFilterSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("listListingsInputSchema", () => {
  it("applies sort + pagination defaults", () => {
    const parsed = listListingsInputSchema.parse({});
    expect(parsed.sortBy).toBe("combinedScore");
    expect(parsed.sortDir).toBe("desc");
    expect(parsed.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parsed.cursor).toBeUndefined();
  });

  it("clamps limit to the max page size", () => {
    expect(
      listListingsInputSchema.safeParse({ limit: MAX_PAGE_SIZE + 1 }).success,
    ).toBe(false);
    expect(listListingsInputSchema.parse({ limit: MAX_PAGE_SIZE }).limit).toBe(
      MAX_PAGE_SIZE,
    );
  });

  it("exposes the canonical sort fields", () => {
    expect(listingSortFieldSchema.options).toEqual([
      "combinedScore",
      "price",
      "lastSeenAt",
    ]);
  });
});
