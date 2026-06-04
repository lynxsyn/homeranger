# Testing

Three layers, all run in CI on every PR and aggregated into the required `ci-gate` check. TDD is a hard gate: tests are written and committed **red** before the implementation (see the workspace [`CLAUDE.md`](../CLAUDE.md)).

| Layer | Command | What it covers | Infra |
|---|---|---|---|
| Unit | `pnpm test` | services, guards, validation, pure logic | none (fakes via DI) |
| Integration | `pnpm test:integration` | repositories, real pgvector ordering, cross-service | docker Postgres |
| Coverage | `pnpm test:coverage` | unit + thresholds | none |
| E2E | `pnpm test:e2e` | user journeys, rendering, auth flows | running app + services |
| All | `pnpm test:all` | unit + integration | docker Postgres |

`vitest.config.ts` defines the `unit` and `integration` projects; `playwright.config.ts` defines E2E.

## Fake seams (the most important thing to know)

The AI / email / discovery providers sit behind **env-gated fakes** so unit, integration, and E2E never touch a paid API or the network. Set the relevant `*_FAKE=1`:

| Var | Fakes |
|---|---|
| `RESEND_FAKE` | email send + the inbound hydrator (derives a deterministic body from webhook metadata) |
| `EXTRACTION_FAKE` | Claude structured extraction |
| `ANALYSIS_FAKE` / `VISION_FAKE` | the analyze pipeline / Haiku vision scoring |
| `EMBEDDING_FAKE` | Voyage embeddings |
| `MATCH_FAKE` | the hybrid match re-score |
| `DISCOVERY_FAKE` | Firecrawl agent discovery |
| `OUTREACH_FAKE` | the outbound `EmailProvider` |

A full local worker boot with the fakes also needs `RESEND_FROM` set and the R2 vars present (the worker validates R2 config at boot). The concrete fakes live next to their real implementations (e.g. `FakeResendHydrator` in `lib/inbound/resend-hydrator.ts`, selected by `RESEND_FAKE=1`).

## Coverage gate

Thresholds in `vitest.config.ts`: **lines 90 / branches 80 / functions 85 / statements 90**. Run from the **worktree root** — CI runs vitest from the checked-out PR branch (which includes the feature's new files); running from the main repo root can miss them and report a falsely-passing number.

Prisma-I/O repositories, network-I/O adapters, and side-effecting bootstraps (`main.ts`, `worker.ts`, `scheduler.ts`, `context.ts`, the real AI/email providers) are in `coverage.exclude` — they're proven by integration/E2E, not unit. When you add such a file, add it to the exclude list; otherwise it drags coverage down for I/O that unit tests can't meaningfully cover.

## Worktree env gotcha (read this if unit tests fail locally but pass in CI)

The operator's real, gitignored `.env` sets `OPERATOR_USER_EMAIL` and `SUPABASE_URL`, and **direnv re-injects them into every shell command** — so `mv .env` aside and `env -u VAR` both lose to the per-command direnv hook. Several `searches.router` operator-owner-key tests assume those vars are **unset** (they expect `ownerKeyFor → null`; they're green in CI, which has no `.env`). To replicate CI locally, clear them **inline**:

```bash
OPERATOR_USER_EMAIL= SUPABASE_URL= ALLOWED_USER_EMAIL= DEV_USER_EMAIL= \
  npx vitest run --project unit
```

An inline assignment wins for that process where `env -u` does not.

## Integration tests

Need a real Postgres with pgvector. Start it with `pnpm dev:services` (or `docker-compose.ci.yaml` for the CI shape), then `pnpm test:integration`. They assert real behaviour — e.g. cosine ordering from the HNSW index — that unit fakes can't.

## E2E

Playwright drives the SPA against a running api (`:3000`) + vite (`:5173`). Locally it hardcodes those ports and `reuseExistingServer` is on, so a parallel dev session on the same ports makes Playwright drive the wrong app (the page snapshot is the tell). The CI e2e job runs on isolated fresh ports and is the **authoritative** E2E gate; prefer it over fighting local port conflicts. The E2E suite forces the dev auth bypass back on via `VITE_E2E_AUTH_BYPASS=1` in `playwright.config.ts`.

## What every behaviour change needs

- A regression/feature test at the right layer, committed red first.
- New UI route → a Playwright golden-path test (a CRITICAL review finding if missing).
- Coverage must not drop below the floors.
