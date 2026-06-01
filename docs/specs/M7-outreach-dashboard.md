---
spec_id: M7-outreach-dashboard
status: queued
bump: minor
risk_class: tier-2
---

# Spec: M7 — Outreach dashboard

## Why now

The autonomous outreach loop (M6) needs operator visibility and a one-click backstop surfaced in the UI. This is the last milestone — it renders the metrics and kill switch the guard already exposes.

## Goal

An `OutreachDashboard` page showing warmup/bounce/complaint health and threads, with a kill switch that halts all sends.

## Non-goals

- New outreach logic (M6 owns sending + the guard).
- Analytics beyond the breaker/warmup signals.

## Acceptance criteria

1. `outreachRouter` exposes: `metrics` (warmup state + daily cap usage, bounce rate, complaint rate over the `EmailEvent` window, sends today), `threads` (list/paginate `OutreachThread` with status + last message), and `killSwitch.toggle` (read + set the persisted flag).
2. `OutreachDashboard` (mirror the hand-rolled accessible table pattern) renders metrics cards + a threads table + a kill-switch control with an explicit confirm state.
3. Toggling the kill switch ON immediately causes `ComplianceGuard` gate (5) to block sends (proven via the worker), and the UI reflects the ON state on reload.
4. Metrics degrade gracefully (empty/loading/error states) when there is no outreach history yet.

## Allowed edit surface

- `packages/backend-core/src/routers/outreach.router.ts` + `__tests__`.
- `apps/web/src/pages/OutreachDashboard.tsx` + components.
- `e2e/outreach-dashboard.spec.ts`.

## Test plan

| Layer | Coverage |
|---|---|
| Unit | `outreachRouter.metrics` computes bounce/complaint rates + cap usage from seeded `EmailEvent`/`WarmupState`. |
| Unit | `killSwitch.toggle` persists and reads back; unauthorized caller rejected. |
| E2E | Dashboard renders metrics + threads; toggling the kill switch ON halts a subsequent `outreach:send` (no `OutreachMessage` created) and the UI shows ON after reload. |

## Definition of Done

RED metrics + kill-switch tests first → GREEN dashboard · coverage ≥ threshold · kill-switch E2E green · review APPROVED · release tag (MINOR) · post-release verify green · BUILD_ORDER refilled from PRODUCT/ARCHITECTURE if the queue is thin.
