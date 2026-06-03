/**
 * SavedListing repository — owns ALL Prisma access for the per-user "saved"
 * (interested) overlay on the global Listing catalogue. Mirrors the other
 * repositories: explicit owner scoping, optional-tx, exported singleton + test
 * setter. Coverage-excluded (Prisma I/O) like the sibling repos — exercised by
 * the saved-listing integration test, not the unit project.
 *
 * Owner key follows the Scout/SearchProfile convention: `ownerId == null` is the
 * operator namespace, a set `ownerId` is that user's namespace. Uniqueness of
 * (owner, listing) is enforced by the COALESCE expression index from migration
 * 0008, so `save` is idempotent (a duplicate raises P2002 → swallowed).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

export class SavedListingRepository {
  /**
   * Save (bookmark) a listing for `ownerId`. Idempotent: a second save of the
   * same (owner, listing) is a no-op (the unique index raises P2002, swallowed)
   * rather than an error. Returns true when a new row was created.
   */
  async save(
    ownerId: string | null,
    listingId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const db: PrismaLike = tx ?? prisma;
    try {
      await db.savedListing.create({ data: { userId: ownerId, listingId } });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return false; // already saved → idempotent no-op
      }
      throw error;
    }
  }

  /** Unsave a listing for `ownerId`. Idempotent (no row → no-op). */
  async unsave(
    ownerId: string | null,
    listingId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const db: PrismaLike = tx ?? prisma;
    const result = await db.savedListing.deleteMany({
      where: { userId: ownerId, listingId },
    });
    return result.count > 0;
  }

  /**
   * The listing ids `ownerId` has saved, most-recently-saved first. The router
   * hydrates these into full listing rows via listingRepository.getByIds.
   */
  async listSavedListingIds(ownerId: string | null): Promise<string[]> {
    const rows = await prisma.savedListing.findMany({
      where: { userId: ownerId },
      orderBy: [{ createdAt: "desc" }],
      select: { listingId: true },
    });
    return rows.map((row) => row.listingId);
  }
}

const defaultSavedListingRepository = new SavedListingRepository();

export let savedListingRepository = defaultSavedListingRepository;

export function _setSavedListingRepositoryForTesting(
  repository: SavedListingRepository | null,
): void {
  savedListingRepository = repository ?? defaultSavedListingRepository;
}
