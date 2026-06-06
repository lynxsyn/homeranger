---
decision_id: 2026-06-02-agent-discovery-vendor
status: superseded
date: 2026-06-02
supersedes: none
superseded_by: 2026-06-06 Serper + in-process fetch (see note below)
---

> **SUPERSEDED 2026-06-06.** Firecrawl has been **decommissioned**. The
> swappable interface this ADR introduced did its job: agent **discovery** now
> uses a Serper.dev SERP API + an in-process HTTP fetch
> (`serper-agent-discovery.provider.ts`), and listing/auction **scraping** uses
> an in-process HTTP fetch (`fetch-listing-scrape.provider.ts`) — both over the
> shared SSRF-hardened `lib/http/page-fetch.ts`, with no Firecrawl credits and no
> headless browser. Rationale: the 2026-06-06 adversarial architecture review
> (Firecrawl-cloud cost; SearXNG's silent-failure rejected; Crawl4AI/WaterCrawl/
> BrowserPilot rejected as too heavy). `FIRECRAWL_API_KEY` is removed. The
> historical decision below is retained for context.

# Decision: Agent discovery vendor = Firecrawl (behind a swappable interface)

## Context

The product loop (operator reframe 2026-06-02) requires sourcing estate agents in
a chosen UK region to cold-contact. The data-source decision established email as
the only live channel and ruled out a listing API; it did not specify how the
*contact list* is built. The operator chose autonomous discovery (vs manual
import). We need a web search + content-extraction capability the deployed app can
call to find agency pages and extract business emails.

## Options

| Option | Notes |
|---|---|
| **Firecrawl** | Single API for web search + scrape + (optional) LLM extraction; managed, handles JS-rendered sites; pay-as-you-go. Good fit for "search agents in region → scrape → extract emails". (Verify its robots.txt/ToS handling before enabling — we rely on the vendor's fetch, not our own robots logic.) |
| Raw search API (Brave/SerpAPI) + DIY scraper | More moving parts (search + fetch + parse + anti-bot); we'd own scraping robustness. |
| Manual import only | The operator's chosen path was discovery, not manual; rejected. |

## Decision

Use **Firecrawl** for the real `AgentDiscoveryProvider`, **behind the
`AgentDiscoveryProvider` interface** (`lib/discovery/`) so the vendor is swappable
(a raw-search adapter or a directory adapter can drop in without touching the
service). A deterministic `FakeAgentDiscoveryProvider` (`DISCOVERY_FAKE=1`) backs
all tests/CI/E2E — **no network, no spend** in the pipeline.

### Dormant-by-default (the M6 env-wiring lesson)

The real adapter reads `FIRECRAWL_API_KEY` but is **construction-safe**: with the
key unset it constructs fine (worker boots) and a `discover:agents` job fails
non-retryably (logged drop), so discovery is simply **disabled** until the
operator adds the key + accepts the spend. Building it incurs no cost; only
enabling it does.

## Consequences

- New optional secret `FIRECRAWL_API_KEY` (+ optional `FIRECRAWL_BASE_URL`,
  `DISCOVERY_SEARCH_LIMIT`). Wire as an `optional: true` secretKeyRef on the
  processor when enabling (mirrors `RESEND_FROM`).
- Sourcing conduct + lawful basis: `docs/compliance/agent-sourcing-basis.md`.
- Verify the Firecrawl `/v1/search` request/response shape against current docs
  when first enabling (the adapter is operator-proven, not unit-tested).
- Residency: Firecrawl is US-resident; consistent with the already-waived
  US-vendor posture for this personal tool (email-provider decision). Only public
  business-contact data transits it.
