# Runbook: outreach safety

homeranger sends **autonomous cold B2B email** to UK estate agents. That is legally and reputationally load-bearing, so every send passes a single chokepoint and several brakes. This runbook is the operator's reference for how the safety model works, how to stop it, and how to take it live.

> Code: `packages/backend-core/src/lib/compliance/compliance-guard.ts`, `lib/rate-limit/redis-token-bucket.ts`, `lib/inbound/email-authentication.ts`. Legal basis: [`docs/compliance/`](../compliance/).

## The single send chokepoint

Every outbound email is sent by exactly one method (`OutreachService.dispatch → EmailProvider.send`), reachable only via `sendOutreach` / `sendFollowup`, both of which call `ComplianceGuard.assertCanSend(agent, { reserve: true })` **first**. There is no path that sends without the guard. The guard throws a transport-free `ComplianceError` on the first failed gate; the worker drops the job (non-retryable) and nothing is sent.

## The 7 gates (evaluated in order, short-circuit on first failure)

| # | Gate | Blocks when | Notes |
|---|---|---|---|
| 1 | **PECR mailbox class** | `mailboxType !== 'corporate_subscriber'` | `individual` / `unknown` are do-not-send. Free-webmail is classified `individual`. |
| 2 | **Opt-out** | `agent.optedOut` | Set by unsubscribe link or an inbound STOP. |
| 3 | **Suppression** | email in `SuppressionEntry` | `unsubscribe` / `hard_bounce` / `spam_complaint` / `manual`. |
| 4 | **Per-domain cooldown** | another agent at the same domain was contacted within `DOMAIN_COOLDOWN_DAYS` (default 30) | peek-only (no token burned); excludes the agent itself. |
| 5 | **Circuit breaker** | bounce rate > `BREAKER_BOUNCE_RATE` (2%) or complaint rate > `BREAKER_COMPLAINT_RATE` (0.1%) over the rolling window | only evaluated above min samples (bounce ≥ 50, complaint ≥ 200) to avoid a hair-trigger at low volume; per-event `hard_bounce` still suppresses the specific address immediately. |
| 6 | **Kill-switch** | `WarmupState.killSwitch` is ON | read fresh from the DB every send (no caching) — flipping it takes effect on the next send. |
| 7 | **Warm-up daily cap** | the day's atomic token bucket is exhausted | consumed **last**, so a send blocked by gates 1–6 never burns a token. Cap ramps via `WARMUP_BASE_CAP` → `WARMUP_STEP` → `WARMUP_MAX_CAP`. |

Gates fail **closed**: if Redis or the DB errors, the read throws and the worker retries rather than sending.

## Inbound sender authentication

The Resend inbound webhook is signed by the *forwarder*, not the sender, so the `From` is spoofable. SPF/DKIM verdicts are DMARC-aligned in the hydrator and enforced for agent-keyed side effects: a tracked agent's "reply" on unauthenticated mail does **not** advance the thread (it's logged `outreach.reply.unauthenticated`). **Opt-out is deliberately not gated** — a genuine STOP must never be dropped, so it is honoured generously and an unauthenticated opt-out is only logged (`outreach.reply.optout_unauthenticated`) for visibility.

## The kill-switch

The operator brake. **Settings → Outreach** in the SPA (operator-only), backed by `WarmupState.killSwitch` via `outreachRouter.killSwitch.toggle`. When ON: the review UI marks every agent ineligible (Approve disabled) **and** the worker blocks (defense in depth). Use it the moment reputation looks wrong.

Flip it directly if the UI is unavailable:

```bash
kubectl -n homeranger exec deploy/homeranger-postgres -- \
  psql -U homeranger_admin -d homeranger -c \
  "UPDATE \"WarmupState\" SET \"killSwitch\" = true;"
```

## Warm-up & circuit breaker

- **Warm-up** ramps the daily cap so a new sending domain builds reputation gradually. `warmup:recalc` (scheduler) recomputes the cap; the meter is visible in Settings → Outreach.
- **Circuit breaker** trips on the rolling-window bounce/complaint rates above. If it trips, sends stop automatically. Investigate the `EmailEvent` feed, fix the cause (bad addresses, content), and let the window age out — do not raise the thresholds to get unblocked.

## Go-live checklist

The loop is built but real sending is **off** until the operator activates it:

1. **Verify the Resend sending domain** (DKIM CNAME, Return-Path CNAME, SPF, DMARC published via `infra/terraform/cloudflare/dns.tf`).
2. **Set `RESEND_FROM`** (and optionally `RESEND_REPLY_TO`) in the api/processor secret.
3. Confirm `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_INBOUND_WEBHOOK_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET` are present (the processor fails closed at boot without them).
4. Confirm DMARC is at `p=none` for warm-up; tighten to `p=quarantine` then `p=reject` after the alignment window, monitoring the `rua` mailbox.
5. Keep the kill-switch within reach for the first live runs.

## Compliance basis

- **Legitimate interest** for public business contacts — [`docs/compliance/legitimate-interest-basis.md`](../compliance/legitimate-interest-basis.md), [`agent-sourcing-basis.md`](../compliance/agent-sourcing-basis.md).
- **ROPA** (GDPR Art. 30) — [`docs/compliance/ropa.md`](../compliance/ropa.md).
- **One-click unsubscribe** (RFC 8058) + inbound STOP honoured via `SuppressionEntry` + `Agent.optedOut`.
- LLM calls run on no-training / zero-retention settings.

## Observability

Block reasons log `agentId` + the gate `code` (never PII). Watch for `outreach.reply.unauthenticated`, `outreach.reply.optout_unauthenticated`, `inbound.dropped.non_retryable`, and the `homeranger_inbound_dropped_total` metric.
