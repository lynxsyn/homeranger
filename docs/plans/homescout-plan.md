# homescout — UK Property Aggregator (two-channel ingestion + AI matching)

> Codename `homescout` (rename freely). Brainstorm → plan artifact. This is a **large greenfield feature**, so the actual build proceeds as a sequence of AIDE specs (one per milestone), each its own PR + release tag, per the workspace Change Delivery Protocol and `scope-discipline.md`.

## Context

You want one place to skim UK homes worth buying — ideally **before** they hit Rightmove/OnTheMarket/Zoopla — filtered by location, type, and the specific features you like, with photos scored against your taste. Two ingestion channels feed one Postgres table, browsed as a simple sortable/filterable table that **links out** to the source (we do not re-render listing pages).

Research established three facts that shape everything:

1. **Official portal APIs are closed to private buyers.** Rightmove RTDF, Zoopla's API, and Zillow Bridge are all gated behind member-agent/broker/MLS relationships. You chose **compliant-APIs-only** (no scraping), so the crawler cannot pull live listings from the portals directly.
2. **There is no cheap buyer-facing API that returns a live *for-sale listing feed*.** PropertyData (~£28/mo) and PaTMa are **analytics-first** (sold prices, valuations, EPC, area stats). Land Registry Price Paid + the EPC register are open gov data but **historical/reference**, never live. → **The agent-email channel becomes the primary source of live/pre-market listings; the API channel is enrichment.** This is the honest reframe the architecture is built on, and it happens to match your "before it's live" goal — pre-market homes genuinely flow through agent relationships, not portals.
3. **Your Doxus stack fits exactly**, and crucially the cluster Postgres is **already `pgvector/pgvector:pg17`** (`doxus-infra/deploy/base/postgres.yaml:51`) — the semantic-matching layer needs no new infra.

**Intended outcome:** a self-hosted, single-user app on your k3s cluster where (a) an autonomous, compliance-guarded email agent builds relationships with UK estate agents and ingests the listings they send, (b) compliant APIs enrich those listings with sold-price/EPC/area context, (c) Claude extracts structure from free-text emails and scores photos against your stated taste, and (d) a table UI lets you filter/sort and click through to the source.

## Goal / Non-goals

- **Goal:** deduped UK listings table (email-sourced + API-enriched), AI feature/taste scoring, autonomous-but-guarded agent outreach, table UI with source links. Deployed via FluxCD; full TDD/CI/release pipeline.
- **Non-goals:** scraping Rightmove/OnTheMarket/Zoopla (explicitly excluded); re-rendering listing detail pages; multi-tenant/multi-user; US market; a mobile app; rebuilding email/queue/search infra in-house where a residency-compliant vendor passes the commodity gate; **sharing any Doxus runtime — DB, Redis, namespace, secrets, domain, tunnel, images, or CI.**

## Recommended architecture

```
                 ┌─────────────────────── apps/api (Fastify + tRPC 11) ────────────────────────┐
                 │  tRPC routers: listings · preferences · outreach   +  raw webhook routes      │
 React SPA  ───▶ │  (Postmark inbound-parse + delivery-events → enqueue BullMQ)                   │
 (apps/web)      └───────────────┬───────────────────────────────────────────────┬──────────────┘
   table UI                      │ enqueue                                         │ enqueue
   filters/sort                  ▼                                                 ▼
   click-out links     ┌── apps/processor (BullMQ workers) ──┐         ┌── apps/scheduler (cron, leader-lock) ──┐
                        │ ingest:poll  → API adapters         │         │ registers ingest:poll / outreach:*     │
                        │ analyze:listing → Claude extract,   │         │ / warmup:recalc on cron               │
                        │   vision photo-score, embed         │         └───────────────────────────────────────┘
                        │ outreach:send → ComplianceGuard→send│
                        │ outreach:inbound → classify+extract │
                        │ outreach:followup                   │
                        └──────────────┬──────────────────────┘
                                       ▼
                 Postgres (pgvector/pgvector:pg17, already on cluster) + Redis (BullMQ + warmup token-bucket)
```

**Channel 1 — Agent email (primary live source).** Autonomous outreach to UK estate agents asking to be notified of upcoming/off-market listings; ingest replies (free text + PDF/image attachments) → Claude structured extraction → dedup → upsert as `isPreMarket` listings. **"Autonomous" is gated, not unguarded** — every send passes a central `ComplianceGuard` (see below).

