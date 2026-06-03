/**
 * Enum drift guard (M2 LOCKED decision #3): the shared zod enums in
 * `@homeranger/shared` and the generated Prisma enums in `@prisma/client` cannot
 * physically import each other (shared is browser-bundled, free of Prisma), so
 * this unit test is the single-source-of-truth enforcement. It asserts that
 * `Object.values(PrismaEnum)` deep-equals the shared `z.enum(...).options` for
 * every domain enum. If a value or its ORDER drifts, this test fails — that is
 * the contract that keeps schema.prisma and listing-enums.ts in lockstep.
 */
import { describe, expect, it } from "vitest";
import {
  EmailAuthVerdict,
  EmailEventType,
  EpcRating,
  ListingSource,
  ListingStatus,
  MailboxType,
  MessageDirection,
  PropertyType,
  ScoutStatus,
  SuppressionReason,
  Tenure,
} from "@prisma/client";
import {
  EmailAuthVerdictEnum,
  EmailEventTypeEnum,
  EpcRatingEnum,
  ListingSourceEnum,
  ListingStatusEnum,
  MailboxTypeEnum,
  MessageDirectionEnum,
  PropertyTypeEnum,
  ScoutStatusEnum,
  SuppressionReasonEnum,
  TenureEnum,
} from "@homeranger/shared";

describe("Prisma <-> shared enum drift", () => {
  it.each([
    ["ListingStatus", ListingStatus, ListingStatusEnum.options],
    ["Tenure", Tenure, TenureEnum.options],
    ["PropertyType", PropertyType, PropertyTypeEnum.options],
    ["EpcRating", EpcRating, EpcRatingEnum.options],
    ["ListingSource", ListingSource, ListingSourceEnum.options],
    ["MailboxType", MailboxType, MailboxTypeEnum.options],
    ["EmailAuthVerdict", EmailAuthVerdict, EmailAuthVerdictEnum.options],
    ["MessageDirection", MessageDirection, MessageDirectionEnum.options],
    ["SuppressionReason", SuppressionReason, SuppressionReasonEnum.options],
    ["EmailEventType", EmailEventType, EmailEventTypeEnum.options],
    ["ScoutStatus", ScoutStatus, ScoutStatusEnum.options],
  ])("%s values match exactly", (_name, prismaEnum, sharedOptions) => {
    expect(Object.values(prismaEnum as Record<string, string>)).toEqual(
      sharedOptions,
    );
  });
});
