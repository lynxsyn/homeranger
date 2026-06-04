/**
 * listingsRouter — the M3 read path (router → repository → SPA table).
 *
 * Single `protectedProcedure` surface (one user, no tenant scoping — M3 AC#1):
 *   - list   : filter + sort + cursor-paginated `{ items, nextCursor }`.
 *   - getById: a single listing, NOT_FOUND on miss.
 *   - expand : photo-feature + score-rationale placeholder (null until M5).
 *
 * NO SERVICE LAYER. Doxus routers delegate to a `*.service.ts`, but homeranger's
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
} from "@homeranger/shared";
import type { ListingStatus } from "@prisma/client";
import { protectedProcedure, router } from "../trpc.js";
import { ownerKeyFor } from "../lib/auth/supabase-auth.js";
import {
  listingRepository,
  type ListingFilter,
  type ListingRecord,
  type ListListingsSort,
} from "../repositories/listing.repository.js";
import { photoAnalysisRepository } from "../repositories/photo-analysis.repository.js";
import { listingScoreRepository } from "../repositories/listing-score.repository.js";
import { searchRepository } from "../repositories/search.repository.js";
import { savedListingRepository } from "../repositories/saved-listing.repository.js";
import { dismissedListingRepository } from "../repositories/dismissed-listing.repository.js";
import type { CursorPage } from "../lib/pagination/cursor.js";

/** A single listing row as `getById` returns it. */
export type ListingRow = ListingRecord;

/**
 * A listings-table row: the listing columns plus its `combinedScore` (0..1, or
 * `null` when the listing has not been analysed yet) and the derived `agency`
 * label. The SPA reads this shape via `inferRouterOutputs` — the Match ring
 * renders `combinedScore` and the score sort orders by it.
 *
 * `bathrooms` + `agentEmail` arrive on the underlying `ListingRecord` (Searches
 * PR2 capture); `agency` is COMPUTED here as `agencyName ?? agentEmail ?? null`
 * so the Agent column has one display field and the per-agency follow-up
 * grouping has one key (falling back to the raw sender email, then `null`).
 */
export type ListingListItem = ListingRecord & {
  combinedScore: number | null;
  agency: string | null;
};

/** `list` output: a cursor page of listing rows with their match scores. */
export type ListListingsOutput = CursorPage<ListingListItem>;

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
const listingIdInput = z.object({ listingId: z.string().uuid() });

/**
 * Attach each listing's match score (ONE batch query, no N+1) + the derived
 * `agency` label, turning `ListingRecord`s into `ListingListItem`s. Shared by
 * `list`, `saved`, and `dismissed` so every row carries the Match ring + Agent
 * column data.
 *
 * `searchId` selects WHICH score: set → that search's score per listing (the
 * link-through); absent → MAX(combinedScore) across the operator's searches (the
 * unfiltered table + the saved/dismissed overlays). A listing with no matching
 * score is `null` (the ring renders "–").
 */
