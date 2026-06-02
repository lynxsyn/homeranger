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

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
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
        DEV_USER_EMAIL: "dev@homescout.local",
        // CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD intentionally UNSET → dev bypass.
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
