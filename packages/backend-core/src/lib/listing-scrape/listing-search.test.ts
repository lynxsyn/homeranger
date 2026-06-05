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
  extractImageUrl,
  extractListingLinks,
  extractPughAuctionLinks,
  isHotlinkableImageUrl,
  isListingUrl,
  parseAuctionHubListings,
  parsePughLots,
  parseUklfDetail,
  siteCoverage,
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

describe("siteCoverage", () => {
  it("derives the configured outcode prefixes + region labels for uklandandfarms", () => {
    expect(siteCoverage("uklandandfarms")).toEqual({
      outcodes: ["LL2", "LL3"],
      regionLabels: [
        "north wales",
        "conwy",
        "gwynedd",
        "denbighshire",
        "anglesey",
      ],
    });
  });

  it("derives the same single-row coverage for auctionhouse (both sites map the row today)", () => {
    expect(siteCoverage("auctionhouse")).toEqual({
      outcodes: ["LL2", "LL3"],
      regionLabels: [
        "north wales",
        "conwy",
        "gwynedd",
        "denbighshire",
        "anglesey",
      ],
    });
  });

  it("preserves the REGION_TAXONOMY row order for outcodes + labels", () => {
    const cov = siteCoverage("auctionhouse");
    expect(cov.outcodes[0]).toBe("LL2");
    expect(cov.regionLabels[0]).toBe("north wales");
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

  it("parses the live two-line image-link lots (address + postcode + lot URL + image)", () => {
    expect(parseAuctionHubListings(HUB_MARKDOWN)).toEqual([
      {
        externalId: "auctionhouse-346219",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/346219",
        addressRaw: "23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB",
        postcode: "LL30 2YB",
        imageUrl: "https://cdn.eigpropertyauctions.co.uk/abc/image",
      },
      {
        externalId: "auctionhouse-347676",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/347676",
        addressRaw: "5 Ty Isa Road, Llandudno, Conwy, LL30 2PL",
        postcode: "LL30 2PL",
        imageUrl: "https://cdn.eigpropertyauctions.co.uk/def/image",
      },
      {
        externalId: "auctionhouse-346740",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/346740",
        addressRaw: "Inglewood Celyn Avenue, Penmaenmawr, Conwy, LL34 6LR",
        postcode: "LL34 6LR",
        imageUrl: "https://cdn.eigpropertyauctions.co.uk/ghi/image",
      },
      {
        externalId: "auctionhouse-348421",
        sourceUrl: "https://wales.auctionhouse.co.uk/lot/redirect/348421",
        addressRaw: "18 Bryn Castell, Abergele, Conwy, LL22 8QA",
        postcode: "LL22 8QA",
        imageUrl: "https://cdn.eigpropertyauctions.co.uk/jkl/image",
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
        imageUrl: "https://cdn.eigpropertyauctions.co.uk/x/image",
      },
    ]);
  });

  it("omits imageUrl when the lot's image host is not an allowlisted source", () => {
    // A lot whose image is on some random CDN is still parsed, but with NO
    // imageUrl (we only hotlink from the source sites' own image hosts).
    const md =
      "[![alt](https://evil.example/tracker.gif)\\9 Foo Road, Conwy, LL30 2YB](https://online.auctionhouse.co.uk/lot/redirect/355000)";
    expect(parseAuctionHubListings(md)).toEqual([
      {
        externalId: "auctionhouse-355000",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/355000",
        addressRaw: "9 Foo Road, Conwy, LL30 2YB",
        postcode: "LL30 2YB",
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

describe("extractImageUrl — detail page markdown", () => {
  it("returns the first hotlinkable image URL in the markdown", () => {
    const md = `
# A farm
![hero](https://www.uklandandfarms.co.uk/images/property/farm-1.jpg)
Some prose.
![second](https://www.uklandandfarms.co.uk/images/property/farm-2.jpg)
`;
    expect(extractImageUrl(md)).toBe(
      "https://www.uklandandfarms.co.uk/images/property/farm-1.jpg",
    );
  });

  it("skips a data/base64 placeholder and returns the next real image", () => {
    const md = `
![placeholder](<Base64-Image-Removed>)
![real](https://www.uklandandfarms.co.uk/images/property/farm-9.jpg)
`;
    expect(extractImageUrl(md)).toBe(
      "https://www.uklandandfarms.co.uk/images/property/farm-9.jpg",
    );
  });

  it("returns undefined when there is no hotlinkable image", () => {
    expect(extractImageUrl("")).toBeUndefined();
    expect(extractImageUrl("just prose, no images")).toBeUndefined();
    expect(
      extractImageUrl("![x](https://evil.example/tracker.gif)"),
    ).toBeUndefined();
  });
});

describe("isHotlinkableImageUrl", () => {
  it("accepts an https URL on an allowlisted source host (no extension needed)", () => {
    // The auctionhouse AMS CDN serves extension-less image paths.
    expect(
      isHotlinkableImageUrl(
        "https://cdn.eigpropertyauctions.co.uk/ams/images/96/auction/0/2666894_web_medium",
      ),
    ).toBe(true);
    expect(
      isHotlinkableImageUrl("https://www.uklandandfarms.co.uk/img/x.jpg"),
    ).toBe(true);
  });

  it("matches a subdomain of an allowlisted source host", () => {
    expect(
      isHotlinkableImageUrl("https://online.auctionhouse.co.uk/img/lot.jpg"),
    ).toBe(true);
  });

  it("rejects an OFF-allowlist host even with a real image extension", () => {
    // Host-allowlist only — we never hotlink from a third-party host, even one
    // serving a .jpg/.webp (no arbitrary URL injection; no off-source tracking).
    expect(isHotlinkableImageUrl("https://cdn.example/a/b/photo.webp")).toBe(false);
    expect(isHotlinkableImageUrl("https://cdn.example/p.jpeg?v=2")).toBe(false);
    expect(isHotlinkableImageUrl("https://evil.example/pixel.png")).toBe(false);
  });

  it("rejects non-https, base64, malformed, and oversized URLs", () => {
    expect(isHotlinkableImageUrl("")).toBe(false);
    expect(
      isHotlinkableImageUrl("http://www.uklandandfarms.co.uk/img/x.jpg"),
    ).toBe(false); // not https
    expect(isHotlinkableImageUrl("https://evil.example/tracker.gif")).toBe(false);
    expect(isHotlinkableImageUrl("<Base64-Image-Removed>")).toBe(false);
    expect(isHotlinkableImageUrl("not a url")).toBe(false);
    expect(
      isHotlinkableImageUrl(
        `https://www.uklandandfarms.co.uk/${"a".repeat(600)}.jpg`,
      ),
    ).toBe(false); // > 500 chars
  });
});

describe("parseUklfDetail", () => {
  // A faithful trim of a LIVE uklandandfarms detail page (captured 2026-06-05).
  // The markdown opens with the site NAV (`[Home](…)`) and a selling-AGENT
  // contact card carrying the AGENT'S OWN office postcode (SY4 5NQ, Shropshire),
  // followed by the property's H1 carrying the PROPERTY postcode (CH7 6ES). The
  // page <title> is `<address>, <postcode> - UKLAF`. This is exactly the shape
  // that made the old firstLine()/first-postcode extraction capture the nav +
  // the agent's office, pruning every real North-Wales listing by outcode.
  const DETAIL_MD = [
    `- [Home](https://www.uklandandfarms.co.uk/ "")`,
    `- [Property search](https://www.uklandandfarms.co.uk/search/ "Search")`,
    ``,
    `### Mortgage calculator`,
    ``,
    `Property value:?`,
    ``,
    `[![Atchams](https://www.uklandandfarms.co.uk/media/agents/t_x.png)](https://www.uklandandfarms.co.uk/exit.aspx?url=https://www.atchams.co.uk)`,
    ``,
    `**Atchams**`,
    ``,
    `Holly Farm`,
    ``,
    `Wolverley`,
    ``,
    `Shropshire`,
    ``,
    `SY4 5NQ`,
    ``,
    `**Tel:**`,
    ``,
    `« Back`,
    ``,
    `# 104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES    For Sale -   Guide Price £1,500,000`,
    ``,
    `Farm with house and range of outbuildings.`,
    ``,
    `![photo](https://www.uklandandfarms.co.uk/media/properties/thb_x.jpg)`,
  ].join("\n");
  const DETAIL_TITLE =
    "\n\t104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES - UKLAF\n";

  it("extracts the PROPERTY postcode from the title, never the agent's office", () => {
    const parsed = parseUklfDetail(DETAIL_MD, DETAIL_TITLE);
    expect(parsed?.postcode).toBe("CH7 6ES"); // the property, NOT SY4 5NQ
  });

  it("extracts the property address (not the nav `[Home]` link)", () => {
    const parsed = parseUklfDetail(DETAIL_MD, DETAIL_TITLE);
    expect(parsed?.addressRaw).toBe(
      "104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES",
    );
    expect(parsed?.addressRaw).not.toContain("Home");
  });

  it("extracts the guide price as integer pence", () => {
    expect(parseUklfDetail(DETAIL_MD, DETAIL_TITLE)?.pricePence).toBe(
      150_000_000,
    );
  });

  it("falls back to the postcode-bearing H1 when the title is missing", () => {
    const parsed = parseUklfDetail(DETAIL_MD, undefined);
    expect(parsed?.postcode).toBe("CH7 6ES"); // still the property, not SY4
    expect(parsed?.addressRaw).toBe(
      "104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES",
    );
  });

  it("returns an address without a postcode when none is present", () => {
    const parsed = parseUklfDetail(
      "# Land at Cae Glas, Llanrwst, North Wales    For Sale",
      "Land at Cae Glas, Llanrwst, North Wales - UKLAF",
    );
    expect(parsed?.addressRaw).toBe("Land at Cae Glas, Llanrwst, North Wales");
    expect(parsed?.postcode).toBeUndefined();
  });

  it("returns null when there is no usable heading", () => {
    expect(parseUklfDetail("", undefined)).toBeNull();
    expect(parseUklfDetail("just some body text, no heading", "")).toBeNull();
  });

  it("takes the price from the H1, not an earlier mortgage-calculator figure", () => {
    // The mortgage calculator renders a £ value BEFORE the property H1; the old
    // full-body first-£ fallback would have captured £250,000 instead of the
    // £1,500,000 guide price.
    const md = [
      `### Mortgage calculator`,
      ``,
      `Property value: £250,000`,
      `Monthly repayment from £1,200`,
      ``,
      `# 104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES    For Sale -   Guide Price £1,500,000`,
    ].join("\n");
    expect(parseUklfDetail(md, DETAIL_TITLE)?.pricePence).toBe(150_000_000);
  });

  it("rejects a brand-only / generic site title as an address", () => {
    // A redirect to the index can land a generic <title> on a detail scrape.
    expect(parseUklfDetail("", "UKLAF")).toBeNull();
    expect(parseUklfDetail("", " - UKLAF")).toBeNull();
    expect(
      parseUklfDetail("", "Rural Property For Sale in Wales | UKLAF"),
    ).toBeNull();
    expect(
      parseUklfDetail(
        "# Country properties, land & Farms for sale or rent",
        "Country properties, land & Farms for sale or rent - UKLAF",
      ),
    ).toBeNull();
  });
});

describe("pughauctions (national auction catalogue)", () => {
  it("targets the national diary whenever there are outcodes, [] otherwise", () => {
    expect(siteRegionIndexUrls("pughauctions", "", ["HD4", "BL4"])).toEqual([
      "https://www.pugh-auctions.com/auction-diary",
    ]);
    // A region label it is NOT taxonomy-mapped for still activates (national).
    expect(siteRegionIndexUrls("pughauctions", "Cornwall", ["TR1"])).toEqual([
      "https://www.pugh-auctions.com/auction-diary",
    ]);
    // No outcodes → nothing to target.
    expect(siteRegionIndexUrls("pughauctions", "Yorkshire", [])).toEqual([]);
  });

  it("reports nationwide coverage (not a region-mapped patch)", () => {
    expect(siteCoverage("pughauctions")).toEqual({
      outcodes: [],
      regionLabels: ["nationwide"],
    });
  });

  it("isListingUrl accepts a /property/<ref> lot, rejects index/adm/query/host", () => {
    expect(
      isListingUrl(
        "pughauctions",
        "https://www.pugh-auctions.com/property/202603121543sq_aidl",
      ),
    ).toBe(true);
    // bare section index, robots-disallowed /adm, a query string, wrong host.
    expect(isListingUrl("pughauctions", "https://www.pugh-auctions.com/property/")).toBe(false);
    expect(isListingUrl("pughauctions", "https://www.pugh-auctions.com/adm")).toBe(false);
    expect(
      isListingUrl("pughauctions", "https://www.pugh-auctions.com/property/x?ref=1"),
    ).toBe(false);
    expect(isListingUrl("pughauctions", "https://evil.example/property/x")).toBe(false);
  });

  it("harvests upcoming auction-event URLs from the diary (dedup, skip the diary itself)", () => {
    const diary = [
      `[Sale A](https://www.pugh-auctions.com/auction/202604011436sq_qw8s)`,
      `[Sale A again](https://www.pugh-auctions.com/auction/202604011436sq_qw8s)`,
      `[Sale B](https://www.pugh-auctions.com/auction/202605120943sq_exn9)`,
      `[Diary](https://www.pugh-auctions.com/auction-diary#)`,
    ].join("\n");
    expect(extractPughAuctionLinks(diary)).toEqual([
      "https://www.pugh-auctions.com/auction/202604011436sq_qw8s",
      "https://www.pugh-auctions.com/auction/202605120943sq_exn9",
    ]);
  });

  // A faithful trim of a LIVE Pugh auction-EVENT page (captured 2026-06-05): an
  // image link to the lot, a "View Property" link, then the ADDRESS as its own
  // link ending in the PROPERTY postcode, then the guide price.
  const EVENT_MD = [
    `[![Land at Bent Street](https://asta.btgeddisonspropertyauctions.com/sdl_data/x/land.jpg?u=1)](https://www.pugh-auctions.com/property/202603121543sq_aidl)`,
    ``,
    `[View Property](https://www.pugh-auctions.com/property/202603121543sq_aidl)`,
    ``,
    `Multi-Lot Timed Auction`,
    ``,
    `[Land at Bent Street & Elm Street, Newsome, Huddersfield, West Yorkshire HD4 6NX](https://www.pugh-auctions.com/property/202603121543sq_aidl)`,
    ``,
    `Guide Price: £130,000 plus`,
  ].join("\n");

  it("parses a lot inline: property address+postcode+price+image, ignoring the image/View links", () => {
    const lots = parsePughLots(EVENT_MD);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toEqual({
      externalId: "pughauctions-202603121543sq_aidl",
      sourceUrl: "https://www.pugh-auctions.com/property/202603121543sq_aidl",
      addressRaw:
        "Land at Bent Street & Elm Street, Newsome, Huddersfield, West Yorkshire HD4 6NX",
      postcode: "HD4 6NX",
      pricePence: 13_000_000,
      imageUrl:
        "https://asta.btgeddisonspropertyauctions.com/sdl_data/x/land.jpg?u=1",
    });
  });

  it("dedups a lot that appears twice (first seen wins)", () => {
    expect(parsePughLots(`${EVENT_MD}\n\n${EVENT_MD}`)).toHaveLength(1);
  });

  it("skips a lot link whose text carries no postcode", () => {
    const md = `[View Property](https://www.pugh-auctions.com/property/202601010000sq_zzzz)`;
    expect(parsePughLots(md)).toEqual([]);
  });

  it("omits the price when the event page has no guide price", () => {
    const md = `[Land at Foo, Leeds, West Yorkshire LS1 1AA](https://www.pugh-auctions.com/property/202601010000sq_abcd)`;
    const lots = parsePughLots(md);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.pricePence).toBeUndefined();
    expect(lots[0]!.postcode).toBe("LS1 1AA");
  });
});
