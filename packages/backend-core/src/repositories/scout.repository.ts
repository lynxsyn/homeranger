/**
 * Scout repository — owns ALL Prisma access for the Scout aggregate (M8). A
 * scout is a saved buyer brief that drives outreach; single-user, no tenant
 * scoping. Mirrors listing.repository.ts: explicit `*_SELECT`, the optional-tx
 * pattern (`const db = tx ?? prisma`), and an exported singleton + test setter.
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
  /** All scouts, most-recently-updated first (drives the scouts list). */
  async list(): Promise<ScoutRecord[]> {
    return prisma.scout.findMany({
      orderBy: [{ updatedAt: "desc" }],
      select: SCOUT_SELECT,
    });
  }

  async getById(id: string): Promise<ScoutRecord | null> {
    return prisma.scout.findUnique({ where: { id }, select: SCOUT_SELECT });
  }

  /**
   * Create a scout. `outcodes` are derived from `location` here (never supplied
   * by the caller) so a brief's targeting always tracks its location text.
   */
  async create(
    input: CreateScoutInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ScoutRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.scout.create({
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
      select: SCOUT_SELECT,
    });
  }

  /**
   * Full-replace update by id. Re-resolves `outcodes` from the (possibly
   * changed) `location`. Throws Prisma P2025 if the id does not exist — the
   * router maps that to NOT_FOUND.
   */
  async update(
    input: UpdateScoutInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ScoutRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.scout.update({
      where: { id: input.id },
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
      select: SCOUT_SELECT,
    });
  }

  /** Delete by id. Returns the id so the router can echo it back. */
  async delete(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string }> {
    const db: PrismaLike = tx ?? prisma;
    await db.scout.delete({ where: { id }, select: { id: true } });
    return { id };
  }

  /**
   * Toggle a scout's lifecycle status (active ⇄ paused). Throws Prisma P2025
   * for an unknown id (router → NOT_FOUND).
   */
  async setStatus(
    id: string,
    status: ScoutStatus,
    tx?: Prisma.TransactionClient,
  ): Promise<ScoutRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.scout.update({
      where: { id },
      data: { status },
      select: SCOUT_SELECT,
    });
  }
}

const defaultScoutRepository = new ScoutRepository();

export let scoutRepository = defaultScoutRepository;

export function _setScoutRepositoryForTesting(
  repository: ScoutRepository | null,
): void {
  scoutRepository = repository ?? defaultScoutRepository;
}
