---
spec_id: M2-data-model
status: queued
bump: minor
risk_class: tier-3
---

# Spec: M2 — Data model + repositories (incl. raw `vectorTopK`)

## Why now

Every later milestone reads/writes the same Postgres tables. The schema, the pgvector migration, and the repository layer are the foundation; getting cosine ordering and the layering contract right here avoids rework in M3–M7.

## Goal

A complete Prisma schema + raw pgvector migration + repository layer that obeys `aide/rules/backend.md` (routers→services→repositories, repositories own ALL Prisma, cursor pagination `{items,nextCursor}` default 20/max 100, prices as **integer pence**, `TRPCError` codes only), including a raw `vectorTopK` that returns listings by cosine similarity.

## Non-goals

- Routers, services beyond repositories, workers, UI (M3+).
- The `ListingSourceAdapter` framework and `licenceClass` (removed per the data-source decision).

## Acceptance criteria

1. Prisma schema (`apps/api/prisma/schema.prisma`) mirrors Doxus conventions: `id String @id @default(uuid(7)) @db.Uuid`, `@db.Timestamptz(6)` timestamps, top-level PascalCase enums with snake_case values.
2. Entities: **Listing** (`addressNormalized` unique dedup key, `postcode`/`outcode`, `pricePence Int?`, `tenure`/`propertyType`/`epcRating`/`listingStatus` enums, `isPreMarket Bool`, `listingUrl String?`, `primarySource`, `embedding Unsupported("vector(1024)")?`, `firstSeenAt`/`lastSeenAt`); **ListingSourceRecord** (`@@unique([sourceType, externalId])`, `sourceType ∈ agent_email|manual`, **no `licenceClass`**); **PhotoAnalysis** (`tasteScore`, `featuresJson`, `model`, `costPence`, dedup by `imageHash`); **ListingScore** (`vectorScore`, `llmScore?`, `combinedScore`, `rationale`); **SearchProfile** (single row: `freeTextPreferences`, `minBedrooms`, `maxPricePence`, `outcodes[]`, `requiredTenure`, `preferenceEmbedding`); **Agent** (`email` unique, `agencyName`, `mailboxType ∈ corporate_subscriber|individual|unknown`, `optedOut`, `coveredOutcodes[]`, `lastContactedAt`); **OutreachThread**/**OutreachMessage** (`spfVerdict`/`dkimVerdict` reusing the Doxus enum shape, inbound `parsedListingIds[]`, `@@unique([providerMessageId])`); **SuppressionEntry** (`unsubscribe|hard_bounce|spam_complaint|manual`); **EmailEvent** (delivery/bounce/complaint feed); **WarmupState** (daily cap ramp).
3. A **raw** `migration.sql` runs `CREATE EXTENSION IF NOT EXISTS vector;` + `ALTER TABLE "Listing" ADD COLUMN "embedding" vector(1024);` + `CREATE INDEX ... ON "Listing" USING hnsw ("embedding" vector_cosine_ops);` — following the `CREATE EXTENSION` raw-migration precedent at `doxus .../migrations/20260413200000_s10_supplier_matching/migration.sql`.
4. Repositories own all Prisma; services never call `prisma.*` directly. Each repo method accepts an optional `tx`.
5. `listingRepository.vectorTopK(embedding: number[], k: number)` runs `$queryRaw` ordering by `embedding <=> $1` (cosine), returns top-K with the distance, and respects an optional structured pre-filter (outcodes/price/beds).
6. List methods return `{items, nextCursor}` (default 20, max 100) with stable cursor ordering.

## Allowed edit surface

- `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/**`.
- `packages/backend-core/src/repositories/**` (+ `__tests__`).
- `packages/shared/src/**` (zod schemas + UK constants shared FE/BE).

## Test plan

| Layer | Coverage |
|---|---|
| Integration (docker pgvector) | `vectorTopK` returns rows in correct cosine order for hand-constructed vectors; nearest-first. |
| Integration | `vectorTopK` honours a structured pre-filter (outcode/price/beds) before ranking. |
| Integration | `@@unique([sourceType, externalId])` makes re-ingest idempotent (second upsert updates, not duplicates). |
| Unit | Cursor pagination returns `{items,nextCursor}`, default 20 / max 100 enforced; prices stored/returned as integer pence. |
| Migration | Fresh DB: `CREATE EXTENSION vector` + `vector(1024)` column + HNSW index apply cleanly; `\d "Listing"` shows the index. |

E2E not required — no user-facing surface yet.

## Definition of Done

RED repo tests committed first (fail) → GREEN schema/migration/repos · coverage ≥ threshold · review APPROVED · release tag (MINOR) · post-release verify green.
