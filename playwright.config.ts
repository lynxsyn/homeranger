/**
 * Playwright config — M3 listings-table E2E.
 *
 * webServer array (Doxus pattern) starts two services:
 *   - api on :3000 — `prisma:deploy && db:seed && dev` chained, with
 *     DATABASE_URL + MIGRATION_DATABASE_URL set and CF_ACCESS_* DELIBERATELY
 *     UNSET so the protectedProcedure takes the dev-bypass path (every request
 *     authenticates as DEV_USER_EMAIL — no Cloudflare tunnel / token needed).
 *   - web on :5173 — the Vite dev server, which proxies /trpc + /api → :3000.
 *
 * baseURL = E2E_BASE_URL ?? http://localhost:5173. `reuseExistingServer` is on
 * locally (fast iteration) and off in CI. Both prisma:deploy and db:seed are
 * idempotent, so a reused local server does not double-seed.
 *
 * Locally point the DB at the docker-compose pgvector (host port 5434); CI sets
 * the env to its 5432 service container (see .github/workflows/ci.yml e2e job).
 */
import { defineConfig } from "@playwright/test";

const E2E_BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

const DEFAULT_DB_URL =
  "postgresql://homescout:homescout@localhost:5434/homescout";
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const MIGRATION_DATABASE_URL =
  process.env.MIGRATION_DATABASE_URL ?? DATABASE_URL;

// Local docker redis (docker-compose.dev.yaml — no password); CI sets REDIS_URL
// to its service container. The M4 inbound webhook E2E needs the BullMQ worker
// running to consume outreach:inbound and upsert the Listing.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
// A deterministic Svix signing secret the inbound webhook route verifies
// against; the spec signs its POST with the SAME value. Test-only (exported so
// the spec can import it).
export const E2E_RESEND_INBOUND_SECRET =
  process.env.RESEND_INBOUND_WEBHOOK_SECRET ??
  "whsec_aG9tZXNjb3V0LWUyZS1pbmJvdW5kLXNlY3JldA==";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  // Single worker — the specs share one pgvector DB; parallel workers would race
  // (a concurrent M4 inbound write would change the M3 row count mid-assertion).
  // The M4 inbound spec also cleans up its own row in afterAll so the seeded set
  // is restored. (CI already ran single-worker.)
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command:
        "pnpm --filter @homescout/api prisma:deploy && " +
        "pnpm --filter @homescout/api db:seed && " +
        // Non-watch entrypoint (e2e:api = `tsx src/main.ts`). A file watcher
        // under Playwright can tear down + rebind :3000 mid-run and flake an
        // in-flight tRPC request, so we use the dedicated non-watch script.
        "pnpm --filter @homescout/api e2e:api",
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_URL,
        MIGRATION_DATABASE_URL,
        REDIS_URL,
        DEV_USER_EMAIL: "dev@homescout.local",
        // The inbound webhook route verifies Svix signatures against this; the
        // M4 spec signs its POST with the same value.
        RESEND_INBOUND_WEBHOOK_SECRET: E2E_RESEND_INBOUND_SECRET,
        RESEND_WEBHOOK_SECRET: E2E_RESEND_INBOUND_SECRET,
        // CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD intentionally UNSET → dev bypass.
        NODE_ENV: "development",
      },
    },
    {
      // M4 BullMQ worker — consumes outreach:inbound and upserts the Listing.
      // RESEND_FAKE + EXTRACTION_FAKE keep it network-free (no real Resend /
      // Anthropic calls): the fake hydrator derives a body from the webhook
      // metadata and the fake extractor parses the address/price from the
      // subject. /health on :9090 gates readiness.
      command: "pnpm --filter @homescout/processor e2e:worker",
      port: 9090,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_URL,
        REDIS_URL,
        METRICS_PORT: "9090",
        RESEND_FAKE: "1",
        EXTRACTION_FAKE: "1",
        // M5: deterministic, network-free analysis (no Anthropic/Voyage/R2). The
        // fake vision/embedding/match/photo providers drive PhotoAnalysis +
        // Listing.embedding + ListingScore so the row-expand renders real data.
        ANALYSIS_FAKE: "1",
        // M6: deterministic, network-free outbound send (no real Resend). The
        // fake send provider returns a stable providerMessageId so the guard
        // E2E can assert an OutreachMessage row lands. RESEND_FROM satisfies the
        // OutreachService boot config (the verified sending address).
        OUTREACH_FAKE: "1",
        RESEND_FROM: "Homescout <outreach@homescout.test>",
        NODE_ENV: "development",
      },
    },
    {
      command: "pnpm --filter @homescout/web dev",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
