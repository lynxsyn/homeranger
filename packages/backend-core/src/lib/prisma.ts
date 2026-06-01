import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Single-user homescout: one DATABASE_URL, one PrismaClient. No admin/RLS
// second connection (Doxus needed prismaAdmin for its BYPASSRLS admin role;
// homescout is single-user with no RLS, so that split is intentionally gone).
// The local default matches the homescout-postgres dev port (5434, the
// hs-pgvector-dev container); production injects DATABASE_URL from the
// SOPS-sealed secret.
const DEFAULT_DATABASE_URL =
  "postgresql://homescout:homescout@localhost:5434/homescout";
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

const adapter = new PrismaPg({ connectionString: DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
});

/**
 * Run a callback inside an interactive Prisma transaction. Repositories that
 * compose multiple writes accept an optional `tx`; callers that need to span
 * several repositories wrap them here so they share one transaction client.
 */
export function runTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn);
}
