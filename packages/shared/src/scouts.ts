/**
 * Scout input contracts shared FE/BE (M8). A scout is a saved buyer brief that
 * drives off-market outreach: the option fields hold the design's DISPLAY
 * LABELS verbatim (validated against the closed sets in `./scout-enums.js`) and
 * feed straight into the drafted email. Prices are integer pence
 * (`aide/rules/backend.md`: never floating point).
 *
 * NOTE: there is NO `outcodes` field on the wire — outcodes are resolved
 * SERVER-SIDE from `location` (Stream B's `resolveScoutOutcodes`). The client
 * only ever supplies the free-text location.
 *
 * Mirrors the `.strict()` style of `./preferences.ts` + `./listing-query.ts`.
 * Uses top-level `z.uuid()` (zod 4 — `z.string().uuid()` is deprecated here).
 */
import { z } from "zod";
import {
  ScoutConditionEnum,
  ScoutLandOptionEnum,
  ScoutPropertyTypeEnum,
  ScoutSaleMethodEnum,
  ScoutStatusEnum,
} from "./scout-enums.js";

/**
 * Create a scout. `location` is free text (outcodes are resolved server-side);
 * the option arrays carry display labels and default empty except
 * `saleMethods` which defaults to `["Private treaty"]`. `status` defaults to
 * `"active"`. Prices are integer pence and nullable (omit / null = no cap).
 */
export const scoutCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200).default(""),
    types: z.array(ScoutPropertyTypeEnum).max(20).default([]),
    condition: z.array(ScoutConditionEnum).max(10).default([]),
    land: z.array(ScoutLandOptionEnum).max(10).default([]),
    saleMethods: z
      .array(ScoutSaleMethodEnum)
      .max(10)
      .default(["Private treaty"]),
    minBedrooms: z.number().int().min(0).max(50).nullable().optional(),
    maxPricePence: z.number().int().nonnegative().nullable().optional(),
    keywords: z.string().max(2000).default(""),
    status: ScoutStatusEnum.default("active"),
  })
  .strict();
export type ScoutCreateInput = z.infer<typeof scoutCreateInputSchema>;

/**
 * Full-replace update: the same fields as create plus the row `id`. The router
 * overwrites every column (no partial patch), so all defaults apply identically
 * and `outcodes` are re-resolved from the (possibly changed) `location`.
 */
export const scoutUpdateInputSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200).default(""),
    types: z.array(ScoutPropertyTypeEnum).max(20).default([]),
    condition: z.array(ScoutConditionEnum).max(10).default([]),
    land: z.array(ScoutLandOptionEnum).max(10).default([]),
    saleMethods: z
      .array(ScoutSaleMethodEnum)
      .max(10)
      .default(["Private treaty"]),
    minBedrooms: z.number().int().min(0).max(50).nullable().optional(),
    maxPricePence: z.number().int().nonnegative().nullable().optional(),
    keywords: z.string().max(2000).default(""),
    status: ScoutStatusEnum.default("active"),
  })
  .strict();
export type ScoutUpdateInput = z.infer<typeof scoutUpdateInputSchema>;

/** Pause/resume a scout without touching its brief. */
export const scoutSetStatusInputSchema = z
  .object({
    id: z.uuid(),
    status: ScoutStatusEnum,
  })
  .strict();
export type ScoutSetStatusInput = z.infer<typeof scoutSetStatusInputSchema>;

/** Address a single scout by id (getById / delete). */
export const scoutByIdInputSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();
export type ScoutByIdInput = z.infer<typeof scoutByIdInputSchema>;
