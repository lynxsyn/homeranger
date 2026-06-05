---
decision_id: 2026-06-05-listing-site-ingestion
status: accepted
date: 2026-06-05
supersedes: none
amends: 2026-06-01-data-source-viability
---

# Decision: Ingest listings from two niche public sites (uklandandfarms, auctionhouse) behind a swappable, dormant-by-default scrape provider

## Context

The operator wants for-sale listings from two specific UK sites surfaced inside
homeranger alongside the agent-email listings, so everything is browsable in one
filterable table:

- `https://www.uklandandfarms.co.uk` — rural property / land / farms portal.
- `https://www.auctionhouse.co.uk` — UK property auction network.

The explicit, narrow ask: **link out to the source listing; do NOT download or
store images or full metadata.** Just enough to show the row and click through
(address, price, and the source URL), and enough location (postcode/outcode) to
match it to the operator's active Searches.

> **Amendment (2026-06-05, listing-images):** a single **hotlinked image URL** is
> now also captured per listing so the table can show a thumbnail. This is a
> *reference only* — the image is **never downloaded or stored**; the browser
> loads it directly from the source's own image host (an allowlist of the sites'
> CDNs) and we hold only the URL string. No reproduction, no redistribution. This
> stays within the minimisation + no-redistribution posture below; full-metadata /
> image **download** remains out of scope.

This **amends** `2026-06-01-data-source-viability.md`, which dropped portal
scraping for v1. That decision was about **gated, scraping-prohibited mass portals**
(Rightmove RTDF / Zoopla API are agent/broker-gated; their ToS prohibit scraping)
and the absence of any compliant *redistributable* live API. It deliberately
**kept the `ListingSourceRecord` adapter seam** for the case where "a compliant
live source … can be added as a new adapter + config, without reworking the data
model," and reserved the `personal_use_ok` licence class for exactly that. It also
established the product's honest shape — *"APIs/sources = enrichment; click through
to the source for detail."* This decision uses that reserved seam for two specific,
public, non-gated sites under a single-user personal-use basis. It does **not**
re-open Rightmove/Zoopla or any gated/scraping-prohibited portal.

