/**
 * DismissedListing repository — owns ALL Prisma access for the per-user
 * "dismissed" (hidden) overlay on the global Listing catalogue. The exact mirror
 * of SavedListingRepository, opposite intent: a dismiss buries a home from the
 * buyer's working feed, a restore brings it back. Explicit owner scoping,
 * optional-tx, exported singleton + test setter. Coverage-excluded (Prisma I/O)
 * like the sibling repos — exercised by the dismissed-listing integration test,
 * not the unit project.
 *
 * Owner key follows the Search/SearchProfile/SavedListing convention:
 * `ownerId == null` is the operator namespace, a set `ownerId` is that user's
 * namespace. Uniqueness of (owner, listing) is enforced by the COALESCE
 * expression index from migration 0010, so `dismiss` / `dismissMany` are
 * idempotent (a duplicate raises P2002 → swallowed; `dismissMany` uses
 * skipDuplicates so a re-dismiss is a no-op).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

export class DismissedListingRepository {
  /**
   * Dismiss (hide) a listing for `ownerId`. Idempotent: a second dismiss of the
   * same (owner, listing) is a no-op (the unique index raises P2002, swallowed)
   * rather than an error. Returns true when a new row was created.
   */
  async dismiss(
    ownerId: string | null,
    listingId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const db: PrismaLike = tx ?? prisma;
    try {
      await db.dismissedListing.create({ data: { userId: ownerId, listingId } });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return false; // already dismissed → idempotent no-op
      }
      throw error;
    }
  }

  /**
   * Dismiss MANY listings for `ownerId` in one statement — the search-removal
   * cascade's bulk-hide. `skipDuplicates` makes it idempotent against the
   * COALESCE unique index (already-dismissed homes are silently skipped via
   * `ON CONFLICT DO NOTHING`). Returns the count of newly-dismissed rows. An
   * empty id list is a no-op (returns 0). Accepts a `tx` so the cascade hides
   * homes, removes agents, and deletes the search in ONE transaction.
   */
  async dismissMany(
    ownerId: string | null,
    listingIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (listingIds.length === 0) {
      return 0;
    }
    const db: PrismaLike = tx ?? prisma;
    const result = await db.dismissedListing.createMany({
      data: listingIds.map((listingId) => ({ userId: ownerId, listingId })),
      skipDuplicates: true,
    });
    return result.count;
  }

  /** Restore (un-dismiss) a listing for `ownerId`. Idempotent (no row → no-op). */
  async restore(
    ownerId: string | null,
    listingId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const db: PrismaLike = tx ?? prisma;
    const result = await db.dismissedListing.deleteMany({
      where: { userId: ownerId, listingId },
    });
    return result.count > 0;
  }

  /**
   * The listing ids `ownerId` has dismissed, most-recently-dismissed first. The
   * SPA uses this id set to compute the Active / Saved / Dismissed buckets and
   * the router hydrates them into full listing rows via listingRepository.
   */
  async listDismissedListingIds(ownerId: string | null): Promise<string[]> {
    const rows = await prisma.dismissedListing.findMany({
      where: { userId: ownerId },
      orderBy: [{ createdAt: "desc" }],
      select: { listingId: true },
    });
    return rows.map((row) => row.listingId);
  }
}

const defaultDismissedListingRepository = new DismissedListingRepository();

export let dismissedListingRepository = defaultDismissedListingRepository;

export function _setDismissedListingRepositoryForTesting(
  repository: DismissedListingRepository | null,
): void {
  dismissedListingRepository = repository ?? defaultDismissedListingRepository;
}
