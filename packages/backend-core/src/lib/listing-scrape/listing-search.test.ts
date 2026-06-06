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
  uklfBodyPostcode,
  uklfSearchEndpoint,
  withPageIndex,
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
  const INDEX_HTML = `
<h1>Properties for sale in North Wales</h1>
<ul>
  <li><a href="https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/83440_chs250018/">Country house, Conwy</a></li>
  <li><a href="/rural-property-for-sale/wales/north-wales/sychdyn_mold_flintshire-nm7holkr/">Smallholding, Mold</a></li>
  <li><a href="https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/glyn_ceiriog-34141009/">Land, Glyn Ceiriog</a></li>
  <li><a href="https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/">Back to the index</a></li>
  <li><a href="https://www.uklandandfarms.co.uk/agent/">Our agents</a></li>
  <li><a href="https://www.rightmove.co.uk/property/123">Some other site</a></li>
  <li><a href="https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/83440_chs250018/">Duplicate</a></li>
</ul>
`;

  it("harvests + absolutises + filters detail links, deduped, stable order", () => {
    expect(extractListingLinks("uklandandfarms", INDEX_HTML)).toEqual([
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
  // The REAL hub shape (captured live): each lot card is a single <a> wrapping
  // the lot image (<img class="lot-image">) and the address (<p class="…
  // grid-address">). The img `alt` ALSO carries the address — the parser must
  // read the <p>, never the alt. Last two cards: a no-postcode lot + a duplicate.
  const ahLot = (id: string, addr: string, img: string, sub = "online"): string =>
    `<a href="https://${sub}.auctionhouse.co.uk/lot/redirect/${id}" class="home-lot-wrapper-link" title="View property details">` +
    `<div class="image-wrapper"><img src="${img}" class="lot-image" alt="Property for Auction in Wales - ${addr}"/>` +
    `<div class="image-sticker">Lot 1</div></div>` +
    `<div class="summary-info-wrapper"><p class="fw-bold blue-text">House</p>` +
    `<p class="fw-medium blue-text grid-address">${addr}</p></div></a>`;
  const HUB_HTML = `
<h1>Auction House Wales — current lots</h1>
<div class="row row-search-results-grid">
${ahLot("346219", "23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB", "https://cdn.eigpropertyauctions.co.uk/abc/image")}
${ahLot("347676", "5 Ty Isa Road, Llandudno, Conwy, LL30 2PL", "https://cdn.eigpropertyauctions.co.uk/def/image")}
${ahLot("346740", "Inglewood Celyn Avenue, Penmaenmawr, Conwy, LL34 6LR", "https://cdn.eigpropertyauctions.co.uk/ghi/image")}
${ahLot("348421", "18 Bryn Castell, Abergele, Conwy, LL22 8QA", "https://cdn.eigpropertyauctions.co.uk/jkl/image", "wales")}
${ahLot("999000", "A lot with no postcode at all", "https://cdn.eigpropertyauctions.co.uk/mno/image")}
${ahLot("346219", "23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB", "https://cdn.eigpropertyauctions.co.uk/abc/image")}
</div>
`;

  it("parses the live lot cards (address + postcode + lot URL + image)", () => {
    expect(parseAuctionHubListings(HUB_HTML)).toEqual([
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
    const out = parseAuctionHubListings(HUB_HTML);
    const deganwy = out.find((l) => l.externalId === "auctionhouse-346219");
    expect(deganwy).toBeDefined();
    expect(deganwy!.postcode).toBe("LL30 2YB");
    expect(deganwy!.sourceUrl).toBe(
      "https://online.auctionhouse.co.uk/lot/redirect/346219",
    );
  });

  it("skips a lot whose card has no postcode", () => {
    const out = parseAuctionHubListings(HUB_HTML);
    expect(out.some((l) => l.sourceUrl.endsWith("/999000"))).toBe(false);
  });

  it("dedups a lot that appears twice (first seen wins, by id)", () => {
    const out = parseAuctionHubListings(HUB_HTML);
    expect(out.filter((l) => l.externalId === "auctionhouse-346219")).toHaveLength(
      1,
    );
  });

  it("reads the address from the grid-address <p>, not the img alt", () => {
    // The img `alt` also carries the address (prefixed "Property for Auction in
    // Wales - …"); the parser must use the <p class="…grid-address"> text.
    const out = parseAuctionHubListings(HUB_HTML);
    expect(out[0]!.addressRaw).toBe("23 Deganwy Avenue, Llandudno, Conwy, LL30 2YB");
    expect(out[0]!.addressRaw).not.toContain("Property for Auction");
  });

  it("omits imageUrl when the lot's image host is not an allowlisted source", () => {
    // A lot whose image is on some random CDN is still parsed, but with NO
    // imageUrl (we only hotlink from the source sites' own image hosts).
    const html =
      '<a href="https://online.auctionhouse.co.uk/lot/redirect/355000" class="home-lot-wrapper-link">' +
      '<img src="https://evil.example/tracker.jpg" class="lot-image"/>' +
      '<p class="grid-address">9 Foo Road, Conwy, LL30 2YB</p></a>';
    expect(parseAuctionHubListings(html)).toEqual([
      {
        externalId: "auctionhouse-355000",
        sourceUrl: "https://online.auctionhouse.co.uk/lot/redirect/355000",
        addressRaw: "9 Foo Road, Conwy, LL30 2YB",
        postcode: "LL30 2YB",
      },
    ]);
  });

  it("returns [] for empty HTML or a hub with no lot cards", () => {
    expect(parseAuctionHubListings("")).toEqual([]);
    expect(
      parseAuctionHubListings(
        '<a href="https://www.auctionhouse.co.uk/wales">Wales hub</a> LL30 2YB',
      ),
    ).toEqual([]);
  });

  it("ignores a /print-lot/ or off-subdomain (www) lot card even with an address", () => {
    const html =
      '<a href="https://online.auctionhouse.co.uk/print-lot/redirect/1" class="home-lot-wrapper-link">' +
      '<p class="grid-address">1 Foo Street, Conwy, LL30 2YB</p></a>' +
      '<a href="https://www.auctionhouse.co.uk/lot/redirect/2" class="home-lot-wrapper-link">' +
      '<p class="grid-address">2 Bar Street, Conwy, LL30 2YB</p></a>';
    expect(parseAuctionHubListings(html)).toEqual([]);
  });
});

describe("extractImageUrl — detail page HTML", () => {
  it("returns the first hotlinkable <img> URL in the HTML", () => {
    const html = `
<h1>A farm</h1>
<img src="https://www.uklandandfarms.co.uk/images/property/farm-1.jpg" alt="hero"/>
<p>Some prose.</p>
<img src="https://www.uklandandfarms.co.uk/images/property/farm-2.jpg" alt="second"/>
`;
    expect(extractImageUrl(html)).toBe(
      "https://www.uklandandfarms.co.uk/images/property/farm-1.jpg",
    );
  });

  it("resolves a root-relative src against the page base + decodes &amp; (uklandandfarms)", () => {
    // uklandandfarms references property photos as root-relative /media paths and
    // precedes them with decorative .gif chrome; with the base URL the real photo
    // resolves to an on-host absolute URL, and the .gif chrome is skipped.
    const html =
      '<img src="/media/viewing.gif"/>' +
      '<img src="/media/properties/man_123.jpg?w=800&amp;h=600"/>';
    expect(
      extractImageUrl(html, "https://www.uklandandfarms.co.uk/search/detail.aspx?PropertyRef=X"),
    ).toBe("https://www.uklandandfarms.co.uk/media/properties/man_123.jpg?w=800&h=600");
  });

  it("skips a base64 placeholder + decorative .gif and returns the next real image", () => {
    const html =
      '<img src="<Base64-Image-Removed>"/>' +
      '<img src="https://www.uklandandfarms.co.uk/media/icons/ico_home.gif"/>' +
      '<img src="https://www.uklandandfarms.co.uk/images/property/farm-9.jpg"/>';
    expect(extractImageUrl(html)).toBe(
      "https://www.uklandandfarms.co.uk/images/property/farm-9.jpg",
    );
  });

  it("returns undefined when there is no hotlinkable image", () => {
    expect(extractImageUrl("")).toBeUndefined();
    expect(extractImageUrl("just prose, no images")).toBeUndefined();
    expect(
      extractImageUrl('<img src="https://evil.example/tracker.png"/>'),
    ).toBeUndefined();
    // A relative src with NO base cannot be resolved → skipped.
    expect(extractImageUrl('<img src="/media/properties/x.jpg"/>')).toBeUndefined();
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
    // On-allowlist .gif is ALSO rejected — listing photos are jpg/png/webp, gifs
    // are decorative UI chrome (uklandandfarms /media/viewing.gif + icons).
    expect(
      isHotlinkableImageUrl("https://www.uklandandfarms.co.uk/media/viewing.gif"),
    ).toBe(false);
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
  // A faithful trim of a LIVE uklandandfarms detail page (captured 2026-06-06).
  // The HTML opens with the site NAV (`<a>Home</a>`) and a selling-AGENT contact
  // card carrying the AGENT'S OWN office postcode (SY4 5NQ, Shropshire), followed
  // by the property's <h1> carrying the PROPERTY postcode (CH7 6ES) + the guide
  // price. The page <title> is `<address>, <postcode> - UKLAF`. This is exactly
  // the shape that made the old firstLine()/first-postcode extraction capture the
  // nav + the agent's office, pruning every real North-Wales listing by outcode.
  const DETAIL_HTML = [
    `<nav><a href="https://www.uklandandfarms.co.uk/">Home</a>`,
    `<a href="https://www.uklandandfarms.co.uk/search/">Property search</a></nav>`,
    `<div class="mortgage"><h3>Mortgage calculator</h3><p>Property value:?</p></div>`,
    `<div class="agent-card"><strong>Atchams</strong><p>Holly Farm</p>`,
    `<p>Wolverley</p><p>Shropshire</p><p>SY4 5NQ</p><p>Tel:</p></div>`,
    `<h1>104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES &nbsp; For Sale - &nbsp; Guide Price £1,500,000</h1>`,
    `<p>Farm with house and range of outbuildings.</p>`,
    `<img src="https://www.uklandandfarms.co.uk/media/properties/thb_x.jpg"/>`,
  ].join("\n");
  const DETAIL_TITLE =
    "\n\t104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES - UKLAF\n";

  it("extracts the PROPERTY postcode from the title, never the agent's office", () => {
    const parsed = parseUklfDetail(DETAIL_HTML, DETAIL_TITLE);
    expect(parsed?.postcode).toBe("CH7 6ES"); // the property, NOT SY4 5NQ
  });

  it("extracts the property address (not the nav `Home` link)", () => {
    const parsed = parseUklfDetail(DETAIL_HTML, DETAIL_TITLE);
    expect(parsed?.addressRaw).toBe(
      "104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES",
    );
    expect(parsed?.addressRaw).not.toContain("Home");
  });

  it("extracts the guide price as integer pence", () => {
    expect(parseUklfDetail(DETAIL_HTML, DETAIL_TITLE)?.pricePence).toBe(
      150_000_000,
    );
  });

  it("falls back to the postcode-bearing <h1> when the title is missing", () => {
    const parsed = parseUklfDetail(DETAIL_HTML, undefined);
    expect(parsed?.postcode).toBe("CH7 6ES"); // still the property, not SY4
    expect(parsed?.addressRaw).toBe(
      "104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES",
    );
  });

  it("returns an address without a postcode when none is present", () => {
    const parsed = parseUklfDetail(
      "<h1>Land at Cae Glas, Llanrwst, North Wales &nbsp; For Sale</h1>",
      "Land at Cae Glas, Llanrwst, North Wales - UKLAF",
    );
    expect(parsed?.addressRaw).toBe("Land at Cae Glas, Llanrwst, North Wales");
    expect(parsed?.postcode).toBeUndefined();
  });

  it("returns null when there is no usable heading", () => {
    expect(parseUklfDetail("", undefined)).toBeNull();
    expect(parseUklfDetail("just some body text, no heading", "")).toBeNull();
  });

  it("takes the price from the <h1>, not an earlier mortgage-calculator figure", () => {
    // The mortgage calculator renders a £ value BEFORE the property <h1>; the old
    // full-body first-£ fallback would have captured £250,000 instead of the
    // £1,500,000 guide price. The H1-first scan + the LABEL-required body
    // fallback both avoid the calculator value.
    const html = [
      `<div class="mortgage"><h3>Mortgage calculator</h3>`,
      `<p>Property value: £250,000</p><p>Monthly repayment from £1,200</p></div>`,
      `<h1>104.6 acres, Sychdyn, Mold, Flintshire, North Wales, CH7 6ES For Sale - Guide Price £1,500,000</h1>`,
    ].join("\n");
    expect(parseUklfDetail(html, DETAIL_TITLE)?.pricePence).toBe(150_000_000);
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

  // A faithful trim of a LIVE detail page whose heading names the place but has
  // NO postcode (Abergele, Conwy; captured 2026-06-06). The PROPERTY postcode
  // (LL22 8YR) is in the BODY many times + a Google-Maps geocode link; the
  // selling AGENT'S Chester office (CH1 1QU) appears once in a contact card.
  // Without the body-postcode recall this real £4.5M Conwy listing was dropped
  // (no postcode in the heading → outcode filter pruned it).
  const NO_HEADING_PC_HTML = [
    `<nav><a href="https://www.uklandandfarms.co.uk/">Home</a></nav>`,
    `<div class="agent-card"><strong>Fisher German</strong><p>Wrexham Road</p>`,
    `<p>Chester</p><p>Cheshire</p><p>CH1 1QU</p></div>`,
    `<h1>507.33 acres, Abergele, Conwy, North Wales For Sale - Guide Price £4,500,000</h1>`,
    `<p><b>Council Tax</b> Conwy Borough Council</p>`,
    `<p>Garthewin Hall, LL22 8YR - Band I</p><p>The Flat, LL22 8YR - Band D</p>`,
    `<p><b>Directions</b> Postcode LL22 8YR</p>`,
    `<li><a href="https://maps.google.co.uk/maps?f=q&geocode=&q=LL22 8YR">Map</a></li>`,
    `<img src="https://www.uklandandfarms.co.uk/media/properties/thb_y.jpg"/>`,
  ].join("\n");
  const NO_HEADING_PC_TITLE =
    "507.33 acres, Abergele, Conwy, North Wales - UKLandandFarms.co.uk";

  it("recovers the PROPERTY postcode from the body when the heading has none, never the agent's office", () => {
    const parsed = parseUklfDetail(NO_HEADING_PC_HTML, NO_HEADING_PC_TITLE);
    expect(parsed?.postcode).toBe("LL22 8YR"); // the property, NOT CH1 1QU
    expect(parsed?.addressRaw).toBe("507.33 acres, Abergele, Conwy, North Wales");
    expect(parsed?.pricePence).toBe(450_000_000);
  });

  it("still prefers the heading postcode over the body when present", () => {
    // Regression guard: a heading WITH a postcode must not be overridden by a
    // (different) body postcode — the body recall is a fallback only.
    const parsed = parseUklfDetail(DETAIL_HTML, DETAIL_TITLE);
    expect(parsed?.postcode).toBe("CH7 6ES"); // heading wins; body fallback unused
  });
});

describe("uklfBodyPostcode", () => {
  it("prefers the Google-Maps geocode link (the property's mapped location)", () => {
    // Even though CH1 appears in the body, the geocode link pins the property.
    const html = [
      `<div class="agent"><p>Chester</p><p>CH1 1QU</p></div>`,
      `<a href="https://maps.google.co.uk/maps?f=q&geocode=&q=LL22 8YR">Map</a>`,
    ].join("\n");
    expect(uklfBodyPostcode(html)).toBe("LL22 8YR");
  });

  it("parses a maps-link geocode postcode regardless of + / %20 / space separators", () => {
    const mapsHref = (q: string) =>
      `<a href="https://maps.google.co.uk/maps?q=${q}">x</a>`;
    expect(uklfBodyPostcode(mapsHref("LL30+2YB"))).toBe("LL30 2YB");
    expect(uklfBodyPostcode(mapsHref("LL30%202YB"))).toBe("LL30 2YB");
    expect(uklfBodyPostcode(mapsHref("LL30 2YB"))).toBe("LL30 2YB");
  });

  it("ignores a q=<postcode> in a NON-maps URL (tracker) and finds the maps link", () => {
    // The exact mis-placement guard: a tracker carrying the agent's CH1 in its
    // own q= must NOT win over the property's maps geocode.
    const html = [
      `<a href="https://track.example.com/?ref=uklf&q=CH1+1QU">click</a>`,
      `<a href="https://maps.google.co.uk/maps?z=1&q=LL22+8YR">Map</a>`,
    ].join("\n");
    expect(uklfBodyPostcode(html)).toBe("LL22 8YR");
  });

  it("accepts an HTML-entity-encoded &amp; before the maps q= param", () => {
    expect(
      uklfBodyPostcode(
        `<a href="https://maps.google.co.uk/maps?z=1&amp;q=LL22+8YR">Map</a>`,
      ),
    ).toBe("LL22 8YR");
  });

  it("falls back to the single most-frequent postcode when there is no map link", () => {
    const html = [
      `<p>Chester office CH1 1QU</p>`, // agent, once
      `<p>LL15 1UL band E</p><p>LL15 1UL band D</p>`, // property, twice
    ].join("\n");
    expect(uklfBodyPostcode(html)).toBe("LL15 1UL");
  });

  it("returns null on a frequency tie (ambiguous → never guess the agent's)", () => {
    expect(uklfBodyPostcode("one CH1 1QU and one LL22 8YR")).toBeNull();
  });

  it("returns null when the body carries no postcode", () => {
    expect(uklfBodyPostcode("no postcode here")).toBeNull();
    expect(uklfBodyPostcode("")).toBeNull();
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

  // A faithful trim of a LIVE Pugh auction-EVENT page (captured 2026-06-06): each
  // lot is an IMAGE link to the lot (<a><img></a>), then the ADDRESS as its own
  // link ending in the PROPERTY postcode (with a trailing <br>), then the guide
  // price as plain text using the &pound; HTML entity.
  const EVENT_HTML = [
    `<div class="lot-card">`,
    `<a href="https://www.pugh-auctions.com/property/202603121543sq_aidl" class="block"><img src="https://asta.btgeddisonspropertyauctions.com/sdl_data/x/land.jpg?u=1" alt="Land at Bent Street"/></a>`,
    `<a href="https://www.pugh-auctions.com/property/202603121543sq_aidl" class="block">View Property</a>`,
    `<p>Multi-Lot Timed Auction</p>`,
    `<a href="https://www.pugh-auctions.com/property/202603121543sq_aidl" class="block">Land at Bent Street &amp; Elm Street, Newsome, Huddersfield, West Yorkshire HD4 6NX<br></a>`,
    `<p class="text-secondary"><span>Guide Price: &pound;130,000 plus</span></p>`,
    `</div>`,
  ].join("\n");

  it("parses a lot inline: property address+postcode+price+image, ignoring the image/View links", () => {
    const lots = parsePughLots(EVENT_HTML);
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
    expect(parsePughLots(`${EVENT_HTML}\n\n${EVENT_HTML}`)).toHaveLength(1);
  });

  it("skips a lot link whose text carries no postcode", () => {
    const html = `<a href="https://www.pugh-auctions.com/property/202601010000sq_zzzz" class="block">View Property</a>`;
    expect(parsePughLots(html)).toEqual([]);
  });

  it("omits the price when the event page has no guide price", () => {
    const html = `<a href="https://www.pugh-auctions.com/property/202601010000sq_abcd" class="block">Land at Foo, Leeds, West Yorkshire LS1 1AA</a>`;
    const lots = parsePughLots(html);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.pricePence).toBeUndefined();
    expect(lots[0]!.postcode).toBe("LS1 1AA");
  });
});

describe("uklfSearchEndpoint — paginated search endpoint from the index form", () => {
  // The REAL shape (captured live 2026-06-06): the region index is an ASP.NET
  // WebForms page whose <form> posts to /Search/SearchResult.aspx with a PageIndex
  // param. The pretty index URL 404s on ?PageIndex, but THIS endpoint pages over a
  // plain GET — so we lift it from the page (never hardcode the params) and walk it.
  const FORM_HTML = [
    `<html><body>`,
    `<form name="aspnetForm" method="post" action="../../../Search/SearchResult.aspx?keyword=&amp;Region=Wales&amp;County=North-Wales&amp;PageIndex=1&amp;kw=&amp;PropertyType=rural-property&amp;Status=sale" id="aspnetForm">`,
    `<a href='#page' onclick='onPagerClick(2);return false;'>Next</a>`,
    `</form></body></html>`,
  ].join("\n");
  const PAGE_URL =
    "https://www.uklandandfarms.co.uk/rural-property-for-sale/wales/north-wales/";

  it("lifts the SearchResult.aspx action, decodes &amp;, resolves it absolute", () => {
    const endpoint = uklfSearchEndpoint(FORM_HTML, PAGE_URL);
    expect(endpoint).not.toBeNull();
    const u = new URL(endpoint!);
    expect(u.hostname).toBe("www.uklandandfarms.co.uk");
    expect(u.pathname).toBe("/Search/SearchResult.aspx");
    expect(u.searchParams.get("Region")).toBe("Wales");
    expect(u.searchParams.get("County")).toBe("North-Wales");
    expect(u.searchParams.get("PropertyType")).toBe("rural-property");
    expect(u.searchParams.get("Status")).toBe("sale");
  });

  it("returns null when there is no SearchResult.aspx form (single-page → page 1 only)", () => {
    expect(
      uklfSearchEndpoint("<html><body>no pager here</body></html>", PAGE_URL),
    ).toBeNull();
    expect(uklfSearchEndpoint("", PAGE_URL)).toBeNull();
  });

  it("accepts an already-absolute action URL", () => {
    const html = `<form action="https://www.uklandandfarms.co.uk/Search/SearchResult.aspx?Region=Wales&amp;County=North-Wales&amp;PropertyType=rural-property&amp;Status=sale">x</form>`;
    const endpoint = uklfSearchEndpoint(html, PAGE_URL);
    expect(new URL(endpoint!).pathname).toBe("/Search/SearchResult.aspx");
    expect(new URL(endpoint!).searchParams.get("County")).toBe("North-Wales");
  });

  it("handles a single-quoted action attribute", () => {
    const html = `<form action='../../../Search/SearchResult.aspx?Region=Wales&amp;County=North-Wales'>x</form>`;
    expect(new URL(uklfSearchEndpoint(html, PAGE_URL)!).pathname).toBe(
      "/Search/SearchResult.aspx",
    );
  });

  it("refuses an OFF-HOST action (host pinned — the walk can't be redirected away)", () => {
    // A page-1 form whose action points off uklandandfarms (CDN injection, an
    // open redirect, a compromised page) must NOT drive the page walk off-host.
    const evil = `<form action="https://evil.example/Search/SearchResult.aspx?Region=Wales">x</form>`;
    expect(uklfSearchEndpoint(evil, PAGE_URL)).toBeNull();
    // A look-alike host suffix is also refused (exact host match).
    const lookalike = `<form action="https://www.uklandandfarms.co.uk.evil.example/Search/SearchResult.aspx">x</form>`;
    expect(uklfSearchEndpoint(lookalike, PAGE_URL)).toBeNull();
  });
});

describe("withPageIndex — set the page param on the search endpoint", () => {
  const ENDPOINT =
    "https://www.uklandandfarms.co.uk/Search/SearchResult.aspx?Region=Wales&County=North-Wales&PageIndex=1&PropertyType=rural-property&Status=sale";

  it("replaces an existing PageIndex (exactly once), preserving the other params", () => {
    const u = new URL(withPageIndex(ENDPOINT, 3));
    expect(u.searchParams.getAll("PageIndex")).toEqual(["3"]);
    expect(u.searchParams.get("Region")).toBe("Wales");
    expect(u.searchParams.get("County")).toBe("North-Wales");
    expect(u.searchParams.get("PropertyType")).toBe("rural-property");
  });

  it("appends PageIndex when the URL has none", () => {
    const u = new URL(
      withPageIndex(
        "https://www.uklandandfarms.co.uk/Search/SearchResult.aspx?Region=Wales",
        4,
      ),
    );
    expect(u.searchParams.get("PageIndex")).toBe("4");
    expect(u.searchParams.get("Region")).toBe("Wales");
  });

  it("returns the input unchanged for an unparseable URL", () => {
    expect(withPageIndex("not a url", 2)).toBe("not a url");
  });
});
