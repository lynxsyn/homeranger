/**
 * scoutsRouter — the M8 scout (saved buyer brief) CRUD surface.
 *
 * Single `protectedProcedure` surface (one user, no tenant scoping):
 *   - list     : all scouts, most-recently-updated first.
 *   - getById  : a single scout, NOT_FOUND on miss.
 *   - create   : a new scout (outcodes resolved server-side from location).
 *   - update   : full-replace an existing scout, NOT_FOUND on miss.
 *   - delete   : remove a scout, echoes `{ id }`.
 *   - setStatus: toggle active ⇄ paused.
 *
 * NO SERVICE LAYER — like listingsRouter, this is a pure CRUD path with no
 * business logic between the wire and storage (the only derivation, outcode
 * resolution, lives in the repository). The router calls `scoutRepository`
 * directly. The shared input schemas are `.strict()`, so no stray field slips
 * through; the repository derives `outcodes` from `location` (the form has no
 * outcodes field).
 *
 * Every returned row is a full `ScoutRecord` carrying all DB columns, so the SPA
 * infers the scout shape via `inferRouterOutputs`.
 *
 * NOT_FOUND mapping: getById + update map a missing row to NOT_FOUND (update
 * pre-checks via getById so the unit test stays simple); delete + setStatus go
 * straight to the repo, so they catch Prisma P2025 ("record not found") and
 * remap it to NOT_FOUND — a consistent 404 contract across all sibling
 * procedures instead of a raw 500 when a row was removed in another session.
 */
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import {
  scoutByIdInputSchema,
  scoutCreateInputSchema,
  scoutSetStatusInputSchema,
  scoutUpdateInputSchema,
} from "@homescout/shared";
import { protectedProcedure, router } from "../trpc.js";
import {
  scoutRepository,
  type ScoutRecord,
} from "../repositories/scout.repository.js";

/** A single scout row as the procedures return it. */
export type ScoutRow = ScoutRecord;

/** Remap Prisma's "record not found" (P2025) to a tRPC NOT_FOUND; rethrow else. */
function scoutNotFound(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
  }
  throw error;
}

export const scoutsRouter = router({
  list: protectedProcedure.query(async (): Promise<ScoutRow[]> => {
    return scoutRepository.list();
  }),

  getById: protectedProcedure
    .input(scoutByIdInputSchema)
    .query(async ({ input }): Promise<ScoutRow> => {
      const row = await scoutRepository.getById(input.id);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
      }
      return row;
    }),

  create: protectedProcedure
    .input(scoutCreateInputSchema)
    .mutation(async ({ input }): Promise<ScoutRow> => {
      return scoutRepository.create({
        name: input.name,
        location: input.location,
        types: input.types,
        condition: input.condition,
        land: input.land,
        saleMethods: input.saleMethods,
        minBedrooms: input.minBedrooms ?? null,
        maxPricePence: input.maxPricePence ?? null,
        keywords: input.keywords,
        status: input.status,
      });
    }),

  update: protectedProcedure
    .input(scoutUpdateInputSchema)
    .mutation(async ({ input }): Promise<ScoutRow> => {
      // Pre-check existence so a missing id maps to NOT_FOUND (rather than a
      // raw Prisma P2025 surfacing as INTERNAL_SERVER_ERROR).
      const existing = await scoutRepository.getById(input.id);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
      }
      return scoutRepository.update({
        id: input.id,
        name: input.name,
        location: input.location,
        types: input.types,
        condition: input.condition,
        land: input.land,
        saleMethods: input.saleMethods,
        minBedrooms: input.minBedrooms ?? null,
        maxPricePence: input.maxPricePence ?? null,
        keywords: input.keywords,
        status: input.status,
      });
    }),

  delete: protectedProcedure
    .input(scoutByIdInputSchema)
    .mutation(async ({ input }): Promise<{ id: string }> => {
      try {
        return await scoutRepository.delete(input.id);
      } catch (error) {
        return scoutNotFound(error);
      }
    }),

  setStatus: protectedProcedure
    .input(scoutSetStatusInputSchema)
    .mutation(async ({ input }): Promise<ScoutRow> => {
      try {
        return await scoutRepository.setStatus(input.id, input.status);
      } catch (error) {
        return scoutNotFound(error);
      }
    }),
});