async function attachScores(
  items: ListingRecord[],
  searchId?: string,
): Promise<ListingListItem[]> {
  const ids = items.map((item) => item.id);
  const scores = searchId
    ? await listingScoreRepository.getCombinedScoresByListingIdsForSearch(
        ids,
        searchId,
      )
    : await listingScoreRepository.getCombinedScoresByListingIds(ids);
  return items.map((item) => ({
    ...item,
    combinedScore: scores.get(item.id) ?? null,
    agency: item.agencyName ?? item.agentEmail ?? null,
  }));
}

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
    .query(async ({ ctx, input }): Promise<ListListingsOutput> => {
      if (input.searchId) {
        // The per-search lens must be one of the CALLER's own searches — without
        // this an owner could pass a foreign search id and read its per-search
        // scores off the shared catalogue. Owner-scoped; unknown/foreign id →
        // NOT_FOUND (consistent with searchesRouter's contract).
        const ownsSearch = await searchRepository.getById(
          input.searchId,
          ownerKeyFor(ctx.user),
        );
        if (!ownsSearch) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Search not found" });
        }
      }
      const page = await listingRepository.list({
        filter: toRepositoryFilter(input.filter),
        sort: toRepositorySort(input),
        cursor: input.cursor,
        limit: input.limit,
        // Per-search scoring lens: order + display by THIS search's score when the
        // table is reached via a search link-through; else MAX across searches.
        searchId: input.searchId,
      });
      return {
        items: await attachScores(page.items, input.searchId),
        nextCursor: page.nextCursor,
      };
    }),

  /**
   * The signed-in user's saved ("interested") listings, most-recently-saved
   * first, hydrated to full `ListingListItem`s (Match ring + Agent column).
   * Scoped by `ownerKeyFor(ctx.user)` — the SavedListing overlay is per-user;
   * the Listing catalogue itself is shared. The web client also derives the
   * saved-id set from this to seed each row's Interest toggle.
   */
  saved: protectedProcedure.query(
    async ({ ctx }): Promise<ListingListItem[]> => {
      const ownerId = ownerKeyFor(ctx.user);
      const ids = await savedListingRepository.listSavedListingIds(ownerId);
      const rows = await listingRepository.getByIds(ids);
      // getByIds does not preserve order; re-order to the saved order (newest
      // first) and drop ids whose listing was since deleted.
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((row): row is ListingRecord => row !== undefined);
      return attachScores(ordered);
    },
  ),

  /** Save (bookmark) a listing for the signed-in user. Idempotent. */
  save: protectedProcedure
    .input(listingIdInput)
    .mutation(async ({ ctx, input }): Promise<{ saved: true }> => {
      await savedListingRepository.save(ownerKeyFor(ctx.user), input.listingId);
      return { saved: true };
    }),

  /** Unsave a listing for the signed-in user. Idempotent. */
  unsave: protectedProcedure
    .input(listingIdInput)
    .mutation(async ({ ctx, input }): Promise<{ saved: false }> => {
      await savedListingRepository.unsave(
        ownerKeyFor(ctx.user),
        input.listingId,
      );
      return { saved: false };
    }),

  /**
   * The signed-in user's dismissed ("hidden") listings, most-recently-dismissed
   * first, hydrated to full `ListingListItem`s — the same shape as `saved`, for
   * the SPA's "Dismissed" bucket + restore controls. Scoped by
   * `ownerKeyFor(ctx.user)`: the DismissedListing overlay is per-user, the
   * Listing catalogue itself is shared. A home is HIDDEN, never deleted —
   * dismissing tunes the buyer's own feed/scoring and is silent to the agent.
   */
  dismissed: protectedProcedure.query(
    async ({ ctx }): Promise<ListingListItem[]> => {
      const ownerId = ownerKeyFor(ctx.user);
      const ids = await dismissedListingRepository.listDismissedListingIds(
        ownerId,
      );
      const rows = await listingRepository.getByIds(ids);
      // getByIds does not preserve order; re-order to dismissed order (newest
      // first) and drop ids whose listing was since deleted.
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((row): row is ListingRecord => row !== undefined);
      return attachScores(ordered);
    },
  ),

  /** Dismiss (hide) a listing for the signed-in user. Idempotent + reversible. */
  dismiss: protectedProcedure
    .input(listingIdInput)
    .mutation(async ({ ctx, input }): Promise<{ dismissed: true }> => {
      await dismissedListingRepository.dismiss(
        ownerKeyFor(ctx.user),
        input.listingId,
      );
      return { dismissed: true };
    }),

  /** Restore (un-dismiss) a listing for the signed-in user. Idempotent. */
  restore: protectedProcedure
    .input(listingIdInput)
    .mutation(async ({ ctx, input }): Promise<{ dismissed: false }> => {
      await dismissedListingRepository.restore(
        ownerKeyFor(ctx.user),
        input.listingId,
      );
      return { dismissed: false };
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
        // The listing's BEST score across searches (per-search keying); backs the
        // dormant row-expand rationale.
        listingScoreRepository.getBestByListingId(input.id),
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
