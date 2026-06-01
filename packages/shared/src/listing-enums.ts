/**
 * Listing domain enums — single source of truth for the FE/BE/Prisma boundary.
 *
 * Doxus single-sources enums by declaring a `z.enum([...])` over the canonical
 * snake_case value tuple, then deriving the TypeScript string-union via
 * `z.infer` (see `doxus .../packages/shared/src/tutorial-anchors.ts` and the
 * `admin.ts` const-object mirrors). The Prisma schema declares the SAME
 * top-level PascalCase enums with the SAME snake_case values, so the two stay
 * in lockstep by convention. We deliberately do NOT `z.nativeEnum(PrismaEnum)`
 * here because `@homescout/shared` is consumed by `apps/web` (the browser
 * bundle) and MUST stay free of any `@prisma/client` import. Backend code that
 * wants to bridge a Prisma enum to a zod schema uses `z.nativeEnum(...)` in
 * `packages/backend-core` (the `onboarding.router.ts` precedent); the shared
 * package owns the wire-level, framework-free contract.
 *
 * Keep every value tuple below byte-for-byte identical to the matching
 * `enum` block in `apps/api/prisma/schema.prisma`. A drift test in M2
 * (`backend-core`) asserts `Object.values(PrismaEnum)` equals `*Enum.options`.
 */
import { z } from "zod";

// ── Listing lifecycle status ───────────────────────────────────────────
// Mirrors Prisma `enum ListingStatus`. Values per docs/plans/homescout-plan.md.
export const ListingStatusEnum = z.enum([
  "pre_market",
  "live",
  "under_offer",
  "sold",
  "withdrawn",
]);
export type ListingStatus = z.infer<typeof ListingStatusEnum>;
export const LISTING_STATUSES = ListingStatusEnum.options;

// ── Tenure ─────────────────────────────────────────────────────────────
// Mirrors Prisma `enum Tenure`.
export const TenureEnum = z.enum([
  "freehold",
  "leasehold",
  "share_of_freehold",
  "commonhold",
  "unknown",
]);
export type Tenure = z.infer<typeof TenureEnum>;
export const TENURES = TenureEnum.options;

// ── Property type ──────────────────────────────────────────────────────
// Mirrors Prisma `enum PropertyType`.
export const PropertyTypeEnum = z.enum([
  "detached",
  "semi_detached",
  "terraced",
  "flat",
  "maisonette",
  "bungalow",
  "cottage",
  "land",
  "other",
  "unknown",
]);
export type PropertyType = z.infer<typeof PropertyTypeEnum>;
export const PROPERTY_TYPES = PropertyTypeEnum.options;

// ── EPC rating ─────────────────────────────────────────────────────────
// Mirrors Prisma `enum EpcRating`. UK EPC bands A–G plus `unknown`.
export const EpcRatingEnum = z.enum([
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "unknown",
]);
export type EpcRating = z.infer<typeof EpcRatingEnum>;
export const EPC_RATINGS = EpcRatingEnum.options;

// ── Listing source ─────────────────────────────────────────────────────
// Mirrors Prisma `enum ListingSource` (Listing.primarySource +
// ListingSourceRecord.sourceType). No compliant-API channel — email/manual.
export const ListingSourceEnum = z.enum(["agent_email", "manual"]);
export type ListingSource = z.infer<typeof ListingSourceEnum>;
export const LISTING_SOURCES = ListingSourceEnum.options;

// ── Mailbox type (PECR gate) ───────────────────────────────────────────
// Mirrors Prisma `enum MailboxType`. Only corporate_subscriber is cold-emailable.
export const MailboxTypeEnum = z.enum([
  "corporate_subscriber",
  "individual",
  "unknown",
]);
export type MailboxType = z.infer<typeof MailboxTypeEnum>;
export const MAILBOX_TYPES = MailboxTypeEnum.options;

// ── Email SPF/DKIM verdict ─────────────────────────────────────────────
// Mirrors Prisma `enum EmailAuthVerdict` (Doxus enum shape).
export const EmailAuthVerdictEnum = z.enum([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "unknown",
]);
export type EmailAuthVerdict = z.infer<typeof EmailAuthVerdictEnum>;
export const EMAIL_AUTH_VERDICTS = EmailAuthVerdictEnum.options;

// ── Message direction ──────────────────────────────────────────────────
// Mirrors Prisma `enum MessageDirection`.
export const MessageDirectionEnum = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof MessageDirectionEnum>;
export const MESSAGE_DIRECTIONS = MessageDirectionEnum.options;

// ── Suppression reason ─────────────────────────────────────────────────
// Mirrors Prisma `enum SuppressionReason`.
export const SuppressionReasonEnum = z.enum([
  "unsubscribe",
  "hard_bounce",
  "spam_complaint",
  "manual",
]);
export type SuppressionReason = z.infer<typeof SuppressionReasonEnum>;
export const SUPPRESSION_REASONS = SuppressionReasonEnum.options;

// ── Email event type ───────────────────────────────────────────────────
// Mirrors Prisma `enum EmailEventType` (normalised Resend webhook types).
export const EmailEventTypeEnum = z.enum([
  "delivered",
  "bounced",
  "complained",
  "opened",
  "clicked",
  "deferred",
  "failed",
]);
export type EmailEventType = z.infer<typeof EmailEventTypeEnum>;
export const EMAIL_EVENT_TYPES = EmailEventTypeEnum.options;
