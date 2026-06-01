# homescout — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homescout-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. Build starts at M1.

## To build (top-down priority)

| Name | Why | Sizing |
|---|---|---|
| M1-infra-scaffold | Nothing integration/E2E can run until a **standalone tenant** exists: own Flux source, `homescout` namespace + default-deny NetworkPolicy, dedicated `homescout-postgres` (`pgvector/pgvector:pg17`, `CREATE EXTENSION vector`), `homescout-redis`, own age-encrypted secrets, own dedicated email domain + Resend DNS. INFRA-FIRST HARD-GATE: DB+Redis reachable and `vector` created before any later milestone. See `docs/specs/M1-infra-scaffold.md`. | L |
| M2-data-model | The whole app reads/writes one Postgres table set. Prisma schema + raw pgvector migration (`vector(1024)` + HNSW cosine) + repositories (routers→services→repos, repos own ALL Prisma, `{items,nextCursor}` pagination, prices as integer pence) incl. the raw `vectorTopK`. Everything downstream depends on it. See `docs/specs/M2-data-model.md`. | L |
| M3-listings-table | First demoable slice and the product's core surface: `listingsRouter` (list/filter/sort/paginate) + hand-rolled accessible `ListingsPage` table with click-out cell. Built on fixtures (real data arrives at M4). Proves the read path + UI end-to-end. See `docs/specs/M3-listings-table.md`. | M |
| M4-inbound-ingestion | The **live data path** — the only thing that fills the table for real. Resend inbound-parse webhook (raw route before tRPC) → Claude structured extraction (free text + PDF/image attachments) → dedup → upsert `Listing` (`isPreMarket`, agent `listingUrl`). Lower risk than outbound (no ComplianceGuard needed). See `docs/specs/M4-inbound-ingestion.md`. | L |
| M5-ai-analysis | The product's differentiator: Haiku vision taste-scoring + feature detection, Voyage embedding, and preference matching (`vectorTopK` → LLM re-score top-K → `ListingScore`) so the table ranks by *your* taste. Cost-bounded (top-K only, `imageHash` dedup, `costPence` recorded). See `docs/specs/M5-ai-analysis.md`. | L |
| M6-outreach-complianceguard | **Highest risk, last.** Autonomous-but-guarded outbound: `OutreachService` + the load-bearing `ComplianceGuard` (PECR corporate-only / opt-out / suppression / circuit-breaker / kill-switch / warmup-cap), `outreach:send`/`followup` jobs, GDPR legitimate-interest + ROPA + honoured unsubscribe. One RED test per guard gate. See `docs/specs/M6-outreach-complianceguard.md`. | L |
| M7-outreach-dashboard | Operator visibility + the safety backstop surfaced in UI: `outreachRouter.metrics` (warmup/bounce/complaint) + `killSwitch.toggle`, `OutreachDashboard` page. E2E: toggle halts sends. See `docs/specs/M7-outreach-dashboard.md`. | M |