**Channel 2 — Compliant API ingestion (enrichment).** Pluggable `ListingSourceAdapter` implementations for PropertyData, PaTMa, Land Registry, EPC. They decorate listings with sold-price comps, EPC, and area analytics. If the M0 spike finds a tier that *does* return live for-sale rows under a personal-use licence, the same adapter interface ingests them as listings — no rework.

**AI layer.** Claude structured outputs extract fields from agent emails; Claude **Haiku** vision scores each photo (0–100) against your taste + detects features; an embedding model vectorises listing + your free-text preferences for pgvector top-K, then a hybrid LLM re-score of just the top-K ranks results (bounds cost).

## Repo & stack

**Fully standalone application — zero shared Doxus runtime.** homescout runs on the same k3s *hardware* but shares nothing with Doxus: its own repo, namespace, Postgres, Redis, secrets (own age key), GHCR images, CI/release pipeline, Cloudflare tunnel hostname, and a dedicated email domain. Every Doxus file referenced in this plan is **copied as a pattern, never imported or shared** — no cross-repo deps, no shared packages, no shared DB/secrets. It adopts the workspace-root AIDE protocol but with its **own overlay** (its own `docs/specs/BUILD_ORDER.md`, `docs/decisions/`, and release-tag/post-release-verify scripts) — independent of `doxus-ops`.

