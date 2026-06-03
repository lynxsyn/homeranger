/**
 * Database test helper — provides a Prisma client (driver-adapter / @prisma/adapter-pg)
 * for integration tests. Requires a pgvector Postgres running via
 * `pnpm dev:services` (docker-compose.dev.yaml) and migrations applied via
 * `pnpm --filter @homeranger/api prisma:deploy`.
 *
 * Mirrors doxus-web/packages/backend-core/src/test/db-helper.ts.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Ensure the integration globalSetup " +
        "(setup-integration.ts) ran, or export DATABASE_URL before running tests.",
    );
  }
  return url;
}

let prisma: PrismaClient | undefined;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    const adapter = new PrismaPg({ connectionString: getDatabaseUrl() });
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}

export { cleanupTestData } from "./cleanup.js";
