/**
 * Search domain enums + option sets (M8). A search's string-array option fields
 * (types / condition / land / saleMethods) hold the design's DISPLAY LABELS
 * verbatim — the label IS the stored value, fed straight into the outreach
 * email draft. They're validated against these closed sets at the wire boundary
 * but stored as `text[]` (not Prisma enums), because they are scaffolding for
 * the first email, not rigid filters.
 *
 * Only `SearchStatus` is a Prisma enum (drift-tested against schema.prisma); the
 * rest are app-level option lists with no DB enum.
 */
import { z } from "zod";

// ── Search lifecycle ─────────────────────────────────────────────────────
// Mirrors Prisma `enum SearchStatus`. active ⇄ paused (no terminal state).
export const SearchStatusEnum = z.enum(["active", "paused"]);
export type SearchStatus = z.infer<typeof SearchStatusEnum>;
export const SEARCH_STATUSES = SearchStatusEnum.options;

// ── Property types a search briefs for ───────────────────────────────────
// Broader than the listing `PropertyType` enum: adds Cottage/Farmhouse/Barn/
// Land for restoration + plot buying. Display labels (drive the email draft).
export const SearchPropertyTypeEnum = z.enum([
  "Detached",
  "Semi-detached",
  "Terraced",
  "Flat",
  "Maisonette",
  "Bungalow",
  "Cottage",
  "Farmhouse",
  "Barn",
  "Land",
]);
export type SearchPropertyType = z.infer<typeof SearchPropertyTypeEnum>;
export const SEARCH_PROPERTY_TYPES = SearchPropertyTypeEnum.options;

// ── Condition / project appetite ────────────────────────────────────────
export const SearchConditionEnum = z.enum([
  "Move-in ready",
  "Some updating",
  "Full renovation",
  "Restoration project",
]);
export type SearchCondition = z.infer<typeof SearchConditionEnum>;
export const SEARCH_CONDITIONS = SearchConditionEnum.options;

// ── Land & development rules (only on these terms) ──────────────────────
export const SearchLandOptionEnum = z.enum([
  "Land with a building to convert",
  "Buildable land or planning potential",
]);
export type SearchLandOption = z.infer<typeof SearchLandOptionEnum>;
export const SEARCH_LAND_OPTIONS = SearchLandOptionEnum.options;

// ── Sale method ─────────────────────────────────────────────────────────
export const SearchSaleMethodEnum = z.enum(["Private treaty", "Auction"]);
export type SearchSaleMethod = z.infer<typeof SearchSaleMethodEnum>;
export const SEARCH_SALE_METHODS = SearchSaleMethodEnum.options;
