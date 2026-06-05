# Listing-sourcing basis (scraped public listing sites)

> **Scope:** SOURCING listings by reading specific public UK listing sites
> (`uklandandfarms.co.uk`, `auctionhouse.co.uk`, `pugh-auctions.com`) for a
> single-user, self-hosted,
> non-commercial tool. This records the lawful + contractual basis for COLLECTING
> those listings. It complements `agent-sourcing-basis.md` (agent contacts) and the
> M6 send LIA (`legitimate-interest-basis.md`); scraped listings are a **read-only
> data source and are NEVER an outreach target.** Decision:
> `docs/decisions/2026-06-05-listing-site-ingestion.md`.

## What is collected, and from where

The **minimum** to show a row and link to its source, for properties whose outcode
falls inside an active operator Search:

- property **address** + derived **postcode/outcode**,
- **asking/guide price** (integer pence),
- the **source listing URL** (the click-out),
- a **single hotlinked image URL** (a *reference* only — see below),
- provenance: the site (`sourceType`) + the site's listing id (`externalId`).

**Hotlinked, not stored:** one image **URL** per listing is captured so the table
can show a thumbnail. The image itself is **never downloaded, copied, or stored** —
the browser loads it **directly from the source's own image host** (an allowlist of
the sites' CDNs), and we hold only the URL string. This is the lowest-footprint way
to show a photo: no reproduction, no redistribution, just a pointer back to the
publisher's own copy. A failed/blocked hotlink falls back to a placeholder.

**Not collected:** downloaded/stored images, descriptive marketing copy,
floorplans, EPC documents, agent or vendor personal contact details. No
special-category data.

## Contractual basis (site terms)

- **uklandandfarms** Terms of Use *expressly permit* personal use: *"You may print
  off copies, and may download extracts, of any pages from our site in connection
  with your own use of our site."* They prohibit **commercial** use and
  **modification** of copies. Our use is single-user, non-commercial, link-out, and
  does not republish or modify their content, so it is within the granted licence.
  If the tool ever became commercial or multi-tenant, this permission lapses and a
  licence would be required (see Review).
- **auctionhouse** publishes **no website Terms of Use** (verified 2026-06-05:
  `/terms`, `/terms-and-conditions`, `/terms-of-use` all 404; only a privacy policy,
  cookie policy, and auction *sale* conditions exist). Nothing prohibits personal
  automated link-out use. Posture: proceed strictly within robots.txt +
  minimisation + no redistribution.
- **pughauctions** (`pugh-auctions.com`) Terms of Use *expressly permit* personal
  use (verified 2026-06-05): *"You are permitted to display the materials on this
  website on a computer screen and to download and print a hard copy for your
  personal use provided that you do not alter or remove any copyright, trade mark
  or other proprietary notices."* No clause prohibits automated access. Our use is
  single-user, non-commercial, link-out, and does not alter their content, so it is
  within the granted licence (the same posture as uklandandfarms; the commercial /
  multi-tenant caveat applies equally). NB the firm is migrating to BTG Eddisons —
  lot images already serve from `asta.btgeddisonspropertyauctions.com`, which is on
  the hotlink host-allowlist.

## Data-right basis

UK database right / copyright can be engaged by systematic extraction of a
substantial part of a database. Held in balance by **minimisation** (facts needed
to identify + link only — address, price, outcode, URL, plus an image URL we
hotlink but never copy; no stored images, no descriptive copy), **no
redistribution** (single user, results behind Cloudflare Access), provenance
retention, and an operator-triggered / scheduled-not-continuous cadence. This is the
`personal_use_ok` posture reserved in the data-source-viability ADR.

## Collection conduct (enforced in code)

- **Honour robots.txt per host** (verified 2026-06-05):
  - `uklandandfarms` — only `/customers/`, `/agent/` disallowed; enumerate via
    `propertylink.xml` or the county path `/rural-property-for-sale/<region>/<county>/`.
  - `www.auctionhouse.co.uk` — never fetch `/search-results` or `/*print-lot/`;
    reach lots through the allowed regional-room pages.
  - `online.auctionhouse.co.uk` / `wales.auctionhouse.co.uk` (lot pages) — `/lot/`
    is allowed; **respect `Crawl-delay: 5`**; the fetcher's user-agent must not be
    on the ~150-bot denylist. Confirm Firecrawl's UA + robots handling before
    enabling.
  - `www.pugh-auctions.com` — `Allow: /` with only `/adm` disallowed; **no
    `Crawl-delay`**. Enumerate via the national `/auction-diary` → each
    `/auction/<id>` event page (lots inline) → the `/property/<id>` link-out. Never
    fetch `/adm`. A national catalogue: scraped whenever a Search has target
    outcodes, then outcode-filtered to the operator's patch.
- **Minimise**: persist only the fields listed above.
- **Per-run cap** (`LISTING_SCRAPE_LIMIT`) bounds volume + spend.
- **Provenance**: store the source URL + site listing id (`ListingSourceRecord`),
  idempotent on `(sourceType, externalId)` so a re-scrape updates rather than
  duplicates.
- **Dormant by default**: disabled unless `FIRECRAWL_API_KEY` is set AND the site
  is listed in `LISTING_SCRAPE_SITES`. Operator-triggered or scheduled, never a
  continuous crawl.
- **No outreach** is ever sent to a scraped site, its agents, or its vendors; these
  sites are a data source only.

## Review

Re-assessed if a site changes its robots.txt or ToS, if extraction volume grows
materially, or if the tool ceases to be single-user / non-commercial (which voids
the uklandandfarms personal-use permission). A site that adds an anti-automation or
no-reuse clause is removed from `LISTING_SCRAPE_SITES` until re-assessed.
