import { describe, expect, it } from "vitest";
import {
  FakeListingScrapeProvider,
  LISTING_SCRAPE_SITES,
} from "./listing-scrape.provider.js";

describe("FakeListingScrapeProvider", () => {
  const provider = new FakeListingScrapeProvider();

  it("returns deterministic listings derived from the site + first outcode", async () => {
    const a = await provider.scrape({
      site: "uklandandfarms",
      outcodes: ["LL30", "LL31"],
    });
    const b = await provider.scrape({
      site: "uklandandfarms",
      outcodes: ["LL30", "LL31"],
    });
    expect(a).toEqual(b); // byte-stable
    expect(a.length).toBe(2);
    // Every listing carries the minimal fields the service needs.
    for (const listing of a) {
      expect(listing.externalId).toContain("uklandandfarms-");
      expect(listing.sourceUrl).toMatch(/^https:\/\/uklandandfarms\.example\//);
      expect(listing.addressRaw.length).toBeGreaterThan(0);
      // The postcode falls inside the FIRST target outcode so it matches a search.
      expect(listing.postcode).toMatch(/^LL30 \dAA$/);
      expect(Number.isInteger(listing.pricePence)).toBe(true);
    }
  });

  it("varies the listing set by site (distinct external ids)", async () => {
    const uklf = await provider.scrape({
      site: "uklandandfarms",
      outcodes: ["LL30"],
    });
    const auction = await provider.scrape({
      site: "auctionhouse",
      outcodes: ["LL30"],
    });
    expect(uklf[0]!.externalId).not.toBe(auction[0]!.externalId);
    expect(uklf[0]!.pricePence).not.toBe(auction[0]!.pricePence);
  });

  it("uses the regionLabel in the address area when supplied", async () => {
    const [listing] = await provider.scrape({
      site: "auctionhouse",
      outcodes: ["SW1A"],
      regionLabel: "Westminster",
    });
    expect(listing!.addressRaw).toContain("Westminster");
  });

  it("returns [] when no target outcodes are supplied", async () => {
    expect(
      await provider.scrape({ site: "uklandandfarms", outcodes: [] }),
    ).toEqual([]);
  });

  it("returns [] when every outcode is blank", async () => {
    expect(
      await provider.scrape({ site: "auctionhouse", outcodes: ["", "   "] }),
    ).toEqual([]);
  });

  it("exposes all wired sites in LISTING_SCRAPE_SITES", () => {
    expect(LISTING_SCRAPE_SITES).toEqual([
      "uklandandfarms",
      "auctionhouse",
      "pughauctions",
    ]);
  });
});
