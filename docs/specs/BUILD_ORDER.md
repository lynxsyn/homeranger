# homescout — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homescout-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. Build starts at M7 (M1–M6 shipped).

## To build (top-down priority)

| Name | Why | Sizing |
|---|---|---|
| M7-outreach-dashboard | Operator visibility + the safety backstop surfaced in UI: `outreachRouter.metrics` (warmup/bounce/complaint) + `killSwitch.toggle`, `OutreachDashboard` page. E2E: toggle halts sends. See `docs/specs/M7-outreach-dashboard.md`. | M |
