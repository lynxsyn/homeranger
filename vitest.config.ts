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
      ],
      thresholds: {
        // M2 floor = floor(measured) from the first `pnpm test:coverage` run
        // (Code Coverage Enforcement: coverage only goes up). Measured M2:
        // lines 96.92 / branches 90.9 / functions 88.88 / statements 96.96.
        // The repository/raw-vector paths are integration-tested (excluded from
        // the unit project above), so this floor tracks the unit-testable
        // surface: cursor helper + shared enums/schemas/UK helpers.
        lines: 96,
        functions: 88,
        statements: 96,
        branches: 90,
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