The product UI stance from the Scouts/listings refresh ("homeranger doesn't scrape
portals → listing status is unused in the UI") is **narrowly reversed**: scraped
rows are real, public, click-out listings. Status remains a DB field; the UI
continues to lead with the match score + click-through, not a portal-style status
badge.

## Legal assessment (per site)

Single-user, self-hosted, non-commercial tool, operator-triggered, results visible
only to the operator behind Cloudflare Access. The lawful-collection record is
`docs/compliance/listing-sourcing-basis.md`.

### robots.txt (verified 2026-06-05)

| Host | Relevant rules | Consequence for us |
|---|---|---|
| `www.uklandandfarms.co.uk` | Disallows only `/customers/`, `/agent/`. No crawl-delay. | Listing + search paths **allowed**. |
| `www.auctionhouse.co.uk` | Disallows `/search-results`, `/*print-lot/`, `/*outbound/`, account/blog/etc. Publishes `sitemap.xml` (navigational: regional hubs, guides — no lot URLs). | **Do not** scrape `/search-results` or `/print-lot/`. Reach lots via the allowed regional-room pages. |
| `online.auctionhouse.co.uk`, `wales.auctionhouse.co.uk` (where lots live, `/lot/redirect/<id>`) | ~150 named bots fully blocked (Ahrefs, Semrush, Wget, harvesters…). Catch-all `*` disallows `/search?*token=*`, `/calendar/upcoming-auctions`, `/error/`, `/signalr`, `/asset-file-item/`. **`Crawl-delay: 5`**. `/lot/` **not** disallowed. | Lot pages allowed for a polite, non-denylisted crawler. **Must honour the 5s crawl-delay** and confirm the fetcher's UA is not on the denylist. |

### Terms of Service (verified 2026-06-05)

- **uklandandfarms** Terms of Use: *expressly permits* personal use —
  *"You may print off copies, and may download extracts, of any pages from our
  site in connection with your own use of our site."* Prohibits **commercial use**
  (*"You must not use any part of the materials … for commercial purposes without
  obtaining a licence"*) and **modification** of copies. No anti-automation clause.
  Our use (single-user, non-commercial, link-out, no republishing) is **within the
  granted permission**.
- **auctionhouse**: publishes **no website Terms of Use** (`/terms`,
  `/terms-and-conditions`, `/terms-of-use` all 404; footer carries only a privacy
  policy, a cookie-policy PDF, and the auction *sale* conditions PDF — none of
  which govern website reuse). Privacy policy is silent on reuse. Nothing prohibits
  personal automated link-out use; nothing expressly grants it. Posture: proceed
  strictly within robots.txt + minimisation + no redistribution.

### Database right / copyright

UK sui-generis database right can be engaged by systematic extraction of a
substantial part, even for personal use. Mitigations, all enforced in code/conduct:
extract only the **minimum** to identify and link a listing (address, price,
outcode, source URL, plus a hotlinked image URL displayed from the source's own
host) — **no stored/copied images, no descriptive copy, no bulk re-publication**;
store provenance; **never redistribute** (single user, behind auth). This is the
lowest-risk shape and matches the `personal_use_ok` class the prior ADR reserved.

### GDPR

Listing rows are property data, not personal data. We deliberately do **not**
capture the listing agent's or vendor's personal contact from these sites
(minimisation). Outreach/PECR is unaffected — these are a **read-only listing
source**, never an outreach target.

## Decision

1. Add a swappable **`ListingScrapeProvider`** interface (`lib/listing-scrape/`),
   mirroring the `AgentDiscoveryProvider` pattern, with one adapter per site:
   `FirecrawlUklandandfarmsProvider`, `FirecrawlAuctionhouseProvider`.
2. A deterministic **`FakeListingScrapeProvider`** (`LISTING_SCRAPE_FAKE=1`) backs
   all unit/integration/E2E — **no network, no spend** in the pipeline (same posture
   as `DISCOVERY_FAKE`).
3. **Dormant-by-default + per-site enable.** The real adapters are
   construction-safe (worker boots without `FIRECRAWL_API_KEY`); a scrape job with
   no key / a disabled site fails non-retryably (logged drop). New optional config:
   `LISTING_SCRAPE_SITES` (comma list of enabled site keys; empty ⇒ feature off)
   plus the existing `FIRECRAWL_API_KEY`. Building it costs nothing; only enabling
   does.
4. **New `ListingSource` enum values** `uklandandfarms`, `auctionhouse`
   (migration `0012`). Scraped rows set `primarySource` to the site, `listingUrl`
   to the source page, `listingStatus = live`, and a `ListingSourceRecord`
   (`sourceType` = site, `externalId` = the site's listing id, `sourceUrl` = the
   page) for provenance + idempotent re-scrape.
5. **Reuse the existing pipeline unchanged**: normalise address → `DedupService`
   (exact `addressNormalized`, embedding fallback) → `listingRepository`
   upsert/merge → enqueue `analyze:listing` (text embed + per-Search match; photo
   analysis is a no-op with no images, as for email listings without attachments).
   So scraped listings appear in the same scored, filter-free table with a working
   click-out, no downstream changes.
6. **Trigger**: a `scrape:listings` queue (4-structure lockstep) consumed by the
   processor; the scheduler registers a leader-locked repeatable job that scrapes
   the enabled sites scoped to the **outcodes of active operator Searches** (same
   per-Search outcode model as discovery). Also operator-triggerable.
7. **Conduct enforced in code**: honour robots.txt per host (uklandandfarms via
   `propertylink.xml` / county path `/rural-property-for-sale/<region>/<county>/`;
   auctionhouse via regional-room pages → `/lot/...`, never `/search-results` or
   `/print-lot/`); respect `Crawl-delay: 5` on the auctionhouse lot subdomains;
   per-run result cap; dedup + provenance. Configure Firecrawl to honour robots and
   confirm its UA is not on the auctionhouse denylist before enabling.

## Consequences

- New optional config `LISTING_SCRAPE_SITES` (+ reuses `FIRECRAWL_API_KEY`,
  `FIRECRAWL_BASE_URL`, a new `LISTING_SCRAPE_LIMIT`). Wire as `optional: true`
  secret/env on processor + scheduler when enabling (mirrors discovery).
- Adapters are **operator-proven, not unit-tested** (network I/O, coverage-
  excluded) like `FirecrawlAgentDiscoveryProvider` — verify each site's request
  shape, robots handling, and crawl-delay against the live site when first enabling.
- Residency: Firecrawl is US-resident; consistent with the already-waived US-vendor
  posture (only public listing facts transit it; no personal data).
- This widens the data model's live sources from 1 (agent email) to 3; the
  `addressNormalized` dedup means the same property from an agent and a site
  collapses into one row (best-effort; auction "Land at …" addresses dedup weakly —
  accepted).
- **Not in scope / not reopened**: Rightmove, Zoopla, or any gated or
  scraping-prohibited portal; image/photo **download or storage** (hotlinked image
  URL *display* is in scope per the amendment above); redistribution.

## Review

Re-assessed if a site changes its robots.txt or ToS, if extraction volume grows
materially, or if the tool stops being single-user/non-commercial (which would
break the uklandandfarms ToS personal-use permission and require a licence).
