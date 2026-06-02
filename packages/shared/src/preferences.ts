/**
 * SearchProfile update contract shared FE/BE (M5). Drives
 * `preferencesRouter.update` and the PreferencesPage form. Single-user product →
 * one profile, so this is a partial update of that single row. Every field is
 * optional (omit = leave unchanged); nullable fields accept `null` to clear.
 * Prices are integer pence (aide/rules/backend.md: never floating point).
 */
import { z } from "zod";
import { TenureEnum } from "./listing-enums.js";
import { outcodeSchema } from "./listing-query.js";

export const searchProfileUpdateSchema = z
  .object({
    freeTextPreferences: z.string().max(2000).optional(),
    minBedrooms: z.number().int().min(0).max(50).nullable().optional(),
    maxPricePence: z.number().int().nonnegative().nullable().optional(),
    outcodes: z.array(outcodeSchema).max(50).optional(),
    requiredTenure: TenureEnum.nullable().optional(),
  })
  .strict();
export type SearchProfileUpdate = z.infer<typeof searchProfileUpdateSchema>;
