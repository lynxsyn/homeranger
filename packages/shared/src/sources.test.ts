import { describe, expect, it } from "vitest";
import { ListingSourceEnum } from "./listing-enums.js";
import {
  SOURCE_CATALOGUE,
  SOURCE_NAMES,
  sourcesListInputSchema,
} from "./sources.js";

/**
 * The genuinely-wired scrape sites, kept as a LITERAL set here (NOT imported
 * from @homeranger/backend-core) because @homeranger/shared depends only on zod
 * and is the framework-free wire contract. The source-of-truth is
 * `packages/backend-core/src/lib/listing-scrape/listing-scrape.provider.ts`
 * (`LISTING_SCRAPE_SITES`); keep this set in lockstep with it. The backend-side
 * drift (shared enum == Prisma enum) is covered by the M2 enum-drift test.
 */
const LISTING_SCRAPE_SITES = ["uklandandfarms", "auctionhouse"] as const;

describe("SOURCE_CATALOGUE", () => {
  it("ships exactly the 2 wired sources in render order (auction first)", () => {
    expect(SOURCE_CATALOGUE).toHaveLength(2);
    expect(SOURCE_CATALOGUE.map((s) => s.id)).toEqual([
      "auctionhouse",
      "uklandandfarms",
    ]);
  });

  it("every catalogue id is a ListingSource enum member AND a wired scrape site", () => {
    for (const entry of SOURCE_CATALOGUE) {
      expect(ListingSourceEnum.options).toContain(entry.id);
      // drift guard: only genuinely-crawled sites belong in the catalogue.
      expect(LISTING_SCRAPE_SITES).toContain(
        entry.id as (typeof LISTING_SCRAPE_SITES)[number],
      );
    }
  });

  it("never includes the non-crawled sources (agent_email / manual)", () => {
    const ids = SOURCE_CATALOGUE.map((s) => s.id);
    expect(ids).not.toContain("agent_email");
    expect(ids).not.toContain("manual");
  });

  it("exposes the kind + scheme-less domain each row renders", () => {
    const auction = SOURCE_CATALOGUE.find((s) => s.id === "auctionhouse");
    const land = SOURCE_CATALOGUE.find((s) => s.id === "uklandandfarms");
    expect(auction).toMatchObject({
      name: "Auction House",
      domain: "auctionhouse.co.uk",
      kind: "auction",
    });
    expect(land).toMatchObject({
      name: "UK Land & Farms",
      domain: "uklandandfarms.co.uk",
      kind: "land",
    });
    // domains carry no scheme (the FE adds https://).
    for (const entry of SOURCE_CATALOGUE) {
      expect(entry.domain).not.toMatch(/^https?:\/\//);
    }
  });
});

describe("SOURCE_NAMES", () => {
  it("maps a crawled id to its display name", () => {
    expect(SOURCE_NAMES.auctionhouse).toBe("Auction House");
    expect(SOURCE_NAMES.uklandandfarms).toBe("UK Land & Farms");
  });

  it("has no entry for a non-crawled source", () => {
    expect(SOURCE_NAMES.agent_email).toBeUndefined();
    expect(SOURCE_NAMES.manual).toBeUndefined();
  });
});

describe("sourcesListInputSchema", () => {
  it("accepts an empty object", () => {
    expect(sourcesListInputSchema.parse({})).toEqual({});
  });

  it("rejects any extra key (strict)", () => {
    expect(sourcesListInputSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});
