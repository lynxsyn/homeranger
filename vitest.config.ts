import { defineConfig } from "vitest/config";

// Mirrors doxus-web/vitest.config.ts: one root config with named `unit` and
// `integration` projects + v8 coverage measured against the unit project.
//
// homescout simplifications vs Doxus:
//   - No `tools` project (no scripts/ test surface yet).
//   - Single-user app: no SuperTokens / tenant seed gate; the integration
//     globalSetup only verifies a live pgvector connection.
//   - Coverage `include` covers the four apps + the two shared packages.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "apps/api/src/**/*.ts",
        "apps/processor/src/**/*.ts",
        "apps/scheduler/src/**/*.ts",
        "packages/backend-core/src/**/*.ts",
        "packages/shared/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.integration.test.ts",
        "**/test/**",
        "**/__tests__/**",
        "**/prisma/**",
        "**/dist/**",
        // index barrels carry no logic.
        "**/index.ts",
        "apps/*/src/index.ts",
        // The API entrypoint is a side-effecting bootstrap (Fastify listen +
        // raw /api/health|/api/version routes + tRPC mount). It is proven by
        // the Playwright E2E (which boots the real server), not by unit tests;
        // excluded to avoid a false unit-coverage drop (same rationale as the
        // repository excludes above). The context.ts module reads CF Access
        // env at import time + builds ctx.user from the request — exercised via
        // the cloudflare-access unit tests (resolveCfAccessIdentity) and E2E.
        "apps/api/src/main.ts",
        "packages/backend-core/src/context.ts",
        // The repository methods + the Prisma client need a live pgvector and
        // are exercised by the integration project, not unit. Excluded to avoid
        // a false unit-coverage drop (mirrors Doxus's dashboard.repository.ts
        // precedent). Their pure helpers (toVectorLiteral) are covered by the
        // backend-core unit tests via the exported helper, not the class.
        "packages/backend-core/src/lib/prisma.ts",
        "packages/backend-core/src/repositories/listing.repository.ts",
        "packages/backend-core/src/repositories/listing-source-record.repository.ts",
        "packages/backend-core/src/repositories/agent.repository.ts",
        "packages/backend-core/src/repositories/outreach.repository.ts",
        "packages/backend-core/src/repositories/search-profile.repository.ts",
        // M4 repositories — same Prisma-I/O rationale as the M2/M3 repos above
        // (exercised by the integration project, not unit).
        "packages/backend-core/src/repositories/email-event.repository.ts",
        "packages/backend-core/src/repositories/suppression-entry.repository.ts",
        // M4 queue layer — Redis I/O. The BullMQ client + connection + metrics
        // are proven by the integration/E2E paths (the live worker consuming a
        // real queue), not by unit tests, which would only mock Redis.
        "packages/backend-core/src/lib/queue/queue-client.ts",
        "packages/backend-core/src/lib/queue/queue-metrics.ts",
        "packages/backend-core/src/lib/queue/redis-connection.ts",
        "packages/backend-core/src/lib/queue/enqueue.ts",
        // M4 R2 storage — S3/R2 network I/O (integration/E2E-proven).
        "packages/backend-core/src/lib/storage/r2.ts",
        // M4 inbound seams — the hydrator interface + env-gated fakes are
        // exercised end-to-end by the E2E inbound spec (RESEND_FAKE path); the
        // adapter does unpdf file-I/O. All proven by E2E, not unit.
        "packages/backend-core/src/lib/inbound/resend-hydrator.ts",
        "packages/backend-core/src/lib/ai/listing-extraction.adapter.ts",
        "packages/backend-core/src/lib/ai/fake-extraction.provider.ts",
        // M4 inbound-ingestion service — orchestration around a runTransaction;
        // proven by the inbound-ingestion integration test (real pgvector) +
        // the E2E inbound spec, like the repository layer above. Its dedup /
        // extraction branching is unit-covered via dedup.service + the Claude
        // extraction provider tests.
        "packages/backend-core/src/services/inbound-ingestion.service.ts",
        // M4 processor — side-effecting BullMQ worker bootstrap (DB + Redis +
        // metrics server). Proven by the E2E inbound spec (the live worker
        // consuming a real queue), not unit. Same rationale as apps/api/main.ts.
        "apps/processor/src/worker.ts",
        "apps/processor/src/resend-hydrator.ts",
      ],
      thresholds: {
        // Floor with deliberate HEADROOM, not floor(measured). Measured M3 is
        // ~98.7/96/96/98.7 (lines/functions/statements/branches) against a
        // SMALL denominator (router + cf-access + cursor + shared schemas;
        // repositories, main.ts, context.ts are excluded as integration/E2E-
        // tested). At floor=98 a single uncovered branch — or the normal first
        // push of an M4 feature before its tests are wired — drops below floor
        // and red-fails CI with zero code defect. We floor BELOW measured so
        // the ratchet is a real guard, not friction: still high (coverage only
        // goes up over time), with buffer for v8 local-vs-CI attribution drift.
        lines: 90,
        functions: 85,
        statements: 90,
        branches: 85,
      },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "apps/api/src/**/*.test.ts",
            "apps/processor/src/**/*.test.ts",
            "apps/scheduler/src/**/*.test.ts",
            "packages/backend-core/src/**/*.test.ts",
            "packages/shared/src/**/*.test.ts",
          ],
          exclude: [
            "apps/api/src/**/*.integration.test.ts",
            "apps/processor/src/**/*.integration.test.ts",
            "apps/scheduler/src/**/*.integration.test.ts",
            "packages/backend-core/src/**/*.integration.test.ts",
            "packages/backend-core/src/__tests__/**",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "apps/api/src/**/*.integration.test.ts",
            "apps/processor/src/**/*.integration.test.ts",
            "apps/scheduler/src/**/*.integration.test.ts",
            "packages/backend-core/src/**/*.integration.test.ts",
            "packages/backend-core/src/__tests__/**/*.test.ts",
          ],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
          globalSetup: ["packages/backend-core/src/test/setup-integration.ts"],
          // Single worker, no isolation: shared pgvector connection, deterministic
          // ordering for cleanup between specs (mirrors Doxus integration project).
          pool: "forks",
          maxWorkers: 1,
          isolate: false,
        },
      },
    ],
  },
});
