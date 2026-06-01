---
spec_id: M5-ai-analysis
status: queued
bump: minor
risk_class: tier-3
---

# Spec: M5 — AI analysis (taste-score + features + embed + match)

## Why now

The differentiator: rank listings against *your* stated taste, not just filter them. Built after M4 so it runs on real ingested listings, and cost-bounded by design (analyse/score only what's needed, dedup photos, record spend) before the autonomous outreach milestone multiplies volume.

## Goal

An `analyze:listing` pipeline that, per listing: scores each photo against the user's taste, detects features, embeds the listing, and computes a hybrid (vector + LLM) match score against the single `SearchProfile`.

## Non-goals

- Outbound outreach (M6), dashboard (M7).
- Re-embedding/re-ranking infra beyond a `warmup:recalc`-adjacent recompute trigger (kept minimal).

## Acceptance criteria

1. `ListingAnalysisService` (DI pattern, no direct Prisma): for each listing photo, Claude **Haiku** vision returns `tasteScore` (0–100) + `featuresJson`; dedup by `imageHash` (skip already-analysed images); persist `PhotoAnalysis` with `model` + `costPence`.
2. The listing text is embedded via an `EmbeddingProvider` interface → **Voyage `voyage-3.5`** (`vector(1024)`); the vector is written to `Listing.embedding` via the repository's raw write.
3. `PreferenceMatchService`: embed the `SearchProfile.freeTextPreferences` (+ structured filters) → `listingRepository.vectorTopK` for candidate recall → Claude **re-scores only the top-K** → write `ListingScore` (`vectorScore`, `llmScore`, `combinedScore`, `rationale`).
4. `analyze:listing` worker orchestrates extract→score→embed→match; enqueued by M4 inbound upsert and by a backfill trigger.
5. Cost controls: top-K bound on LLM re-score, `imageHash` dedup, `costPence` recorded per call; a monthly-spend kill-switch flag short-circuits analysis when tripped (logged, not silent).
6. Anthropic + Voyage calls go through provider interfaces with token/cost metrics + retryable-error classification (mirror `ClaudeExtractionProvider`); both are mocked in unit tests.
7. `ListingsPage` row-expand (M3 placeholder) now renders real `featuresJson` + `combinedScore` + `rationale`; default sort by `combinedScore` works.

## Allowed edit surface

- `packages/backend-core/src/services/{listing-analysis,preference-match}.service.ts` + `lib/ai/{vision,embedding-provider}` + `__tests__`.
- `apps/processor/src/worker.ts` (`analyze:listing` handler).
- `packages/backend-core/src/routers/listings.router.ts` (expand payload now populated), `preferences.router.ts` (get/update the one profile).
- `apps/web/src/pages/ListingsPage.tsx` (row-expand render), `PreferencesPage.tsx`.
- `e2e/ai-analysis.spec.ts`.

## Test plan

| Layer | Coverage |
|---|---|
| Unit | Vision scorer (Anthropic mocked): photo → `tasteScore` 0–100 + features; `imageHash` dedup skips re-analysis; `costPence` recorded. |
| Unit | `EmbeddingProvider` (Voyage mocked) returns 1024-dim vector; wrong-dim response rejected. |
| Unit | `PreferenceMatchService`: `vectorTopK` candidates → LLM re-score only top-K (assert N calls = K, not full corpus) → `combinedScore` blends vector+LLM. |
| Integration | `analyze:listing` on a seeded listing populates `PhotoAnalysis` + `Listing.embedding` + `ListingScore`. |
| Integration | Monthly-spend kill-switch tripped → analysis short-circuits and logs the skip. |
| E2E | Ingest → analyze → `ListingsPage` row-expand renders features + score rationale; table sorts by match score. |

## Definition of Done

RED analysis + match tests first → GREEN · coverage ≥ threshold · AI-proof E2E green · review APPROVED · release tag (MINOR) · post-release verify green.
