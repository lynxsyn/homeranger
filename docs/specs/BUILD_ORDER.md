# homescout — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homescout-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. Build starts at M8 (M1–M7 + the HomeScout design-system listings UI shipped; design bundle at `docs/design/homescout-design/`).

## To build (top-down priority)

> **Product reframe (2026-06-02, operator):** the app is the discover→outreach→ingest→table LOOP. The operator sets a UK region (by name, e.g. Conwy County) + free-text requirements; the system DISCOVERS estate agents in that region, cold-emails them (ComplianceGuard-gated) with the requirements woven in, and their replies populate a filter-free listings table. This replaces the M7-dashboard spec.

| Name | Why | Sizing |
|---|---|---|
| M8-campaign-loop | The visible loop (last milestone): a `CampaignPage` (pick region from the M7 region map + write requirements → launch) that triggers `discover:agents` then ComplianceGuard-gated outreach with the requirements woven into the draft, and surfaces the discovered agents for operator review before sending (PECR-boundary checkpoint) + the kill-switch as the safety control. Build it in the HomeScout design system (tokens + primitives in `apps/web/src`). The filter-free listings table already shipped. E2E: launch a campaign (fake discovery + fake send) → guarded sends → kill-switch halts them. | M |
