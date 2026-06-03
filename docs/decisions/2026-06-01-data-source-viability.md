---
decision_id: 2026-06-01-data-source-viability
status: accepted
date: 2026-06-01
gate: M0 — data-source viability (validation-gate.md)
supersedes: none
---

# Decision: No compliant API channel — agent email is the sole source (v1)

## Context

The product needs UK for-sale (ideally pre-market) listings with an address, price, and a click-out URL. The M0 gate asks: does any **compliant, buyer-accessible** (no member-agent/MLS/broker relationship, no scraping) source return a **live for-sale listing feed**, versus only **analytics** (sold prices, valuations, EPC, area stats)? And what are the redistribution / personal-use licence terms?

## Findings (June 2026 research — 95% confidence)

| Source | Live for-sale feed? | Access | Proposed licence class | Notes |
|---|---|---|---|---|
| Rightmove RTDF | Yes | **Agent/broker-gated** (certificate auth) | n/a | Inaccessible to a private buyer |
| Zoopla API | Yes | **Broker-gated** (commercial agreement, OAuth) | n/a | Inaccessible to a private buyer |
| PropertyData (~£28/mo) | Aggregated live asking prices | Public API | `enrichment_only` | Redistribution of substantially-aggregated data prohibited; inherits portal restrictions |
| PaTMa (~£20/mo) | Analytics-primary; live freshness unclear | Public API | `enrichment_only` | T&Cs prohibit harvesting; inherits portal restrictions |
| Homedata | Yes (non-gated live listings) | Public API | `personal_use_ok` | Redistribution prohibited; usable only for single-user personal use |
| HM Land Registry PPD | No (historical sold only) | Open data | `open_gov` (OGL v3.0) | PAF address caveat |
| EPC register | No (reference energy certs) | Open data/API | `open_gov` (OGL v3.0) | Reference only |

**Conclusion:** there is **no compliant buyer-accessible live for-sale API with redistribution rights.** The honest architecture is "APIs = enrichment only; agent email = the live source" — which also happens to match the "before it's live" goal, since pre-market homes flow through agent relationships, not portals.

## Decision

**Drop the compliant-API channel entirely for v1. Agent email is the sole source.**

The user elected the simplest coherent shape: ingest listings from agent emails, and **click through to the agent's own page** (via the stored `listingUrl`) for any detail the email doesn't carry (EPC, comps, area stats). The in-app table shows only what the agent's email states (price, beds, EPC *if* mentioned) plus homeranger's own AI taste scores — everything else is one click away on the source page.

### What this removes from the original plan
- The `ListingSourceAdapter` framework and all data adapters (PropertyData / PaTMa / Land Registry / EPC).
- The `ingest:poll` job and its scheduler registration.
- `PROPERTYDATA_API_KEY` / `PATMA_API_KEY` secrets.
- The `lib/ssrf/` outbound guard (no arbitrary outbound HTTP remains — only Resend/Voyage/Anthropic SDK hosts).
- The `licenceClass` field on `ListingSourceRecord` (no API licences to track; `sourceType ∈ agent_email|manual`).
- The original **M4 (Compliant API ingestion)** milestone and its Channel-2 E2E proof.

### Why this is safe to defer rather than build
The `ListingSourceRecord` provenance model and the (now-removed) adapter seam mean a compliant live API — should one ever appear, or should the personal-use **Homedata** feed be adopted later — can be added as a **new adapter + config**, without reworking the data model. The `personal_use_ok` licence class is reserved for exactly that future case.

## Consequences / follow-ups
- A real PropertyData/PaTMa key-based spike is **no longer required** — the licence conclusion stands without it.
- If the table feels too sparse in practice, the cheapest reconsideration is adopting **Homedata** (`personal_use_ok`) as a single live adapter — a config-level change, re-opened as its own spec, not a v1 commitment.
