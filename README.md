# homeranger

A self-hosted, single-tenant app that builds a private, curated feed of UK homes for sale — with the explicit goal of surfacing them **before** they hit the big portals (Rightmove / OnTheMarket / Zoopla).

The portals' APIs are closed to buyers and there is no cheap live "for-sale feed" API, but **estate agents** know about upcoming and off-market listings. So homeranger runs an autonomous-but-compliance-guarded loop: it **discovers** UK estate agents, **emails** them asking to be notified of upcoming listings, **ingests** their replies (free text + PDF/photo attachments), uses Claude to **extract** structured listing data and **score** photos against your taste, embeds everything for semantic match, and presents a filterable table that **links out** to the source (it never re-renders listing pages).

> **Status:** the discover → outreach → ingest → list loop is built and operator-drivable. Agent **discovery is live in prod**. Real **sending** is gated on operator activation (Resend domain verification + `RESEND_FROM`). Auth is multi-user (Supabase), currently behind a Cloudflare Access allowlist.

For the full reasoning see [`docs/plans/homeranger-plan.md`](docs/plans/homeranger-plan.md); for what's queued next see [`docs/specs/BUILD_ORDER.md`](docs/specs/BUILD_ORDER.md); for working in this repo as an agent see [`CLAUDE.md`](CLAUDE.md).

## Architecture at a glance

```
React SPA (apps/web)
      │  tRPC over HTTPS (Supabase-JWT auth)
      ▼
apps/api  (Fastify 5 + tRPC 11)  ── raw webhook routes (Resend inbound + events, unsubscribe) registered BEFORE tRPC
      │  enqueue (BullMQ / Redis)
      ├──────────────► apps/processor (BullMQ workers)
      │                  outreach:inbound · analyze:listing · outreach:send/followup · resend:event · discover:agents
      └──────────────► apps/scheduler (cron via Postgres leader-lock: followup-scan · warmup-recalc)
                         │
            Postgres (pgvector) · Redis · Cloudflare R2 (attachments)
```

All domain logic lives in **`packages/backend-core`** (`routers → services → repositories` + `lib/*`); **`packages/shared`** holds zod schemas + UK constants. Deployed to k3s via FluxCD; secrets via SOPS + age.

| Workspace | What it is |
|---|---|
| `apps/api` | Fastify 5 + tRPC 11 server; owns the Prisma schema + migrations (`apps/api/prisma`). |
| `apps/processor` | BullMQ workers — the live data path (ingest, analyze, send). |
| `apps/scheduler` | Cron jobs via a Redis/PG leader-lock (followup scan, warm-up recalc). |
| `apps/web` | React 19 + Vite + Tailwind 4 SPA (Listings, Searches, Agents, Settings). |
| `packages/backend-core` | Routers, services, repositories, and `lib/{auth,compliance,inbound,webhooks,discovery,email,geo,queue,rate-limit,storage,...}`. |
| `packages/shared` | Zod schemas + UK constants shared front-end/back-end. |
| `e2e` | Playwright end-to-end tests. |
| `infra` | Terraform (Cloudflare, Supabase) + k8s manifests for FluxCD. |

## Prerequisites

- **Node** ≥ 22.16.0 and **pnpm** ≥ 10.34.1 (`corepack enable`)
- **Docker** (local Postgres + Redis)
- **direnv** (auto-loads `.env`; `.envrc` is committed)
- **SOPS** + **age** (only for editing encrypted infra secrets)

## Local development

```bash
# 1. Install deps and copy the env template
pnpm install
cp .env.example .env            # fill in values; the FAKE seams below let the whole loop run with no paid API keys

# 2. Start local Postgres (pgvector) + Redis
pnpm dev:services               # docker compose -f docker-compose.dev.yaml up -d --wait

# 3. Apply the database schema
pnpm --filter @homeranger/api prisma:migrate

# 4. Run the services you need (separate terminals)
pnpm dev:api                    # Fastify + tRPC
pnpm dev:worker                 # BullMQ processor
pnpm dev:scheduler              # cron scheduler
pnpm dev:web                    # Vite SPA (http://localhost:5173)
```

**Test seams.** The worker and AI/email/discovery layers sit behind env-gated fakes so a full local loop needs **no paid API keys**: set `RESEND_FAKE=1 EXTRACTION_FAKE=1 ANALYSIS_FAKE=1 OUTREACH_FAKE=1 DISCOVERY_FAKE=1` (see [`.env.example`](.env.example) and the testing notes in [`CLAUDE.md`](CLAUDE.md)). Real keys (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `RESEND_API_KEY`, `FIRECRAWL_API_KEY`, R2) are only needed to exercise the real providers.

> Auth note: setting `SUPABASE_URL` locally turns **off** the dev auth bypass and requires a real Supabase sign-in; leave it unset for the bypass (the operator identity). The bypass is fail-closed in production (the API refuses to start if `SUPABASE_URL` is missing).

## Testing

```bash
pnpm typecheck                  # tsc across all packages
pnpm lint                       # eslint, zero warnings
pnpm test                       # unit (vitest, fakes — no infra)
pnpm test:integration           # integration (real pgvector via docker)
pnpm test:coverage              # unit + coverage gate (lines 90 / branches 80 / funcs 85 / stmts 90)
pnpm test:e2e                   # Playwright (needs the app + services running)
pnpm build                      # build every package in dependency order
```

CI (`.github/workflows/ci.yml`) runs the full matrix on every PR; the `ci-gate` check is required to merge.

## Deployment

Images are built and pushed to GHCR by `.github/workflows/release.yml` on a `vX.Y.Z` tag, then **FluxCD** reconciles them onto the k3s cluster. Cloudflare provides the tunnel ingress + Access. See [`infra/deploy/flux/README.md`](infra/deploy/flux/README.md) and [`infra/terraform/supabase/README.md`](infra/terraform/supabase/README.md).

## Contributing

This repo follows the AIDE Change Delivery Protocol (worktree → tests → review → verify → ready PR → CI → squash-merge → release tag). Work happens in a git worktree, never the main checkout. See [`CLAUDE.md`](CLAUDE.md) for the full conventions, commands, and release/verify envelope.
