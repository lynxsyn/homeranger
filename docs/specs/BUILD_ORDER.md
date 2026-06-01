# homescout — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homescout-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. Build starts at M3 (M1, M2 shipped).

## To build (top-down priority)

| Name | Why | Sizing |
|---|---|---|
| M3-listings-table | First demoable slice and the product's core surface: `listingsRouter` (list/filter/sort/paginate) + hand-rolled accessible `ListingsPage` table with click-out cell. Built on fixtures (real data arrives at M4). Proves the read path + UI end-to-end. See `docs/specs/M3-listings-table.md`. | M |
| M4-inbound-ingestion | The **live data path** — the only thing that fills the table for real. Resend inbound-parse webhook (raw route before tRPC) → Claude structured extraction (free text + PDF/image attachments) → dedup → upsert `Listing` (`isPreMarket`, agent `listingUrl`). Lower risk than outbound (no ComplianceGuard needed). See `docs/specs/M4-inbound-ingestion.md`. | L |
| M5-ai-analysis | The product's differentiator: Haiku vision taste-scoring + feature detection, Voyage embedding, and preference matching (`vectorTopK` → LLM re-score top-K → `ListingScore`) so the table ranks by *your* taste. Cost-bounded (top-K only, `imageHash` dedup, `costPence` recorded). See `docs/specs/M5-ai-analysis.md`. | L |
| M6-outreach-complianceguard | **Highest risk, last.** Autonomous-but-guarded outbound: `OutreachService` + the load-bearing `ComplianceGuard` (PECR corporate-only / opt-out / suppression / circuit-breaker / kill-switch / warmup-cap), `outreach:send`/`followup` jobs, GDPR legitimate-interest + ROPA + honoured unsubscribe. One RED test per guard gate. See `docs/specs/M6-outreach-complianceguard.md`. | L |
| M7-outreach-dashboard | Operator visibility + the safety backstop surfaced in UI: `outreachRouter.metrics` (warmup/bounce/complaint) + `killSwitch.toggle`, `OutreachDashboard` page. E2E: toggle halts sends. See `docs/specs/M7-outreach-dashboard.md`. | M |
