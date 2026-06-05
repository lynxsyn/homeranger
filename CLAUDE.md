# homeranger — repo overlay for agents

This is the **per-project overlay** to the workspace-root AIDE workflow (`/Users/lynx/projects/CLAUDE.md`). The root file owns the Change Delivery Protocol; this file owns the homeranger-specific commands, conventions, and the release/verify envelope. Read both.

See also: [`README.md`](README.md) (what it is + local bring-up), [`docs/plans/homeranger-plan.md`](docs/plans/homeranger-plan.md) (the architecture/data-flow reference), [`docs/specs/BUILD_ORDER.md`](docs/specs/BUILD_ORDER.md) (what's queued), [`docs/decisions/`](docs/decisions/) (ADRs), [`docs/compliance/`](docs/compliance/) (LIA + ROPA).

## What it is (one paragraph)

A self-hosted, single-tenant UK property-discovery tool. It discovers estate agents, sends compliance-guarded cold outreach asking for pre-market listings, ingests their email replies (Claude extracts structured fields + scores photos, Voyage embeds for semantic match), and shows a filterable table that links out to the source. pnpm monorepo; Fastify + tRPC api, BullMQ processor, cron scheduler, React/Vite SPA; Postgres+pgvector, Redis, Cloudflare R2; deployed to k3s via FluxCD.

## Worktree discipline (enforced)

A PreToolUse hook **blocks edits/commits in the main checkout**. Always work in a worktree off fresh `origin/main`, and keep your shell `cd`'d into it (the hook keys off the working directory):

```bash
git -C /Users/lynx/projects/homeranger fetch --quiet origin main
git -C /Users/lynx/projects/homeranger worktree add /Users/lynx/projects/homeranger/.worktrees/<feature> -b <prefix>/<feature> origin/main
cd /Users/lynx/projects/homeranger/.worktrees/<feature>
pnpm install --frozen-lockfile        # worktrees carry no node_modules
pnpm --filter @homeranger/api prisma:generate
cp ../../.env .env                    # the real .env is gitignored + lives only in the main checkout (direnv sources $PWD/.env)
```

Branch prefixes: `ops/ feat/ fix/ refactor/`. Open PRs **ready, not draft**. Merge with `gh pr merge <N> --squash` once `ci-gate` is green (branch protection requires it; merged branches auto-delete). Files under `.claude/` are exempt from the edit block (machine-local config).

## Commands

| Task | Command |
|---|---|
| Install (in a worktree) | `pnpm install --frozen-lockfile` then `pnpm --filter @homeranger/api prisma:generate` |
| Local services | `pnpm dev:services` (docker Postgres+Redis), then `pnpm dev:api` / `dev:worker` / `dev:scheduler` / `dev:web` |
| Migrate | `pnpm --filter @homeranger/api prisma:migrate` (dev) · `prisma:deploy` (prod, run by the api init-container) |
| Typecheck / lint | `pnpm typecheck` · `pnpm lint` (zero warnings) |
| Unit / integration / e2e | `pnpm test` · `pnpm test:integration` · `pnpm test:e2e` |
| Coverage gate | `pnpm test:coverage` (from the **worktree root**) |
| Build | `pnpm build` (ordered: shared → backend-core → api → processor → scheduler → web) |

## Conventions (the bar reviewers hold)

- **Layering:** `routers → services → repositories`. **Repositories own ALL Prisma** — `prisma.*` appears nowhere else. Services are transport-free.
- **Errors:** routers throw `TRPCError` (codes only). Worker-side services throw a **transport-free typed error with a `retryable` flag** (`InboundIngestionError`, `ComplianceError`, …); `apps/processor/.../worker-error.ts` maps `!retryable → UnrecoverableError` (drop) and `retryable → rethrow` (BullMQ backoff). The router maps `error.trpcCode → TRPCError`.
- **Money:** prices are **integer pence** (`pricePence Int`), never floats.
- **Pagination:** cursor-based `{ items, nextCursor }`, default 20 / max 100.
- **Types:** TS strict, **no `any`**. Zod schemas in `packages/shared` are `.strict()` (no mass-assignment).
- **Auth scoping:** `ownerKeyFor(identity)` is the single chokepoint — operator → `null` namespace, every other user → their Supabase `sub`. Per-user repos (`search`, `searchProfile`, `savedListing`) filter on it; listings/agents are a global shared catalogue. Operator-only surfaces use `operatorProcedure`.
- **Queues:** adding a queue requires the 4-structure lockstep in `lib/queue/queue-config.ts` (`QUEUE_NAMES` + `JOB_TYPES` + `JobPayloadByType` + `RETRY_POLICIES`) plus a thin `enqueueX` helper. Scheduler registers repeatable jobs (Redis leader-lock); processor consumes.
- **Migrations:** hand-authored `NNNN_name/migration.sql` that matches `schema.prisma` exactly (edit both). pgvector lives behind `Unsupported("vector(1024)")` + raw `$queryRaw`/`$executeRaw` in the repo (HNSW `vector_cosine_ops`); `CREATE EXTENSION vector` runs in a raw migration.
- **Outreach copy:** templates, not LLM-generated; **no em/en dashes** in email body/subject/footer (reads as an AI tell to agents). Tone matches the buyer's urgency.

## Testing notes

- **Fake seams.** AI/email/discovery providers sit behind env-gated fakes so unit/integration/E2E never hit a paid API: `RESEND_FAKE` `EXTRACTION_FAKE` `ANALYSIS_FAKE` `VISION_FAKE` `EMBEDDING_FAKE` `MATCH_FAKE` `CLASSIFY_FAKE` `DISCOVERY_FAKE` `OUTREACH_FAKE` (=`1`). `CLASSIFY_FAKE` (folded under `ANALYSIS_FAKE`, like `MATCH_FAKE`) swaps the agent-quality classifier for the deterministic fake. The full worker fake set also needs `RESEND_FROM` + the R2 vars to boot.
- **Coverage gate** (`vitest.config.ts`): lines **90** / branches **80** / functions **85** / statements **90**. Run `pnpm test:coverage` **from the worktree root** (CI checks the PR branch; the main repo root misses new files). Prisma-I/O repos, network adapters, and side-effecting bootstraps (`main.ts`/`worker.ts`/`scheduler.ts`/`context.ts`) are coverage-`exclude`d — add new ones there.
- **Worktree env gotcha.** The real gitignored `.env` sets `OPERATOR_USER_EMAIL` and `SUPABASE_URL`, and **direnv re-injects them into every shell command** (so `mv .env` aside and `env -u` both fail). Several `searches.router` operator-owner-key tests assume those are **unset** (green in CI, which has no `.env`). To replicate CI locally, clear them **inline**: `OPERATOR_USER_EMAIL= SUPABASE_URL= ALLOWED_USER_EMAIL= DEV_USER_EMAIL= npx vitest run --project unit`.
- **E2E** hardcodes api `:3000` + vite `:5173` and `reuseExistingServer` outside CI — a parallel dev session on those ports makes Playwright drive the wrong app. CI's isolated e2e job is the authoritative gate.

## Release + verify envelope (Change Delivery Protocol steps 16–17)

Non-chore merges get a release tag + post-release verify. Run from the main checkout with the squash-**merge SHA**:

```bash
# Tag (auto-picks bump: fix:/chore: → PATCH, feat → MINOR, !:/BREAKING → MAJOR; BUMP_HINT overrides)
MERGE_SHA=<sha> SPEC_ID=<id> SPEC_NAME="<name>" BUMP_HINT=fix \
  bash .aide/release-tag-policy.sh        # cuts + pushes vX.Y.Z → triggers .github/workflows/release.yml

# Verify the rollout (needs cluster kubectl OR a public base URL + CF Access service tokens)
MERGE_SHA=<sha> VERIFY_MODE=app VERIFY_API_BASE_URL=https://<host> \
  CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
  bash .aide/post-release-verify.sh       # Flux reconcile → rollout → /api/health + /api/version==SHA → /trpc routing
```

`VERIFY_MODE=app` waits for the api Deployment, asserts `/api/version` contains the merge SHA, and (through the public edge) that `/trpc` reaches the API as JSON not the SPA shell. Docs-only / config-only changes skip the tag (no runtime change). A merged PR is **not shipped** until verify exits 0.

## CI / branch protection

`.github/workflows/ci.yml` runs the full matrix (`check`, `api-unit`, `web-unit`, `api-integration`, `e2e`, `secret-scan`) and aggregates to `ci-gate` on every PR and push to main — no path-ignore, so docs PRs run it too. The `main` ruleset requires `ci-gate`; the Flux deploy key is the only bypass actor (its `chore(flux)` image-tag commits use `[skip ci]`). Target **one** CI run per PR: work locally through verify, push once.

## The outreach safety model (operationally load-bearing)

Every send passes a single `ComplianceGuard.assertCanSend` chokepoint (`lib/compliance/compliance-guard.ts`) — 7 ordered gates: PECR corporate-subscriber-only → opt-out → suppression → per-domain cooldown → reputation circuit-breaker (bounce/complaint) → manual kill-switch → warm-up token-bucket daily cap. Inbound replies are gated on sender authentication (SPF/DKIM, DMARC-aligned); opt-out is honoured generously (never dropped). Backed by `docs/compliance/{legitimate-interest-basis,agent-sourcing-basis,ropa}.md`. The kill-switch lives in `WarmupState.killSwitch` (Settings → Outreach in the SPA). **To go live:** verify the Resend sending domain + set `RESEND_FROM`.
