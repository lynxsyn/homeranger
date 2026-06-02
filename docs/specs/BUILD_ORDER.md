# homescout — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homescout-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. Build starts at M5 (M1–M4 shipped).

## To build (top-down priority)

| Name | Why | Sizing |
|---|---|---|
| M5-ai-analysis | The product's differentiator: Haiku vision taste-scoring + feature detection, Voyage embedding, and preference matching (`vectorTopK` → LLM re-score top-K → `ListingScore`) so the table ranks by *your* taste. Cost-bounded (top-K only, `imageHash` dedup, `costPence` recorded). See `docs/specs/M5-ai-analysis.md`. | L |
| M6-outreach-complianceguard | **Highest risk, last.** Autonomous-but-guarded outbound: `OutreachService` + the load-bearing `ComplianceGuard` (PECR corporate-only / opt-out / suppression / circuit-breaker / kill-switch / warmup-cap), `outreach:send`/`followup` jobs, GDPR legitimate-interest + ROPA + honoured unsubscribe. One RED test per guard gate. See `docs/specs/M6-outreach-complianceguard.md`. | L |
| M7-outreach-dashboard | Operator visibility + the safety backstop surfaced in UI: `outreachRouter.metrics` (warmup/bounce/complaint) + `killSwitch.toggle`, `OutreachDashboard` page. E2E: toggle halts sends. See `docs/specs/M7-outreach-dashboard.md`. | M |
