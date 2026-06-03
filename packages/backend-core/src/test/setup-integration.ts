/**
 * Vitest globalSetup for the `integration` project.
 *
 * Contract (mirrors doxus-web/.../setup-integration.ts):
 *   - Migrations are NOT run here — that is the caller's job
 *     (`pnpm --filter @homeranger/api prisma:deploy` locally / the CI step).
 *   - This setup only resolves DATABASE_URL, verifies pgvector connectivity,
 *     and confirms the `vector` extension + the Listing.embedding column exist
 *     so specs fail fast with a clear message instead of a cryptic SQL error.
 *
 * Single-user app: there is no tenant/user/seed gate (Doxus's seed checks are
 * intentionally dropped).
 */
import { getTestPrisma, disconnectTestPrisma } from "./db-helper.js";

// Matches the live hs-pgvector-dev container (host port 5434, db `homeranger`).
const DEFAULT_DATABASE_URL =
  "postgresql://homeranger:homeranger@localhost:5434/homeranger";

export default async function setup() {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL === "") {
    process.env.DATABASE_URL = DEFAULT_DATABASE_URL;
  }

  const prisma = getTestPrisma();

  // 1. Connectivity — fail fast, no silent skip.
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    throw new Error(
      `Integration test setup failed: cannot connect to PostgreSQL at ` +
        `${process.env.DATABASE_URL}. Run: pnpm dev:services && ` +
        `pnpm --filter @homeranger/api prisma:deploy`,
      { cause: err },
    );
  }

  // 2. pgvector extension present (raw migration installs it).
  const ext = await prisma.$queryRaw<Array<{ extname: string }>>`
    SELECT extname FROM pg_extension WHERE extname = 'vector'
  `;
  if (ext.length === 0) {
    throw new Error(
      "Integration test setup failed: the `vector` extension is not installed. " +
        "The raw pgvector migration must run before integration tests: " +
        "pnpm --filter @homeranger/api prisma:deploy",
    );
  }

  // 3. Listing.embedding column exists as vector(1024).
  const col = await prisma.$queryRaw<Array<{ udt_name: string }>>`
    SELECT udt_name
    FROM information_schema.columns
    WHERE table_name = 'Listing' AND column_name = 'embedding'
  `;
  if (col.length === 0) {
    throw new Error(
      "Integration test setup failed: Listing.embedding column missing. " +
        "Ensure the raw pgvector migration applied: " +
        "pnpm --filter @homeranger/api prisma:deploy",
    );
  }

  // Vitest globalSetup teardown contract.
  return async () => {
    await disconnectTestPrisma();
  };
}
