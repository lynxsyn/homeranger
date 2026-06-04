# Architecture

homeranger turns one product idea — *see UK homes worth buying before they hit the portals* — into a discover → outreach → ingest → analyze → list loop. This is the distilled, current-state reference; the original reasoning (and superseded options) lives in [`docs/plans/homeranger-plan.md`](docs/plans/homeranger-plan.md).

## The loop

```
 discover ──► outreach ──► (agent replies) ──► ingest ──► analyze ──► list
   │            │                                 │          │          │
 Firecrawl   ComplianceGuard                   Claude     Claude+Voyage  React
 find agents  -gated send                     extract    score+embed    table
```

1. **Discover** — given a Search's outcodes, find UK estate agents (`lib/discovery`, Firecrawl). Live in prod.
2. **Outreach** — draft a templated email and send it through the `ComplianceGuard` (corporate-only, warm-up-capped). Gated on operator activation.
3. **Ingest** — the agent's reply hits the Resend inbound webhook → a BullMQ job → extract structured fields, dedup, upsert a `Listing` (pre-market).
4. **Analyze** — Claude extracts/parses, Claude Haiku scores each photo against your taste, Voyage embeds listing + preferences into `vector(1024)`.
5. **List** — pgvector top-K + an LLM re-score ranks homes; the SPA shows a filterable table that links out to the source.

## Services

| Service | Runtime | Responsibility |
|---|---|---|
| `apps/api` | Fastify 5 + tRPC 11 | HTTP/tRPC surface; **raw webhook routes registered BEFORE the tRPC plugin** (Resend inbound + events, RFC-8058 unsubscribe); owns `prisma/` schema + migrations; init-container runs `prisma migrate deploy`. |
| `apps/processor` | BullMQ workers | The live data path — **consumes only**. One handler per job type; typed `retryable` errors drive BullMQ retry vs drop. |
| `apps/scheduler` | cron + leader-lock | **Registers** repeatable jobs only (Redis `SET NX PX` leader-lock + BullMQ `upsertJobScheduler`); the processor consumes them. |
| `apps/web` | React 19 + Vite + Tailwind 4 | SPA: Listings, Searches, Agents, Settings. Supabase sign-in; `Authorization: Bearer <jwt>` to the api. Served by nginx (Cloudflare Pages / k8s). |

Domain logic is **not** in the apps — it lives in `packages/backend-core` (`routers → services → repositories` + `lib/*`). The apps are thin: api wires routes + context, processor/scheduler wire handlers + DI. `packages/shared` holds zod schemas + UK constants used both sides.

## Queues & jobs

Added in lockstep in `packages/backend-core/src/lib/queue/queue-config.ts` (`QUEUE_NAMES` + `JOB_TYPES` + `JobPayloadByType` + `RETRY_POLICIES`):

| Job | Producer → Consumer | Purpose |
|---|---|---|
| `outreach:inbound` | inbound webhook → processor | hydrate the Resend message, extract → dedup → upsert listing, link reply |
| `resend:event` | events webhook → processor | record delivery/bounce/complaint into `EmailEvent` (feeds the circuit breaker) |
| `analyze:listing` / `analyze:recompute` | ingest / scheduler → processor | Claude extract, Haiku vision score, Voyage embed, write `ListingScore` |
| `outreach:send` / `outreach:followup` | router/approve → processor | guarded send (ComplianceGuard first), then persist + advance thread |
| `outreach:followup-scan` | scheduler → processor | find threads due a follow-up and enqueue `outreach:followup` |
| `warmup:recalc` | scheduler → processor | recompute the warm-up daily cap |
| `discover:agents` | Search launch → processor | run discovery over a Search's outcodes |

## Request & data flow (inbound — the live path)

```
Resend ──POST /webhooks/inbound──► apps/api raw route
   1. verify Svix HMAC over the RAW body (constant-time) ── reject if bad
   2. zod-validate ─► enqueue outreach:inbound (idempotency key = email_id) ─► 202
                                   │
   processor: hydrate (fetch body+attachments, SPF/DKIM verdicts DMARC-aligned, store to R2)
            ► handleOptOut (non-swallowed: STOP ⇒ suppress + opt out) [compliance-critical]
            ► ingestInboundEmail (extract ► dedup ► upsert Listing + ListingSourceRecord in ONE tx)
            ► linkReply (best-effort: advance OutreachThread — skipped on unauthenticated mail)
            ► enqueue analyze:listing
```

