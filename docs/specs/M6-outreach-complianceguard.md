---
spec_id: M6-outreach-complianceguard
status: queued
bump: minor
risk_class: tier-4
---

# Spec: M6 — Outbound outreach + ComplianceGuard (highest risk, last)

## Why now

Autonomous cold B2B email is the project's highest-risk surface (PECR/GDPR exposure + sender-reputation risk). It is built last, after the read/ingest/AI paths are proven, so the guard is the only new risk in play. "Autonomous" here means **gated, not unguarded** — every send passes a central `ComplianceGuard`.

## Goal

`OutreachService` that drafts and sends outreach to UK estate agents only when `ComplianceGuard.assertCanSend` passes all gates, persists the thread, and follows up on a cadence — with a documented GDPR basis and honoured unsubscribe.

## Non-goals

- The dashboard UI (M7) — this milestone exposes the data/toggles; M7 renders them.
- Multi-user / multi-mailbox sending.

## Acceptance criteria

1. `ComplianceGuard.assertCanSend(agent)` checks **in order**, throwing a typed `TRPCError` on the first failure: (1) `mailboxType === corporate_subscriber` (PECR corporate-subscriber carve-out; `individual`/`unknown` ⇒ do-not-send), (2) `!optedOut`, (3) not in `SuppressionEntry`, (4) circuit breaker — bounce rate > 2% OR complaint rate > 0.1% over the rolling `EmailEvent` window, (5) manual kill-switch flag, (6) warmup daily cap via `lib/rate-limit/redis-token-bucket.ts:consumeToken({key,cap,windowSeconds})` (reused verbatim, fail-closed).
2. `OutreachService` draft→`assertCanSend`→send (via the `EmailProvider`/Resend adapter)→persist `OutreachThread`/`OutreachMessage`. Sends are never issued except through this path.
3. `outreach:send` and `outreach:followup` jobs (processor, consume-only); `warmup:recalc` registered by the scheduler (leader-lock) to ramp the daily cap and recompute breaker rates. No `ingest:poll` (API channel dropped).
4. Inbound replies (M4 path) that are classified as listing-bearing link back to the `OutreachThread` (`parsedListingIds[]`); the `OutreachThread` status state machine advances (no LangGraph/agent framework — BullMQ jobs + status enum per `scope-discipline.md`).
5. GDPR artifacts committed: a documented legitimate-interest basis + a ROPA entry (reuse the Doxus template); one-click unsubscribe honoured by writing a `SuppressionEntry(unsubscribe)` and short-circuiting all future sends; LLM calls pinned to a no-training/zero-retention setting.
6. A manual `killSwitch` flag (persisted) halts all sends immediately when set (surfaced in M7).

## Allowed edit surface

- `packages/backend-core/src/services/outreach.service.ts`, `lib/compliance/compliance-guard.ts` + `__tests__`.
- `packages/backend-core/src/lib/email/{email-provider,mailbox-adapter}.ts` (Resend adapter + nodemailer fallback).
- `apps/processor/src/worker.ts` (`outreach:send`/`outreach:followup`), `apps/scheduler/src/scheduler.ts` (`warmup:recalc`).
- `docs/compliance/{legitimate-interest-basis,ropa}.md`.
- `e2e/outreach-guard.spec.ts`.

## Test plan

| Layer | Coverage |
|---|---|
| Unit (one per gate) | Send blocked for `mailboxType=individual` and `=unknown` (PECR). |
| Unit | Send blocked when `optedOut` / present in `SuppressionEntry`. |
| Unit | Circuit breaker trips at bounce > 2% and at complaint > 0.1% over the window; recovers below. |
| Unit | Manual kill-switch set → all sends blocked. |
| Unit | Warmup cap: `consumeToken` exhausted → send deferred with `retryAfterSeconds`. |
| Unit | Gate ordering: a non-corporate, suppressed, over-cap agent fails on the FIRST gate (PECR), not a later one. |
| Integration | Unsubscribe inbound → `SuppressionEntry(unsubscribe)` written → subsequent `assertCanSend` throws. |
| E2E | Guard blocks a non-corporate / suppressed / over-cap send end-to-end; an allowed corporate send persists an `OutreachMessage`. |

## Definition of Done

RED one-test-per-gate first → GREEN service + jobs · coverage ≥ threshold · guard E2E green · GDPR docs committed · review APPROVED · release tag (MINOR) · post-release verify green.
