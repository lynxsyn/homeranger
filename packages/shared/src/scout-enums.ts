/**
 * Scout domain enums + option sets (M8). A scout's string-array option fields
 * (types / condition / land / saleMethods) hold the design's DISPLAY LABELS
 * verbatim — the label IS the stored value, fed straight into the outreach
 * email draft. They're validated against these closed sets at the wire boundary
 * but stored as `text[]` (not Prisma enums), because they are scaffolding for
 * the first email, not rigid filters.
 *
 * Only `ScoutStatus` is a Prisma enum (drift-tested against schema.prisma); the
 * rest are app-level option lists with no DB enum.
 */
import { z } from "zod";

// ── Scout lifecycle ─────────────────────────────────────────────────────
// Mirrors Prisma `enum ScoutStatus`. active ⇄ paused (no terminal state).
export const ScoutStatusEnum = z.enum(["active", "paused"]);
export type ScoutStatus = z.infer<typeof ScoutStatusEnum>;
export const SCOUT_STATUSES = ScoutStatusEnum.options;

// ── Property types a scout briefs for ───────────────────────────────────
// Broader than the listing `PropertyType` enum: adds Cottage/Farmhouse/Barn/
// Land for restoration + plot buying. Display labels (drive the email draft).
export const ScoutPropertyTypeEnum = z.enum([
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
export type ScoutPropertyType = z.infer<typeof ScoutPropertyTypeEnum>;
export const SCOUT_PROPERTY_TYPES = ScoutPropertyTypeEnum.options;

// ── Condition / project appetite ────────────────────────────────────────
export const ScoutConditionEnum = z.enum([
  "Move-in ready",
  "Some updating",
  "Full renovation",
  "Restoration project",
]);
export type ScoutCondition = z.infer<typeof ScoutConditionEnum>;
export const SCOUT_CONDITIONS = ScoutConditionEnum.options;

// ── Land & development rules (only on these terms) ──────────────────────
export const ScoutLandOptionEnum = z.enum([
  "Land with a building to convert",
  "Buildable land or planning potential",
]);
export type ScoutLandOption = z.infer<typeof ScoutLandOptionEnum>;
export const SCOUT_LAND_OPTIONS = ScoutLandOptionEnum.options;

// ── Sale method ─────────────────────────────────────────────────────────
export const ScoutSaleMethodEnum = z.enum(["Private treaty", "Auction"]);
export type ScoutSaleMethod = z.infer<typeof ScoutSaleMethodEnum>;
export const SCOUT_SALE_METHODS = ScoutSaleMethodEnum.options;
