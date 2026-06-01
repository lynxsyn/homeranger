---
spec_id: M4-inbound-ingestion
status: queued
bump: minor
risk_class: tier-3
---

# Spec: M4 — Inbound email ingestion (the live data path)

## Why now

This is the only thing that fills the table for real. It is lower risk than outbound outreach (no `ComplianceGuard` — that gate is send-side), so it lands before M6. Proving the inbound webhook → extract → dedup → upsert path gives a real end-to-end demo: an agent's email becomes a ranked listing.

## Goal

A Resend inbound-parse + delivery/bounce/complaint webhook ingestion pipeline that turns agent emails (free text + PDF/image attachments) into deduped `Listing` rows via Claude structured extraction.

## Non-goals

- Outbound sending / `ComplianceGuard` (M6).
- Photo taste-scoring, embedding, preference matching (M5) — this milestone upserts the listing and enqueues `analyze:listing`; the analysis itself is M5.

## Acceptance criteria

1. Raw Fastify routes are registered **before** the tRPC plugin (mirror `apps/control-plane-api/src/main.ts:109`): `POST /webhooks/resend/inbound` and `POST /webhooks/resend/events` (delivery/bounce/complaint).
2. Each route mirrors `email-ingestion.route.ts`: raw-buffer parser + signature prehandler (Node `crypto` HMAC against `RESEND_*_WEBHOOK_SECRET`, replay window) + Zod body validation + enqueue with idempotency key `resend:inbound:<MessageId>` / `resend:event:<id>` + immediate `202`. Invalid signature → `401`; replay/duplicate → `202` no-op.
3. Inbound payloads capture `spfVerdict`/`dkimVerdict` using the Doxus enum shape (`pass|fail|softfail|neutral|none|temperror|permerror|unknown`).
4. `outreach:inbound` worker (in `apps/processor`, consume-only): decodes attachments (`Buffer` → own R2 bucket via `@aws-sdk/client-s3`), calls a `ClaudeExtractionProvider`-style extractor (`output_config.format: json_schema`, token/cost metrics, retryable-error classification per the Doxus AI pattern) to extract listing fields + `listingUrl` from free text + PDF/image (Claude native document/image blocks; `unpdf` fallback for oversized PDFs).
5. `DedupService` normalises UK postcode + address → exact-match on `addressNormalized`, else embedding-fallback similarity → upsert `Listing` (`isPreMarket=true` when email-only, `primarySource=agent_email`), writing a `ListingSourceRecord` (`sourceType=agent_email`, `externalId=<MessageId>`).
6. Each inbound `Listing` upsert enqueues `analyze:listing` (handler is M5; until then it's a registered no-op consumer).
7. Delivery/bounce/complaint events persist `EmailEvent` rows (feed the M6 circuit breaker) and update `SuppressionEntry` on hard bounce / spam complaint.
8. Services follow the DI pattern (`email-ingestion.service.ts`): interface + `Default…Service` + `deps.x ?? defaultX` + singleton export, no direct Prisma.

## Allowed edit surface

- `packages/backend-core/src/routes/resend-inbound.route.ts`, `resend-events.route.ts`.
- `apps/api/src/main.ts` (raw-route registration ordering).
- `packages/backend-core/src/services/{inbound-ingestion,dedup}.service.ts` + `lib/ai/ClaudeExtractionProvider`-style module + `lib/storage/` (R2) + `__tests__`.
- `apps/processor/src/worker.ts` (`outreach:inbound` handler) + queue enum/config additions.
- `e2e/inbound-ingestion.spec.ts`.

## Test plan

| Layer | Coverage |
|---|---|
| Unit | Signature prehandler: valid HMAC → pass; tampered/expired → `401`; duplicate MessageId → idempotent `202` no-op. |
| Unit | Claude extractor (Anthropic mocked): free-text email → structured listing fields + `listingUrl`; missing fields handled. |
| Unit | `DedupService`: same address two emails → one Listing (second updates `lastSeenAt`); near-duplicate via embedding fallback merges. |
| Integration | `outreach:inbound` end to end against docker pgvector + a fake R2: attachment stored, Listing upserted, `ListingSourceRecord` written, `analyze:listing` enqueued. |
| Integration | bounce event → `EmailEvent` + `SuppressionEntry(hard_bounce)` written. |
| E2E | POST a simulated Resend inbound payload (free text + image attachment) to the webhook → a `Listing` with `isPreMarket=true` appears in `listingsRouter.list`. |

## Definition of Done

RED webhook + extract + dedup tests first → GREEN · coverage ≥ threshold · Channel-1 E2E green · review APPROVED · release tag (MINOR) · post-release verify green.
