/**
 * Web unit-test config. Runs the React component + pure-logic tests under
 * happy-dom with @testing-library. Separate from the root vitest.config.ts
 * (which only covers the backend packages); these run via
 * `pnpm --filter @homeranger/web test` and the CI `web-unit` job.
 *
 * Tests mock the tRPC client (`src/lib/trpc`), so no backend/DB is needed —
 * type-only imports of @homeranger/backend-core / @homeranger/shared are erased
 * by esbuild at test runtime.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
