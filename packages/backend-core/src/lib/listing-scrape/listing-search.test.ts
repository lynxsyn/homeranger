/**
 * Unit tests for the pure listing-search helpers (deterministic region-targeting
 * + index→detail hop). These are NOT coverage-excluded — siteRegionIndexUrls /
 * isListingUrl / extractListingLinks / parseAuctionHubListings carry the whole
 * region-targeting + parsing behaviour (the Firecrawl provider is a thin
 * operator-proven shell over them), so they are unit-proven here. Mirrors
 * discovery-queries.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  extractListingLinks,
  isListingUrl,
  parseAuctionHubListings,
  siteRegionIndexUrls,
} from "./listing-search.js";

describe("siteRegionIndexUrls", () => {
  it("maps a North Wales region label to the uklandandfarms index", () => {
    expect(
      siteRegionIndexUrls("uklandandfarms", "Conwy County, North Wales", []),
    ).toEqual([
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/",
    ]);
  });

  it("maps a North Wales region label to the auctionhouse /wales hub", () => {
    expect(siteRegionIndexUrls("auctionhouse", "North Wales", [])).toEqual([
      "https://www.auctionhouse.co.uk/wales",
    ]);
  });

  it("maps by LL2x/LL3x outcode prefix even when the region label is blank", () => {
    expect(siteRegionIndexUrls("uklandandfarms", "", ["LL30", "LL31"])).toEqual([
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/",
    ]);
    expect(siteRegionIndexUrls("auctionhouse", "", ["LL28"])).toEqual([
      "https://www.auctionhouse.co.uk/wales",
    ]);
  });

  it("matches the 'Conwy' alias (case-insensitive)", () => {
    expect(siteRegionIndexUrls("auctionhouse", "conwy", [])).toEqual([
      "https://www.auctionhouse.co.uk/wales",
    ]);
  });

  it("returns [] for an unmapped region (a clean no-op, never a wrong scrape)", () => {
    expect(siteRegionIndexUrls("uklandandfarms", "Cornwall", ["TR1"])).toEqual([]);
    expect(siteRegionIndexUrls("auctionhouse", "Bath", ["BA1"])).toEqual([]);
    expect(siteRegionIndexUrls("uklandandfarms", "", [])).toEqual([]);
  });

  it("dedups and ignores blank outcodes", () => {
    expect(
      siteRegionIndexUrls("uklandandfarms", "North Wales", ["LL30", "", "  "]),
    ).toEqual([
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/",
    ]);
  });
});

describe("isListingUrl — uklandandfarms", () => {
  it("accepts /search/detail.aspx with a non-empty PropertyRef", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/search/detail.aspx?PropertyRef=ABC123",
      ),
    ).toBe(true);
  });

  it("accepts a deep detail page with a numeric ref segment", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/99991_1283/",
      ),
    ).toBe(true);
  });

  it("accepts the live detail-slug shapes the operator confirmed", () => {
    for (const url of [
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/83440_chs250018/",
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/sychdyn_mold_flintshire-nm7holkr/",
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/glyn_ceiriog-34141009/",
    ]) {
      expect(isListingUrl("uklandandfarms", url)).toBe(true);
    }
  });

  it("rejects the bare region INDEX page (no detail ref segment)", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/",
      ),
    ).toBe(false);
  });

  it("rejects a word-only area slug as the last segment (an index, not a detail)", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales",
      ),
    ).toBe(false);
  });

  it("rejects /search/detail.aspx with an empty/missing PropertyRef", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/search/detail.aspx?PropertyRef=",
      ),
    ).toBe(false);
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/search/detail.aspx",
      ),
    ).toBe(false);
  });

  it("rejects the wrong host (bare apex or other host)", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/99991_1283/",
      ),
    ).toBe(false);
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://evil.example/rural-property-for-sale/x/y/123/",
      ),
    ).toBe(false);
  });

  it("rejects a www host path that is neither detail.aspx nor under the index root", () => {
    expect(
      isListingUrl("uklandandfarms", "https://www.uklandandfarms.co.uk/about"),
    ).toBe(false);
  });

  it("rejects a single-token last segment (an area slug, not a detail ref)", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/conwy",
      ),
    ).toBe(false);
  });

  it("rejects the robots-disallowed /customers/ and /agent/ areas", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/customers/detail.aspx?PropertyRef=1",
      ),
    ).toBe(false);
    expect(
      isListingUrl(
        "uklandandfarms",
        "https://www.uklandandfarms.co.uk/agent/rural-property-for-sale/x/123/",
      ),
    ).toBe(false);
  });
});

describe("isListingUrl — auctionhouse", () => {
  it("accepts a /lot/ page on the online. subdomain", () => {
    expect(
      isListingUrl("auctionhouse", "https://online.auctionhouse.co.uk/lot/12345"),
    ).toBe(true);
  });

  it("accepts a /lot/ page on the wales. (regional room) subdomain", () => {
    expect(
      isListingUrl("auctionhouse", "https://wales.auctionhouse.co.uk/lot/67890"),
    ).toBe(true);
  });

  it("accepts any non-www *.auctionhouse.co.uk regional room", () => {
    expect(
      isListingUrl("auctionhouse", "https://northwales.auctionhouse.co.uk/lot/42"),
    ).toBe(true);
  });

  it("accepts a /lot/redirect/<id> path with no query string", () => {
    expect(
      isListingUrl(
        "auctionhouse",
        "https://online.auctionhouse.co.uk/lot/redirect/99",
      ),
    ).toBe(true);
  });

  it("rejects the www marketing subdomain", () => {
    expect(
      isListingUrl("auctionhouse", "https://www.auctionhouse.co.uk/lot/12345"),
    ).toBe(false);
  });

  it("rejects /search-results (robots-disallowed) — not a /lot/ page", () => {
    expect(
      isListingUrl(
        "auctionhouse",
        "https://online.auctionhouse.co.uk/search-results?q=conwy",
      ),
    ).toBe(false);
  });

  it("rejects /print-lot/ (robots-disallowed)", () => {
    expect(
      isListingUrl(
        "auctionhouse",
        "https://online.auctionhouse.co.uk/print-lot/12345",
      ),
    ).toBe(false);
  });

  it("rejects an off-domain open-redirect lot URL carrying a query string", () => {
    expect(
      isListingUrl(
        "auctionhouse",
        "https://online.auctionhouse.co.uk/lot/redirect/1?next=https://evil.example",
      ),
    ).toBe(false);
  });

  it("rejects the bare /lot/ section index", () => {
    expect(
      isListingUrl("auctionhouse", "https://online.auctionhouse.co.uk/lot/"),
    ).toBe(false);
  });

  it("rejects a non-/lot/ path on a valid lot subdomain", () => {
    expect(
      isListingUrl("auctionhouse", "https://online.auctionhouse.co.uk/about-us"),
    ).toBe(false);
  });

  it("rejects an off-domain host that merely contains auctionhouse", () => {
    expect(
      isListingUrl("auctionhouse", "https://auctionhouse.co.uk.evil.com/lot/1"),
    ).toBe(false);
  });
});

describe("isListingUrl — shared rejections", () => {
  it("rejects an unparseable URL", () => {
    expect(isListingUrl("uklandandfarms", "not a url")).toBe(false);
    expect(isListingUrl("auctionhouse", "")).toBe(false);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(
      isListingUrl(
        "uklandandfarms",
        "ftp://www.uklandandfarms.co.uk/search/detail.aspx?PropertyRef=1",
      ),
    ).toBe(false);
  });
});

describe("extractListingLinks — uklandandfarms index page", () => {
  const INDEX_MARKDOWN = `
# Properties for sale in North Wales

- [Country house, Conwy](https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/83440_chs250018/)
- [Smallholding, Mold](/rural-property-for-sale/wales/north-wales/sychdyn_mold_flintshire-nm7holkr/)
- [Land, Glyn Ceiriog](https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/glyn_ceiriog-34141009/)
- [Back to the index](https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/)
- [Our agents](https://www.uklandandfarms.co.uk/agent/)
- [Some other site](https://www.rightmove.co.uk/property/123)
- [Duplicate](https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/83440_chs250018/)
`;

  it("harvests + absolutises + filters detail links, deduped, stable order", () => {
    expect(extractListingLinks("uklandandfarms", INDEX_MARKDOWN)).toEqual([
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/83440_chs250018/",
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/sychdyn_mold_flintshire-nm7holkr/",
      "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/glyn_ceiriog-34141009/",
    ]);
  });

  it("returns [] for empty text or a page with no detail links", () => {
    expect(extractListingLinks("uklandandfarms", "")).toEqual([]);
    expect(
      extractListingLinks("uklandandfarms", "no links here, just prose."),
    ).toEqual([]);
  });
});

describe("parseAuctionHubListings — auctionhouse regional hub", () => {
  // The REAL hub shape (captured live): each lot is a markdown IMAGE link that
  // spans two lines, the address on the line right before the closing `](url)`.
  // The image-alt prefix ("...Wales - <ADDRESS>") and the trailing address line
  // both carry the address; the parser keys off the address-before-`](LOTURL)`.
  const HUB_MARKDOWN = `
# Auction House Wales — current lots

[![Property for Auction in Wales - 23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB](https://cdn.eigpropertyauctions.co.uk/abc/image)\\
23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB](https://online.auctionhouse.co.uk/lot/redirect/346219 "View property details")

[![Property for Auction in Wales - 5 Ty Isa Road, Llandudno, Conwy, LL30 2PL](https://cdn.eigpropertyauctions.co.uk/def/image)\\
5 Ty Isa Road, Llandudno, Conwy, LL30 2PL](https://online.auctionhouse.co.uk/lot/redirect/347676 "View property details")

[![Property for Auction in Wales - Inglewood Celyn Avenue, Penmaenmawr, Conwy, LL34 6LR](https://cdn.eigpropertyauctions.co.uk/ghi/image)\\
Inglewood Celyn Avenue, Penmaenmawr, Conwy, LL34 6LR](https://online.auctionhouse.co.uk/lot/redirect/346740 "View property details")

[![Property for Auction in Wales - 18 Bryn Castell, Abergele, Conwy, LL22 8QA](https://cdn.eigpropertyauctions.co.uk/jkl/image)\\
18 Bryn Castell, Abergele, Conwy, LL22 8QA](https://wales.auctionhouse.co.uk/lot/redirect/348421 "View property details")

[![Property for Auction in Wales - A lot with no postcode at all](https://cdn.eigpropertyauctions.co.uk/mno/image)\\
A lot with no postcode at all](https://online.auctionhouse.co.uk/lot/redirect/999000 "View property details")

[![Property for Auction in Wales - 23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB](https://cdn.eigpropertyauctions.co.uk/abc/image)\\
23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB](https://online.auctionhouse.co.uk/lot/redirect/346219 "View property details")
`;

  it("parses the live two-line image-link lots (address + postcode + lot URL)", () => {
    expect(parseAuctionHubListings(HUB_MARKDOWN)).toEqual([
      {
        externalId: "auctionhouse-346219",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/346219",
        addressRaw: "23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB",
        postcode: "LL30 2YB",
      },
      {
        externalId: "auctionhouse-347676",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/347676",
        addressRaw: "5 Ty Isa Road, Llandudno, Conwy, LL30 2PL",
        postcode: "LL30 2PL",
      },
      {
        externalId: "auctionhouse-346740",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/346740",
        addressRaw: "Inglewood Celyn Avenue, Penmaenmawr, Conwy, LL34 6LR",
        postcode: "LL34 6LR",
      },
      {
        externalId: "auctionhouse-348421",
        sourceUrl: "https://wales.auctionhouse.co.uk/lot/redirect/348421",
        addressRaw: "18 Bryn Castell, Abergele, Conwy, LL22 8QA",
        postcode: "LL22 8QA",
      },
    ]);
  });

  it("extracts the Deganwy lot exactly (postcode, sourceUrl, externalId)", () => {
    const out = parseAuctionHubListings(HUB_MARKDOWN);
    const deganwy = out.find((l) => l.externalId === "auctionhouse-346219");
    expect(deganwy).toBeDefined();
    expect(deganwy!.postcode).toBe("LL30 2YB");
    expect(deganwy!.sourceUrl).toBe(
      "https://online.auctionhouse.co.uk/lot/redirect/346219",
    );
  });

  it("skips a lot whose link text has no postcode", () => {
    const out = parseAuctionHubListings(HUB_MARKDOWN);
    expect(out.some((l) => l.sourceUrl.endsWith("/999000"))).toBe(false);
  });

  it("dedups a lot that appears twice (first seen wins, by id)", () => {
    const out = parseAuctionHubListings(HUB_MARKDOWN);
    expect(out.filter((l) => l.externalId === "auctionhouse-346219")).toHaveLength(
      1,
    );
  });

  it("captures only the trailing address line, not the image-alt prefix", () => {
    // The address-before-`](url)` is bounded to not cross a `]` or newline, so the
    // captured address is the clean trailing line — not the "...Wales - " alt text.
    const out = parseAuctionHubListings(HUB_MARKDOWN);
    expect(out[0]!.addressRaw).toBe("23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB");
    expect(out[0]!.addressRaw).not.toContain("Property for Auction");
  });

  it("sanitises a single-line collapsed lot (image artifact stripped from address)", () => {
    // If Firecrawl ever collapses the lot onto ONE line (no newline before the
    // address), the captured text begins with the image URL's `...)` + the `\\`
    // hard-break — the sanitiser strips it so the stored address is clean.
    const md =
      "[![alt](https://cdn.eigpropertyauctions.co.uk/x/image)\\7 Bodnant Road, Llandudno, Conwy, LL30 1AA](https://online.auctionhouse.co.uk/lot/redirect/350001)";
    expect(parseAuctionHubListings(md)).toEqual([
      {
        externalId: "auctionhouse-350001",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/350001",
        addressRaw: "7 Bodnant Road, Llandudno, Conwy, LL30 1AA",
        postcode: "LL30 1AA",
      },
    ]);
  });

  it("returns [] for empty markdown or a hub with no lot links", () => {
    expect(parseAuctionHubListings("")).toEqual([]);
    expect(
      parseAuctionHubListings(
        "[Wales hub](https://www.auctionhouse.co.uk/wales) LL30 2YB",
      ),
    ).toEqual([]);
  });

  it("ignores a /print-lot/ or off-subdomain link even with an address", () => {
    const md = `
[![alt](https://cdn/x)\\
1 Foo Street, Conwy, LL30 2YB](https://online.auctionhouse.co.uk/print-lot/redirect/1)
[![alt](https://cdn/y)\\
2 Bar Street, Conwy, LL30 2YB](https://www.auctionhouse.co.uk/lot/redirect/2)
`;
    expect(parseAuctionHubListings(md)).toEqual([]);
  });
});