The outbound path mirrors it: a router enqueues `outreach:send` → the worker calls `ComplianceGuard.assertCanSend` (consuming a warm-up token) **before** `EmailProvider.send` → persists the `OutreachThread`/`OutreachMessage` and advances status.

## Data model (Prisma — key entities)

`apps/api/prisma/schema.prisma`. PKs `uuid`/`@db.Uuid`, timestamps `@db.Timestamptz(6)`, money as integer pence.

- **Listing** — canonical deduped record (`addressNormalized` unique, `postcode`/`outcode`, `pricePence`, enums, `listingStatus`, `isPreMarket`, `listingUrl`, `embedding Unsupported("vector(1024)")`, `agentEmail`/`agencyName`).
- **ListingSourceRecord** — raw provenance, `@@unique([sourceType, externalId])` for idempotent re-ingest (carries SPF/DKIM verdicts).
- **PhotoAnalysis** — per-photo `tasteScore`, features, `model`, `costPence`, dedup by image hash.
- **ListingScore** — `vectorScore` / `llmScore` / `combinedScore` / `rationale`.
- **Search** / **SearchProfile** — per-user buyer brief (location → outcodes, filters, free-text taste, `preferenceEmbedding`).
- **Agent** — `email` (unique), `agencyName`, `mailboxType` (PECR gate — only `corporate_subscriber` is cold-emailable), `optedOut`, `coveredOutcodes`, `lastContactedAt`.
- **OutreachThread** / **OutreachMessage** — conversation + per-email rows (status state machine; inbound carries `parsedListingIds` + SPF/DKIM verdicts).
- **SuppressionEntry**, **EmailEvent**, **WarmupState** — opt-out/bounce/complaint suppression; the circuit-breaker event feed; the warm-up cap + `killSwitch`.

**pgvector** is declared `Unsupported("vector(1024)")?` and read/written with raw `$queryRaw`/`$executeRaw` inside the repository (HNSW `vector_cosine_ops`); `CREATE EXTENSION vector` runs in a raw `migration.sql`.

## Auth & multi-user

Supabase Auth issues an ES256 JWT verified against the project JWKS (`lib/auth/supabase-auth.ts`, jose, alg-pinned). `ctx.user = { id, email } | null`. `ownerKeyFor(identity)` is the isolation chokepoint: the **operator** (`OPERATOR_USER_EMAIL`) → the `null` namespace shared with the automation engine; every other user → their Supabase `sub`. Per-user repositories filter on it; listings/agents are a global shared catalogue. Operator-only surfaces use `operatorProcedure`. Locally, leaving `SUPABASE_URL` unset enables the dev bypass (operator identity); in production an unset `SUPABASE_URL` makes the api refuse to start (fail closed).

## Infrastructure

- **k3s + FluxCD** — a dedicated `homeranger` namespace (PodSecurity `restricted`, default-deny NetworkPolicy both directions), own `homeranger-postgres` (pgvector) + `homeranger-redis`, non-root workloads with probes + resource limits. Flux image-automation bumps Deployments to the newest semver image tag.
- **Cloudflare** — tunnel ingress (outbound-only), Access (email allowlist; `/webhooks` + unsubscribe path-bypassed and independently signature-verified), R2 for attachments, DNS for the sending domain (SPF/DKIM/DMARC).
- **Secrets** — SOPS + age (`*.enc.yaml` / `*.enc.tfvars`); the runtime never holds the Supabase service-role key.
- **CI/CD** — `.github/workflows/ci.yml` (full matrix → `ci-gate`) on every PR; `release.yml` builds images to GHCR on a `vX.Y.Z` tag.

See [`SECURITY.md`](SECURITY.md), [`docs/runbooks/outreach-safety.md`](docs/runbooks/outreach-safety.md), and [`docs/TESTING.md`](docs/TESTING.md).
