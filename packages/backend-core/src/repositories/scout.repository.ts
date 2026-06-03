/**
 * Scout repository — owns ALL Prisma access for the Scout aggregate (M8). A
 * scout is a saved buyer brief that drives outreach. Mirrors
 * listing.repository.ts: explicit `*_SELECT`, the optional-tx pattern
 * (`const db = tx ?? prisma`), and an exported singleton + test setter.
 *
 * Multi-user owner scoping: EVERY method takes an `ownerId` and confines the
 * query to that owner's namespace (`userId IS NULL` for the operator, `userId =
 * ownerId` otherwise). Ownership is enforced HERE, not just in the router — a
 * read for another owner returns null/[], and a write for another owner throws
 * Prisma P2025 (which the router remaps to NOT_FOUND) so cross-user access is
 * indistinguishable from a missing row.
 *
 * The scout FORM has no outcodes field — `outcodes` are resolved SERVER-SIDE
 * from the free-text `location` (resolveScoutOutcodes) on every create + update,
 * so a brief's targeting always tracks its location. `minBedrooms` /
 * `maxPricePence` / `status` persist as given.
 */
import { Prisma, type ScoutStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { resolveScoutOutcodes } from "../lib/scouts/scout-brief.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

/**
 * The Prisma "record not found" error the router's `scoutNotFound` remaps to a
 * tRPC NOT_FOUND. A scoped write that matches no row (wrong/foreign id) throws
 * this so the contract is identical to the pre-multi-user `update`/`delete`.
 */
function recordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Scout not found for this owner",
    { code: "P2025", clientVersion: Prisma.prismaVersion.client },
  );
}

const SCOUT_SELECT = Prisma.validator<Prisma.ScoutSelect>()({
  id: true,
  name: true,
  location: true,
  outcodes: true,
  types: true,
  condition: true,
  land: true,
  saleMethods: true,
  minBedrooms: true,
  maxPricePence: true,
  keywords: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

export type ScoutRecord = Prisma.ScoutGetPayload<{
  select: typeof SCOUT_SELECT;
}>;

/**
 * Create input — the wire fields minus `outcodes` (resolved here from
 * `location`). `minBedrooms` / `maxPricePence` are nullable; the rest default
 * at the wire boundary, so they always arrive concrete.
 */
export interface CreateScoutInput {
  name: string;
  location: string;
  types: string[];
  condition: string[];
  land: string[];
  saleMethods: string[];
  minBedrooms: number | null;
  maxPricePence: number | null;
  keywords: string;
  status: ScoutStatus;
}

/** Update input — a FULL replace of an existing scout by id. */
export interface UpdateScoutInput extends CreateScoutInput {
  id: string;
}

export class ScoutRepository {
  /** All of `ownerId`'s scouts, most-recently-updated first. */
  async list(ownerId: string | null): Promise<ScoutRecord[]> {
    return prisma.scout.findMany({
      where: { userId: ownerId },
      orderBy: [{ updatedAt: "desc" }],
      select: SCOUT_SELECT,
    });
  }

  /** A single scout, scoped to `ownerId` (null if absent or another owner's). */
  async getById(id: string, ownerId: string | null): Promise<ScoutRecord | null> {
    return prisma.scout.findFirst({
      where: { id, userId: ownerId },
      select: SCOUT_SELECT,
    });
  }

  /**
   * Create a scout for `ownerId`. `outcodes` are derived from `location` here
   * (never supplied by the caller) so a brief's targeting always tracks its
   * location text.
   */
  async create(
    input: CreateScoutInput,
    ownerId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<ScoutRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.scout.create({
      data: {
        userId: ownerId,
        name: input.name,
        location: input.location,
        outcodes: resolveScoutOutcodes(input.location),
        types: input.types,
        condition: input.condition,
        land: input.land,
        saleMethods: input.saleMethods,
        minBedrooms: input.minBedrooms,
        maxPricePence: input.maxPricePence,
        keywords: input.keywords,
        status: input.status,
      },
      select: SCOUT_SELECT,
    });
  }

  /**
   * Full-replace update, scoped to `ownerId`. Re-resolves `outcodes` from the
   * (possibly changed) `location`. A scoped updateMany that matches no row
   * (missing id or a foreign owner) throws P2025 — the router maps it to
   * NOT_FOUND, so a cross-owner write is indistinguishable from a missing row.
   */
  async update(
    input: UpdateScoutInput,
    ownerId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<ScoutRecord> {
    const db: PrismaLike = tx ?? prisma;
    const result = await db.scout.updateMany({
      where: { id: input.id, userId: ownerId },
      data: {
        name: input.name,
        location: input.location,
        outcodes: resolveScoutOutcodes(input.location),
        types: input.types,
        condition: input.condition,
        land: input.land,
        saleMethods: input.saleMethods,
        minBedrooms: input.minBedrooms,
        maxPricePence: input.maxPricePence,
        keywords: input.keywords,
        status: input.status,
      },
    });
    if (result.count === 0) {
      throw recordNotFound();
    }
    // The row is the caller's and was just updated — re-read it for the select.
    return db.scout.findUniqueOrThrow({
      where: { id: input.id },
      select: SCOUT_SELECT,
    });
  }

  /** Delete by id, scoped to `ownerId`. Echoes `{ id }`; P2025 on a miss. */
  async delete(
    id: string,
    ownerId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string }> {
    const db: PrismaLike = tx ?? prisma;
    const result = await db.scout.deleteMany({ where: { id, userId: ownerId } });
    if (result.count === 0) {
      throw recordNotFound();
    }
    return { id };
  }

  /**
   * Toggle a scout's lifecycle status (active ⇄ paused), scoped to `ownerId`.
   * P2025 for an unknown/foreign id (router → NOT_FOUND).
   */
  async setStatus(
    id: string,
    status: ScoutStatus,
    ownerId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<ScoutRecord> {
    const db: PrismaLike = tx ?? prisma;
    const result = await db.scout.updateMany({
      where: { id, userId: ownerId },
      data: { status },
    });
    if (result.count === 0) {
      throw recordNotFound();
    }
    return db.scout.findUniqueOrThrow({ where: { id }, select: SCOUT_SELECT });
  }
}

const defaultScoutRepository = new ScoutRepository();

export let scoutRepository = defaultScoutRepository;

export function _setScoutRepositoryForTesting(
  repository: ScoutRepository | null,
): void {
  scoutRepository = repository ?? defaultScoutRepository;
}