**Single repo** `homescout` (not the 3-repo Doxus split — that split exists for independent release cadences and shared runtime-bundle sync you don't need). Mirror `doxus-web/pnpm-workspace.yaml` (`apps/*` + `packages/*`) and `tsconfig.base.json`.

```
homescout/
  apps/api/         Fastify 5 + tRPC 11; canonical prisma/ schema + migrations live here (mirror apps/control-plane-api)
  apps/processor/   BullMQ workers (mirror apps/processor/src/worker.ts — consumes only)
  apps/scheduler/   cron via PG leader-lock (mirror apps/scheduler/src/scheduler.ts — registers recurring jobs only)
  apps/web/         React 19 + Vite + Tailwind 4 SPA (mirror apps/web)
  packages/backend-core/  routers · services · repositories · lib/listing-source adapters (mirror packages/backend-core)
  packages/shared/        zod schemas + UK constants shared FE/BE
  infra/deploy/…          k8s manifests for Flux (mirror doxus-infra/deploy/base + overlays/pve1)
  infra/terraform/cloudflare/  DNS for the sending subdomain (mirror doxus-infra/terraform/cloudflare/dns.tf)
  docs/specs/             per-milestone specs + BUILD_ORDER.md
```

Stack matches Doxus verbatim: pnpm, TS strict (no `any`), Fastify+tRPC, Prisma 7 + Postgres, BullMQ+Redis, React+Vite+Tailwind, Vitest + Playwright, `@anthropic-ai/sdk`, SuperTokens (single user → one `protectedProcedure`, drop tenant scoping per YAGNI). All backend code obeys `backend.md`: routers→services→repositories, repositories own ALL Prisma, cursor pagination `{items,nextCursor}` (default 20/max 100), prices as **integer pence**, `TRPCError` codes only.

## Libraries & dependencies (homescout's own `package.json` — nothing shared with Doxus)

**Email.** The *provider* is an M0 decision (the commodity gate's UK/EEA residency criterion drives it), wrapped behind a thin `EmailProvider` + `MailboxAdapter` interface so it stays swappable. A **managed ESP is the recommended primary — not pure `nodemailer`**: the autonomous circuit-breaker needs reliable bounce/complaint **webhooks**, and we must parse inbound replies + attachments — both of which an ESP provides and a send-only library does not.
- **Send + bounce/complaint events:** an ESP SDK behind `EmailProvider`. Residency picks which: an **EEA-resident ESP** (MailerSend / Mailjet / Brevo / Scaleway TEM / SES `eu-west-1` / SendGrid EU region) to satisfy the gate; **Resend** only if you waive residency for a personal tool (verified June 2026: Resend's AUP permits compliant cold B2B and it has inbound, but its account data/metadata/logs sit in the US even when sending from Ireland → fails criterion #1). Keep `nodemailer` as the swappable SMTP transport (every candidate speaks SMTP) and the zero-ESP fallback if manual bounce handling is acceptable.
- **Receive + parse:** the ESP's inbound-parse webhook (`zod` + Node `crypto` HMAC, no MIME lib). Fallback if no ESP: `imapflow` + `mailparser` behind the `MailboxAdapter` (Doxus's IMAP pattern).
- **Draft / classify replies / extract fields:** `@anthropic-ai/sdk` only — **no LangGraph or agent framework** (the loop is BullMQ jobs + an `OutreachThread` status state machine, per `scope-discipline.md`).
- **Attachments:** `Buffer` decode → own R2 bucket via `@aws-sdk/client-s3` → PDFs/images to Claude via `@anthropic-ai/sdk` native document/image blocks (`unpdf` fallback for oversized PDFs).
- **Warmup/rate-limit:** `bullmq` + `ioredis` (token bucket copied from `redis-token-bucket.ts`).

**Everything else (copied from Doxus's proven choices):** API `fastify` + `@trpc/server` + `zod` + `supertokens-node`; DB `prisma` + `@prisma/client` + `@prisma/adapter-pg` + `pg` (pgvector via raw SQL); jobs `bullmq` + `ioredis`; AI `@anthropic-ai/sdk`; **embeddings = M0 pick** (self-hosted `fastembed`/ONNX for £0 + UK-residency vs `openai` SDK for speed — sets `vector(N)`); data-adapter HTTP via native `fetch` behind a copied SSRF guard; web `react` + `react-router-dom` v7 + `@tanstack/react-query` + `@trpc/react-query` + `tailwindcss` (hand-rolled table, no `@tanstack/react-table`); tests `vitest` + `@playwright/test` + `nock`/`msw` + a docker test Postgres (real pgvector); tooling `pnpm`, `sops`+`age`, Terraform (+ Cloudflare provider), FluxCD, Docker.

## Data model (Prisma — key entities; mirror `apps/control-plane-api/prisma/schema.prisma` conventions: `uuid(7)`/`@db.Uuid` PKs, `@db.Timestamptz(6)`, enums)

- **Listing** — canonical deduped record. `addressNormalized` (unique dedup key), `postcode`/`outcode`, `pricePence Int?`, `tenure`/`propertyType`/`epcRating` enums, `bedrooms`/`bathrooms`, `listingStatus` (`pre_market`/`live`/`under_offer`/`sold`/`withdrawn`), `isPreMarket Bool`, **`listingUrl String?`** (the click-out link; null for email-only pre-market), `primarySource`, `embedding Unsupported("vector(N)")?`, `firstSeenAt`/`lastSeenAt`. Relations → `sourceRecords[]`, `photoAnalyses[]`, `scores[]`.
- **ListingSourceRecord** — raw provenance per source, `@@unique([sourceType, externalId])` for idempotent re-ingest; carries `licenceClass` (`personal_use_ok`/`enrichment_only`/`open_gov`) from the M0 spike.
- **PhotoAnalysis** — per-photo `tasteScore`, `featuresJson`, `model`, `costPence`, dedup by `imageHash`.
- **ListingScore** — `vectorScore`, `llmScore?`, `combinedScore`, `rationale` (hybrid match result).
- **SearchProfile** — single row: `freeTextPreferences`, structured filters (`minBedrooms`, `maxPricePence`, `outcodes[]`, `requiredTenure`), `preferenceEmbedding`.
- **Agent** — `email` (unique), `agencyName`, **`mailboxType`** (`corporate_subscriber`/`individual`/`unknown` — the PECR gate: only `corporate_subscriber` is cold-emailable; `unknown` ⇒ do-not-send), `optedOut`, `coveredOutcodes[]`, `lastContactedAt`.
- **OutreachThread / OutreachMessage** — conversation + per-email rows; inbound carries `parsedListingIds[]` + `spfVerdict`/`dkimVerdict` (reuse the enum shape at `email-ingestion.route.ts:41-61`); `@@unique([postmarkMessageId])` for webhook idempotency.
- **SuppressionEntry** (`unsubscribe`/`hard_bounce`/`spam_complaint`/`manual`), **EmailEvent** (delivery/bounce/complaint feed for the circuit breaker), **WarmupState** (daily cap ramp).

**pgvector via Prisma** (Prisma 7 has no native `vector` type — follow the existing `CREATE EXTENSION pg_trgm` precedent at `apps/control-plane-api/prisma/migrations/20260413200000_s10_supplier_matching/migration.sql`): declare the column `Unsupported("vector(N)")?`, and in a **raw `migration.sql`** run `CREATE EXTENSION IF NOT EXISTS vector;` + `ALTER TABLE "Listing" ADD COLUMN … vector(N)` + an HNSW index (`USING hnsw (embedding vector_cosine_ops)`). Read/write vectors with `$queryRaw`/`$executeRaw` inside the repository (the driver is already `@prisma/adapter-pg`). `N` depends on the embedding model chosen in M0.

## Services / adapters / workers / routers / frontend

Follow the verified service pattern in `packages/backend-core/src/services/email-ingestion.service.ts` (class + interface, constructor DI with default singletons for testability, singleton export, no direct Prisma) and the Anthropic pattern in `…/workers/extraction/domain/ai/ClaudeExtractionProvider.ts` (`output_config.format: json_schema`, token/cost metrics, retryable-error classification).

- **`ListingSourceAdapter`** (`backend-core/src/lib/listing-source/types.ts`) + adapters `PropertyData`/`PaTMa`/`LandRegistry`/`EpcRegister`; route outbound HTTP through the existing `lib/ssrf/` guard.
- **IngestionService** (adapter→DedupService→repo upsert→enqueue `analyze:listing`), **DedupService** (UK-postcode + address normalisation → exact match → embedding fallback), **ListingAnalysisService** (extract / photo-score / embed), **PreferenceMatchService** (embed profile → `repository.vectorTopK` → LLM re-score top-K only → write `ListingScore`).
- **OutreachService** (draft→`ComplianceGuard.assertCanSend`→send→persist; inbound: classify→extract→dedup→upsert).
- **`ComplianceGuard`** — the load-bearing safety object. `assertCanSend(agent)` checks in order: (1) `mailboxType === corporate_subscriber` (PECR), (2) `!optedOut`, (3) not in `SuppressionEntry`, (4) circuit breaker (bounce >2% or complaint >0.1% over the `EmailEvent` rolling window), (5) manual kill-switch flag, (6) warmup daily cap via **`lib/rate-limit/redis-token-bucket.ts:consumeToken`** (reuse verbatim). Throws typed `TRPCError`.
- **Workers/queues** — add to the `QueueName`/`JobType` Prisma enums + `lib/queue/queue-config.ts`: `ingest:poll`, `analyze:listing`, `outreach:send`, `outreach:inbound`, `outreach:followup`, `warmup:recalc`. **scheduler** registers recurring jobs (leader-lock); **processor** consumes. Postmark webhooks land as **raw Fastify routes registered before the tRPC plugin** (ordering is mandatory — see `apps/.../main.ts` "register raw routes BEFORE tRPC"), each mirroring `email-ingestion.route.ts` (raw-buffer parser + signature prehandler + Zod + enqueue with idempotency key `postmark:inbound:<MessageID>` + `202`).
- **Routers** — `listingsRouter` (list/filter/sort/paginate, getById, expand), `preferencesRouter` (get/update the one profile), `outreachRouter` (metrics, threads, `killSwitch.toggle`).
- **Frontend** — mirror `apps/web`: `@trpc/react-query`, react-router v7, Tailwind 4. **Hand-roll the table** (the web app has `@tanstack/react-query` but NOT `@tanstack/react-table`; tables are semantic `<table>` with `inferRouterOutputs` row types and a11y attrs — see `OverviewFailuresTable.tsx`). Click-out is an `<a href={row.listingUrl}>` cell. Pages: `ListingsPage` (table + filters + row-expand for photo features/score), `PreferencesPage`, `OutreachDashboard` (metrics + kill switch).

## Infra — fully standalone tenant on your k3s (own everything; Doxus manifests copied as patterns, never shared)

Runs on the existing k3s **hardware** only; shares **no Doxus runtime**. Doxus's `deploy/` and Terraform are read as shape references and copied — homescout owns its own equivalents.

- **Flux source** — register a dedicated `GitRepository` + `Kustomization` pointing at homescout's own `infra/deploy/` (one-time cluster bootstrap). Doxus's Flux config is untouched.
- **Namespace** — dedicated `homescout` namespace; NetworkPolicy default-deny ingress/egress, then allow only intra-namespace + the Cloudflare tunnel + required egress (LLM / email / data APIs). It cannot reach the Doxus `web` namespace.
- **Postgres** — its **own** `homescout-postgres` Deployment (use the `pgvector/pgvector:pg17` image as the reference — NOT the `doxus-postgres` instance), own Longhorn PVC, own `homescout`/`homescout_migrator` roles; `CREATE EXTENSION vector` in the first migration.
- **Redis** — its own `homescout-redis` (BullMQ + warmup token bucket).
- **Deployments** — api/processor/scheduler with init-container `prisma migrate deploy`, non-root, probes, resource limits, Flux `$imagepolicy` annotations (shape copied from `api-deployment.yaml`). SPA via its own Cloudflare Pages project.
- **Images** — own GHCR namespace (`ghcr.io/<you>/homescout-*`), own release workflow + semver tags; independent of Doxus's release pipeline.
- **Secrets (SOPS+age)** — its **own age key/recipient** (Doxus's key must not decrypt homescout secrets and vice-versa): `ANTHROPIC_API_KEY`, email-provider token + webhook secret, `PROPERTYDATA_API_KEY`/`PATMA_API_KEY`, `DATABASE_URL`/`MIGRATION_DATABASE_URL`, `REDIS_PASSWORD`. Encrypt per the `sops.md` pattern before commit.
- **Email + DNS** — its **own dedicated domain/zone** (not a Doxus subdomain — keeps cold-email sending reputation and legal exposure fully off anything you care about), with its own Cloudflare-managed DKIM CNAME, Return-Path CNAME, SPF TXT, DMARC TXT (`p=none` for warmup → tighten to `quarantine`), in homescout's own Terraform. Its own tunnel/ingress hostname.
- **CI** — own workflows; runner labels via `${{ vars.RUNNER_LABEL_* }}` (E2E/image-build = ARC, fast feedback = hosted).

## M0 — Decision gates (BEFORE any code; produce written artifacts)

These three resolve the project's real unknowns and are required by `validation-gate.md` + `commodity-gate.md`:

1. **Data-source viability spike.** For a real UK postcode, call PropertyData and PaTMa tiers and record exactly which endpoints return *live for-sale listing rows with address + URL* vs only analytics, plus each provider's redistribution/personal-use licence. Output `licenceClass` per source. **Define the fallback up front** (likely outcome): no compliant live-listing feed exists ⇒ APIs are enrichment-only, agent email is the sole live source. The adapter interface makes this a config decision.
2. **Email-provider commodity-gate decision** → `docs/decisions/<date>-email-provider-vendor.md`. The gate's **criterion #1 is UK/EEA data residency** (storage AND processing). Verified June 2026: **Resend and Postmark fail** — both store account data/metadata/logs in the US (SCC-based) even when sending from an EU region. Evaluate EEA-resident ESPs (MailerSend, Mailjet/Sinch, Brevo, Scaleway TEM, SES `eu-west-1` Ireland for send+receive, or SendGrid's EU data-residency region) for send + inbound-parse + bounce/complaint webhooks + deliverability, against the four pass-criteria. This choice drives the webhook route shape and DNS records. (Resend has the best DX and an AUP that allows compliant cold B2B — viable only if you waive residency for this personal tool.)
3. **Embedding-model decision** (sets `vector(N)` dimension). Two realistic options: self-hosted small model (e.g. `bge-small`, ~384-dim — £0, UK-resident, one extra container) **vs** the `openai` SDK already in `backend-core` (`text-embedding-3-small`, 1536-dim — fast to build, US-resident). Default to residency-friendly self-host unless speed-to-MVP wins.

> GDPR note: agent emails contain third-party personal data. Document a legitimate-interest basis + a ROPA entry (reuse the Doxus template), honour one-click unsubscribe via `SuppressionEntry`, and keep LLM calls on a no-training/zero-retention setting.

## Build sequence (INFRASTRUCTURE-FIRST → TESTS-FIRST per the HARD-GATE; each milestone = one spec/PR/release tag)

| # | Milestone | TDD shape |
|---|---|---|
| **M0** | Decision gates above | artifacts only, no code |
| **M1** | Repo + standalone infra scaffold: own Flux source, `homescout` namespace + default-deny NetworkPolicy, dedicated `homescout-postgres` (+`vector`), `homescout-redis`, own age-encrypted secrets, own domain DNS | infra (no TDD per `infra.md`); **gate: dedicated DB+Redis reachable + `vector` created before any integration/E2E test** |
| **M2** | Data model + repositories (incl. raw `vectorTopK`) | RED repo unit+integration (assert cosine ordering on real pgvector) → GREEN schema/migrations/repos |
| **M3** | Listings table read path — **first demo** | RED `listingsRouter.list` + table component → GREEN router + `ListingsPage` → E2E loads table, clicks a source link |
| **M4** | Compliant API ingestion | RED adapter (nock) + Ingestion/Dedup → GREEN adapters + `ingest:poll` → E2E scheduler→processor→row with `licenceClass` |
| **M5** | AI analysis | RED analysis+match (mock Anthropic) → GREEN extract+vision+embed+`analyze:listing` → E2E row-expand shows features/score |
| **M6** | Outreach + ComplianceGuard (highest risk, last) | RED a test per guard gate (PECR/suppression/circuit-breaker/warmup/kill-switch) + webhook route → GREEN service+routes+jobs → E2E: simulated inbound webhook upserts listing; guard blocks non-corporate/suppressed/over-cap send |
| **M7** | Outreach dashboard | RED `outreachRouter.metrics` + kill-switch → GREEN dashboard → E2E toggle halts sends |

## Pattern map (Doxus files to read + **copy** — reference only, never imported or shared)

- `packages/backend-core/src/services/email-ingestion.service.ts` — service DI + inbound-email orchestration.
- `packages/backend-core/src/routes/email-ingestion.route.ts` — raw-buffer + signature prehandler + Zod + `202` webhook template (+ SPF/DKIM enum shape).
- `…/workers/extraction/domain/ai/ClaudeExtractionProvider.ts` — Anthropic structured-output + metrics + retry pattern.
- `apps/control-plane-api/prisma/migrations/20260413200000_s10_supplier_matching/migration.sql` — `CREATE EXTENSION` + index raw-migration precedent for pgvector.
- `packages/backend-core/src/lib/rate-limit/redis-token-bucket.ts` — `consumeToken` for warmup caps.
- `apps/scheduler/src/scheduler.ts` + `apps/processor/src/worker.ts` — leader-lock cron vs consume-only worker split.
- `doxus-infra/deploy/base/{postgres.yaml,api-deployment.yaml}` + `terraform/cloudflare/dns.tf` — Postgres reuse, Deployment shape, sending-domain DNS.
- `apps/web/.../OverviewFailuresTable.tsx` — hand-rolled accessible table + click-out cell.

## Verification (end-to-end)

- **Local:** `pnpm --filter @homescout/api prisma:generate && pnpm typecheck && pnpm --filter @homescout/api test && pnpm test:integration && pnpm test:e2e:local` from the worktree root, with coverage thresholds enforced (mirror the Doxus verify command + the coverage HARD-GATE).
- **Channel-1 proof (E2E):** POST a simulated Postmark inbound-parse payload (free-text + attachment) to the webhook → assert a `Listing` is upserted with `isPreMarket=true` and appears in `listingsRouter.list`. Assert `ComplianceGuard` blocks a send to a `mailboxType=unknown`/suppressed/over-cap agent.
- **Channel-2 proof (E2E):** mock a PropertyData response via the adapter → `ingest:poll` → row appears with correct `licenceClass`, enriched onto the matching address (dedup).
- **AI proof (E2E):** ingest → `analyze:listing` → `PhotoAnalysis` + `ListingScore` populated; table row-expand renders features + score rationale.
- **UI proof (E2E + manual):** Playwright loads `ListingsPage`, filters by outcode/price/beds, sorts by match score, clicks `listingUrl` (opens source). Drive the SPA with Playwright against local dev per `browser-debugging.md`.
- **Ship:** release tag (MINOR per milestone) → FluxCD reconcile → post-release verify (`/api/health` + image-tag match) per Steps 16–17.

## Risks & open decisions

1. **Data-source viability (gates the product shape).** Most likely result: no compliant live-listing API ⇒ "API channel = enrichment only, email = live source." Acceptable and still coherent, but confirm in M0 so the table isn't expected to fill from APIs.
2. **Autonomous cold B2B email reputation.** Even PECR-compliant corporate-only sending from a new domain risks blacklisting. Mitigated by warmup ramp + circuit breaker + DMARC `p=none`→`quarantine`; reputation is still probabilistic. The kill switch is the backstop.
3. **PECR/GDPR exposure.** `mailboxType` classification is error-prone; `unknown` must be do-not-send. Need a documented legitimate-interest basis + ROPA + honoured unsubscribe.
4. **Email-vendor residency (commodity gate).** Verified June 2026: Resend and Postmark store account data/metadata/logs in the US (SCC-based) → both **fail** criterion #1 (UK/EEA), even though Resend's AUP permits compliant cold B2B and has inbound. Default to an EEA-resident ESP behind the `EmailProvider` interface (`nodemailer` SMTP as the swappable transport) unless you explicitly waive residency for this personal tool — in which case Resend is the cleanest DX.
5. **Claude vision cost.** Cap analysis to top-K matched listings, dedup by `imageHash`, record `costPence`; consider a monthly spend kill-switch.
6. **Embedding provider/dimension** — open until M0 (self-hosted bge vs OpenAI); sets the migration's `vector(N)`.
