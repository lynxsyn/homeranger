/**
 * Test data cleanup — deletes test-created rows in FK-safe (reverse-dependency)
 * order, wrapped in a single transaction. Single-user app: no tenant scoping.
 * Rows are matched by their `test-` prefixed natural keys (addressNormalized,
 * email, externalId, providerMessageId) so specs that run against the shared
 * integration DB do not leak into each other.
 *
 * Mirrors doxus-web/packages/backend-core/src/test/cleanup.ts (minus tenants).
 * Grows as M2 entities land; the order below is the FK-safe teardown for the
 * M2 schema (children before parents).
 */
import type { PrismaClient } from "@prisma/client";

export async function cleanupTestData(
  prisma: PrismaClient,
  prefix?: string,
): Promise<void> {
  const pattern = prefix ? `test-${prefix}-` : "test-";

  // M4 listings store an UPPER-CASED addressNormalized (the dedup key builder
  // upper-cases), while M2/M3 fixtures use lower-case keys — so the prefix match
  // is case-INSENSITIVE to catch both.
  const addressMatch = { startsWith: pattern, mode: "insensitive" as const };

  await prisma.$transaction(async (tx) => {
    // ── Listing children ──────────────────────────────────────────────────
    // Per-search scores are keyed by (listingId, searchId); clear them by either
    // a test listing OR a test search so the Search delete below never FK-fails.
    await tx.listingScore.deleteMany({
      where: {
        OR: [
          { listing: { addressNormalized: addressMatch } },
          { search: { name: { startsWith: pattern } } },
        ],
      },
    });
    await tx.photoAnalysis.deleteMany({
      where: { listing: { addressNormalized: addressMatch } },
    });
    await tx.listingSourceRecord.deleteMany({
      where: {
        OR: [
          { externalId: { startsWith: pattern } },
          { listing: { addressNormalized: addressMatch } },
        ],
      },
    });
    await tx.listing.deleteMany({
      where: { addressNormalized: addressMatch },
    });

    // ── Searches (per-search match scoring) ───────────────────────────────
    // Test searches are named with the `test-` prefix; their scores were cleared
    // above, so this never FK-fails. Mirrors the per-test `cleanupSearches` the
    // search-repo integration spec runs (idempotent if both fire).
    await tx.search.deleteMany({ where: { name: { startsWith: pattern } } });

    // ── Outreach ──────────────────────────────────────────────────────────
    await tx.outreachMessage.deleteMany({
      where: { providerMessageId: { startsWith: pattern } },
    });
    await tx.outreachThread.deleteMany({
      where: { agent: { email: { startsWith: pattern } } },
    });

    // ── Email plumbing ──────────────────────────────────────────────────────
    await tx.emailEvent.deleteMany({
      where: { email: { startsWith: pattern } },
    });
    await tx.suppressionEntry.deleteMany({
      where: { email: { startsWith: pattern } },
    });

    // ── Agents ──────────────────────────────────────────────────────────────
    await tx.agent.deleteMany({
      where: { email: { startsWith: pattern } },
    });
  });
}
