/**
 * Search input contracts shared FE/BE (M8). A search is a saved buyer brief that
 * drives off-market outreach: the option fields hold the design's DISPLAY
 * LABELS verbatim (validated against the closed sets in `./search-enums.js`) and
 * feed straight into the drafted email. Prices are integer pence
 * (`aide/rules/backend.md`: never floating point).
 *
 * NOTE: there is NO `outcodes` field on the wire — outcodes are resolved
 * SERVER-SIDE from `location` (Stream B's `resolveSearchOutcodes`). The client
 * only ever supplies the free-text location.
 *
 * Mirrors the `.strict()` style of `./preferences.ts` + `./listing-query.ts`.
 * Uses top-level `z.uuid()` (zod 4 — `z.string().uuid()` is deprecated here).
 */
import { z } from "zod";
import {
  SearchConditionEnum,
  SearchLandOptionEnum,
  SearchPropertyTypeEnum,
  SearchSaleMethodEnum,
  SearchStatusEnum,
} from "./search-enums.js";

/**
 * Create a search. `location` is free text (outcodes are resolved server-side);
 * the option arrays carry display labels and default empty except
 * `saleMethods` which defaults to `["Private treaty"]`. `status` defaults to
 * `"active"`. Prices are integer pence and nullable (omit / null = no cap).
 */
export const searchCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200).default(""),
    types: z.array(SearchPropertyTypeEnum).max(20).default([]),
    condition: z.array(SearchConditionEnum).max(10).default([]),
    land: z.array(SearchLandOptionEnum).max(10).default([]),
    saleMethods: z
      .array(SearchSaleMethodEnum)
      .max(10)
      .default(["Private treaty"]),
    minBedrooms: z.number().int().min(0).max(50).nullable().optional(),
    maxPricePence: z.number().int().nonnegative().nullable().optional(),
    keywords: z.string().max(2000).default(""),
    status: SearchStatusEnum.default("active"),
  })
  .strict();
export type SearchCreateInput = z.infer<typeof searchCreateInputSchema>;

/**
 * Full-replace update: the same fields as create plus the row `id`. The router
 * overwrites every column (no partial patch), so all defaults apply identically
 * and `outcodes` are re-resolved from the (possibly changed) `location`.
 */
export const searchUpdateInputSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200).default(""),
    types: z.array(SearchPropertyTypeEnum).max(20).default([]),
    condition: z.array(SearchConditionEnum).max(10).default([]),
    land: z.array(SearchLandOptionEnum).max(10).default([]),
    saleMethods: z
      .array(SearchSaleMethodEnum)
      .max(10)
      .default(["Private treaty"]),
    minBedrooms: z.number().int().min(0).max(50).nullable().optional(),
    maxPricePence: z.number().int().nonnegative().nullable().optional(),
    keywords: z.string().max(2000).default(""),
    status: SearchStatusEnum.default("active"),
  })
  .strict();
export type SearchUpdateInput = z.infer<typeof searchUpdateInputSchema>;

/** Pause/resume a search without touching its brief. */
export const searchSetStatusInputSchema = z
  .object({
    id: z.uuid(),
    status: SearchStatusEnum,
  })
  .strict();
export type SearchSetStatusInput = z.infer<typeof searchSetStatusInputSchema>;

/** Address a single search by id (getById / delete). */
export const searchByIdInputSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();
export type SearchByIdInput = z.infer<typeof searchByIdInputSchema>;

/**
 * Approve outreach sends for a launched search (PR3): the search `id` plus the
 * operator-selected agent ids to contact. `agentIds` is capped at 200 to bound a
 * single approval burst (the warm-up cap still gates the actual send rate). An
 * empty list is allowed (a no-op approval enqueues nothing).
 */
export const searchApproveSendsInputSchema = z
  .object({
    id: z.uuid(),
    agentIds: z.array(z.uuid()).max(200),
  })
  .strict();
export type SearchApproveSendsInput = z.infer<
  typeof searchApproveSendsInputSchema
>;
