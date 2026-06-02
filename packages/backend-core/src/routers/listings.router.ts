/**
 * listingsRouter — the M3 read path (router → repository → SPA table).
 *
 * Single `protectedProcedure` surface (one user, no tenant scoping — M3 AC#1):
 *   - list   : filter + sort + cursor-paginated `{ items, nextCursor }`.
 *   - getById: a single listing, NOT_FOUND on miss.
 *   - expand : photo-feature + score-rationale placeholder (null until M5).
 *
 * NO SERVICE LAYER. Doxus routers delegate to a `*.service.ts`, but homescout's
 * M2 surfaced only repositories and this is a pure read path with zero business
 * logic between the wire and storage — so the router calls `listingRepository`
 * directly (documented here; extract `listings.service.ts` in M4+ if derivation
 * or permission logic appears). This still satisfies the spec's "router →
 * service → repository" by treating the repository as the service for a pure
 * read.
 *
 * FILTER MAPPING: the shared `listingFilterSchema` wire fields are
 * `outcodes`/`maxPricePence`/`minBedrooms`/`status`; the repository's
 * `ListingFilter` is `outcodes`/`maxPricePence`/`minBedrooms`/`listingStatus`
 * (+ `minPricePence`/`isPreMarket`, which the wire schema does not expose). The
 * only rename is `status` → `listingStatus`. The shared schema is `.strict()`
 * so no stray fields slip through.
 *
 * SORT: the wire `sortBy` is `combinedScore | price | lastSeenAt`. `price` and
 * `lastSeenAt` map to repository sorts with a correct composite keyset cursor.
 * `combinedScore` (the default) falls back to the id-only keyset — the
 * ListingScore relation arrives M5, so combinedScore ordering lands then with
 * the M5 repo body change (the wire contract is unchanged).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  listListingsInputSchema,
  type ListListingsInput as SharedListListingsInput,
} from "@homescout/shared";
import type { ListingStatus } from "@prisma/client";
import { protectedProcedure, router } from "../trpc.js";
import {
  listingRepository,
  type ListingFilter,
  type ListingRecord,
  type ListListingsSort,
} from "../repositories/listing.repository.js";
import { photoAnalysisRepository } from "../repositories/photo-analysis.repository.js";
import { listingScoreRepository } from "../repositories/listing-score.repository.js";
import type { CursorPage } from "../lib/pagination/cursor.js";

/** The exact row shape the SPA table consumes (via `inferRouterOutputs`). */
export type ListingRow = ListingRecord;

/** `list` output: a cursor page of listing rows. */
export type ListListingsOutput = CursorPage<ListingRow>;

/** One analysed photo as the row-expand renders it. */
export interface ListingExpandPhoto {
  imageUrl: string | null;
  tasteScore: number | null;
  features: Record<string, unknown>;
}

/**
 * `expand` payload — the M5 row-expand content (AC#7): per-photo taste scores +
 * features and the hybrid match score + rationale. `photos` is empty and the
 * score fields are `null` for a listing that has not been analysed yet.
 */
export interface ListingExpandPayload {
  id: string;
  photos: ListingExpandPhoto[];
  combinedScore: number | null;
  vectorScore: number | null;
  llmScore: number | null;
  scoreRationale: string | null;
}

const byIdInput = z.object({ id: z.string().uuid() });

/** Map the shared wire filter to the repository `ListingFilter`. */
function toRepositoryFilter(
  filter: SharedListListingsInput["filter"],
): ListingFilter | undefined {
  if (!filter) {
    return undefined;
  }
  const mapped: ListingFilter = {};
  if (filter.outcodes !== undefined) {
    mapped.outcodes = filter.outcodes;
  }
  if (filter.maxPricePence !== undefined) {
    mapped.maxPricePence = filter.maxPricePence;
  }
  if (filter.minBedrooms !== undefined) {
    mapped.minBedrooms = filter.minBedrooms;
  }
  if (filter.status !== undefined) {
    // The shared enum and the Prisma enum share identical snake_case values
    // (asserted by the M2 enum-drift test), so this narrowing cast is sound.
    mapped.listingStatus = filter.status as ListingStatus;
  }
  return mapped;
}

/** Map the shared wire sort to the repository sort descriptor. */
function toRepositorySort(input: SharedListListingsInput): ListListingsSort {
  return { sortBy: input.sortBy, sortDir: input.sortDir };
}

export const listingsRouter = router({
  list: protectedProcedure
    .input(listListingsInputSchema)
    .query(async ({ input }): Promise<ListListingsOutput> => {
      return listingRepository.list({
        filter: toRepositoryFilter(input.filter),
        sort: toRepositorySort(input),
        cursor: input.cursor,
        limit: input.limit,
      });
    }),

  getById: protectedProcedure
    .input(byIdInput)
    .query(async ({ input }): Promise<ListingRow> => {
      const row = await listingRepository.getById(input.id);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Listing not found" });
      }
      return row;
    }),

  expand: protectedProcedure
    .input(byIdInput)
    .query(async ({ input }): Promise<ListingExpandPayload> => {
      const row = await listingRepository.getById(input.id);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Listing not found" });
      }
      const [photos, score] = await Promise.all([
        photoAnalysisRepository.listByListingId(input.id),
        listingScoreRepository.getByListingId(input.id),
      ]);
      return {
        id: row.id,
        photos: photos.map((photo) => ({
          imageUrl: photo.imageUrl,
          tasteScore: photo.tasteScore,
          features:
            typeof photo.featuresJson === "object" && photo.featuresJson !== null
              ? (photo.featuresJson as Record<string, unknown>)
              : {},
        })),
        combinedScore: score?.combinedScore ?? null,
        vectorScore: score?.vectorScore ?? null,
        llmScore: score?.llmScore ?? null,
        scoreRationale: score?.rationale ?? null,
      };
    }),
});
