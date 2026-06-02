---
spec_id: M7-region-agent-discovery
status: queued
bump: minor
risk_class: tier-4
---

# Spec: M7 — Region model + autonomous agent discovery

## Why now

The product loop (operator reframe 2026-06-02) is: pick a UK region by name + state
requirements → the system finds estate agents in that region → cold-emails them
(ComplianceGuard-gated) → their replies fill the listings table. Today agents only
enter the DB when they reply to us; there is no way to source "all agents in a
region" to cold-contact. This milestone builds that missing core — region resolution
+ autonomous agent discovery — so M8 can wire the campaign UI on top.

## Goal

Given a UK region name (e.g. "Conwy County"), resolve its postcode outcodes and
discover estate agents operating there (agency name + business email), classify each
mailbox, and upsert them as `Agent`s ready for the existing ComplianceGuard-gated
outreach — all behind a swappable provider with a deterministic test fake.

## Non-goals

- The campaign UI + the requirements-into-draft wiring + de-filtering the table (M8).
- A complete UK region dataset — a curated, extensible map is enough for v1.
- Re-verifying mailbox type beyond the domain heuristic (the guard is the backstop).

## Acceptance criteria

1. `lib/geo/uk-regions.ts` resolves a region name → its postcode outcodes
   (`regionToOutcodes("Conwy County") → ["LL28","LL29",…]`) and exposes the list of
   supported region names for the UI. Lookup is case/spacing-insensitive; an unknown
   region returns an empty result (no throw). Seeded with a curated set including
   Conwy County; structured so adding regions is a data edit.
2. `AgentDiscoveryProvider.discover({ region, outcodes })` returns
   `DiscoveredAgent[]` (`{ email, agencyName, websiteUrl? }`). The real impl uses a
   web search/extract vendor (Firecrawl, decided in a committed decision doc) behind
   the interface; an env-gated `FakeAgentDiscoveryProvider` (`DISCOVERY_FAKE=1`)
   returns deterministic fixtures so E2E/CI never hit the network.
3. `AgentDiscoveryService.discoverRegion(regionName)` resolves outcodes (AC#1), calls
   the provider, and for each result: normalises the email, classifies
   `mailboxType` (a business/agency domain ⇒ `corporate_subscriber`; a free webmail
   domain — gmail/outlook/yahoo/… ⇒ `individual`), skips already-suppressed emails,
   and `agentRepository.upsertByEmail` with `coveredOutcodes = region outcodes`.
   Idempotent (re-discovery upserts, never duplicates). Returns a summary
   `{ discovered, upserted, skipped }`.
4. A `discover:agents` BullMQ job (processor, consume-only) runs
   `AgentDiscoveryService.discoverRegion` for a `{ regionName }` payload, with the
   queue-config 4-structure lockstep + an `enqueueDiscoverAgents` helper. Errors are
   retryable (transient search/scrape failures) via the existing worker-error mapper.
5. Compliance: a documented legitimate-interest basis for sourcing PUBLIC business
   contacts (`docs/compliance/agent-sourcing-basis.md`); only business-domain mailboxes
   are classified `corporate_subscriber` (the only class the ComplianceGuard will
   send to), so a discovered personal mailbox is sourced but never cold-emailed; the
   discovery vendor decision is recorded (`docs/decisions/<date>-agent-discovery-vendor.md`).

## Allowed edit surface

- `packages/backend-core/src/lib/geo/uk-regions.ts` + `__tests__`.
- `packages/backend-core/src/lib/discovery/{agent-discovery.provider,fake-agent-discovery.provider,firecrawl-agent-discovery.provider}.ts`.
- `packages/backend-core/src/services/agent-discovery.service.ts` + test.
- `packages/backend-core/src/lib/queue/{queue-config,queue-client,enqueue}.ts` (the `discover:agents` queue).
- `apps/processor/src/discover-agents-handler.ts` + test + `worker.ts` wiring.
- `docs/compliance/agent-sourcing-basis.md`, `docs/decisions/<date>-agent-discovery-vendor.md`.

## Test plan

| Layer | Coverage |
|---|---|
| Unit | `regionToOutcodes` resolves Conwy County (+ case/space-insensitive); unknown region → empty. |
| Unit | discovery service classifies `corporate_subscriber` vs `individual` by domain; skips suppressed; upserts with region outcodes; idempotent. |
| Unit | `FakeAgentDiscoveryProvider` returns deterministic fixtures; provider interface contract. |
| Unit | `discover:agents` handler delegates + maps a transient error to retryable. |
| Integration | discovery service (fake provider) upserts real `Agent` rows with the region's outcodes; re-run is idempotent. |

## Definition of Done

RED region + discovery-service tests first → GREEN provider + service + job · coverage
≥ threshold · integration green · agent-sourcing basis + vendor decision committed ·
review APPROVED · release tag (MINOR) · post-release verify green. Then M8 wires the
campaign UI + requirements-into-draft + the de-filtered table on top.
