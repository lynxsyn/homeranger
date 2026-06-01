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
import { defineConfig, env } from "prisma/config";

type Env = {
  MIGRATION_DATABASE_URL: string;
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env<Env>("MIGRATION_DATABASE_URL"),
  },
});
