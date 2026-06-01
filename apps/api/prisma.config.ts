// Prisma 7 moved datasource URL + migration path config out of the schema
// and into this file (the `datasource db { url = env(...) }` block no longer
// exists in Prisma 7 schemas — the URL is resolved here for the migrate engine
// and via the PrismaPg adapter at runtime). Mirrors the Doxus precedent at
// doxus-web/apps/control-plane-api/prisma.config.ts.
//
// MIGRATION_DATABASE_URL connects as `homescout_migrator` (owns the schema,
// allowed to run DDL incl. CREATE EXTENSION/CREATE INDEX). `prisma migrate
// deploy` / `prisma migrate dev` read this; runtime uses the pg adapter.
import "dotenv/config";
import { defineConfig } from "prisma/config";

// `prisma migrate` connects as MIGRATION_DATABASE_URL (the homescout_migrator
// role — DDL incl. CREATE EXTENSION/INDEX). We read process.env directly with a
// localhost fallback instead of prisma/config's throwing `env()` so that
// `prisma generate` (which does NOT connect) succeeds with no env set — e.g. in
// the CI `check` job and on a fresh clone. `migrate` is always invoked with the
// real MIGRATION_DATABASE_URL; the fallback only fails fast (connection error)
// if someone runs migrate without it.
const migrationUrl =
  process.env.MIGRATION_DATABASE_URL ??
  "postgresql://homescout:homescout@localhost:5432/homescout";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: migrationUrl,
  },
});
