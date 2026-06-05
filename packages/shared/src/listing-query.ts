/**
 * Listing list/filter/sort input contract shared FE/BE.
 *
 * Drives `listingsRouter.list` (M3 AC#1): filter by outcode/maxPrice/minBeds/
 * status, sort by `combinedScore` | `price` | `lastSeenAt`, cursor-paginated
 * `{ items, nextCursor }` (default 20 / max 100). Filters are applied IN THE
 * REPOSITORY (M3 AC#2), never in memory — this schema only validates the wire
 * input. The repository's `vectorTopK` pre-filter (M2 AC#5) reuses the same
 * `outcodes` / `maxPricePence` / `minBedrooms` fields, so this is the single
 * structured-filter contract for both the table read path and KNN ranking.
 */
import { z } from "zod";
import { ListingSourceEnum, ListingStatusEnum } from "./listing-enums.js";
import { paginationInputSchema } from "./pagination.js";
import { UK_OUTCODE_REGEX } from "./uk.js";

/** A single outward-code filter token, normalised to upper-case on parse. */
export const outcodeSchema = z
  .string()
  .trim()
  .regex(UK_OUTCODE_REGEX, { message: "Invalid UK outcode" })
  .transform((v) => v.toUpperCase());

/** Sort key for the listings table. `combinedScore` is the AI match score. */
export const listingSortFieldSchema = z.enum([
  "combinedScore",
  "price",
  "lastSeenAt",
]);
export type ListingSortField = z.infer<typeof listingSortFieldSchema>;
export const LISTING_SORT_FIELDS = listingSortFieldSchema.options;

/** Sort direction; defaults to descending (best match / newest / highest). */
export const sortDirectionSchema = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/**
 * Structured listing filter. Every field is optional — an empty object means
 * "no filter". Prices are integer pence (`aide/rules/backend.md`: never
 * floating point). `outcodes` is an array so the UI can multi-select.
 */
export const listingFilterSchema = z
  .object({
    outcodes: z.array(outcodeSchema).max(50).optional(),
    maxPricePence: z.number().int().nonnegative().optional(),
    minBedrooms: z.number().int().min(0).max(50).optional(),
    status: ListingStatusEnum.optional(),
    // Single scrape source (the Sources drill-in passes exactly one); the repo
    // maps it scalar→IN-list so a future multi-select is a one-line change.
    source: ListingSourceEnum.optional(),
  })
  .strict();
export type ListingFilter = z.infer<typeof listingFilterSchema>;

/**
 * Full `listingsRouter.list` input: filter + sort + pagination. The schema is
 * flattened (filter/sort/pagination merged) to match how Doxus router inputs
 * read in `scheduled-report.schema.ts` (`listRunsInputSchema` inlines cursor +
 * limit alongside the domain fields).
 */
export const listListingsInputSchema = z
  .object({
    filter: listingFilterSchema.optional(),
    sortBy: listingSortFieldSchema.default("combinedScore"),
    sortDir: sortDirectionSchema.default("desc"),
    // Per-search scoring LENS (not a row filter): when the listings table is
    // reached via a search's "View homes found" link-through, this is that
    // search's id, so the Match ring + combinedScore sort reflect THAT search's
    // taste. Absent => MAX(combinedScore) across the operator's searches.
    searchId: z.uuid().optional(),
  })
  .extend(paginationInputSchema.shape)
  .strict();
export type ListListingsInput = z.infer<typeof listListingsInputSchema>;
