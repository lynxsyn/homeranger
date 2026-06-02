/**
 * SuppressionEntry repository — owns ALL Prisma access for the global
 * do-not-contact list. M2 authored the `SuppressionEntry` MODEL but NOT a
 * repository; M4 needs one because hard_bounce / spam_complaint events insert a
 * suppression. The `@@unique([email, reason])` makes the upsert idempotent
 * (re-bouncing the same address is a no-op for row count).
 *
 * Mirrors homescout repository conventions (listing-source-record.repository.ts).
 */
import { Prisma, type SuppressionReason } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

/**
 * Single-point email normalisation for the suppression key. Both the write
 * (suppress) and the read (isSuppressed) normalise here, so casing can NEVER
 * split a suppression — gate 2 (opt-out, normalised by the Agent repo) and gate
 * 3 (suppression) always agree on the key.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const SUPPRESSION_SELECT = Prisma.validator<Prisma.SuppressionEntrySelect>()({
  id: true,
  email: true,
  reason: true,
  note: true,
  createdAt: true,
  updatedAt: true,
});

export type SuppressionEntryRecord = Prisma.SuppressionEntryGetPayload<{
  select: typeof SUPPRESSION_SELECT;
}>;

/** Idempotent upsert input keyed on the composite (email, reason). */
export interface SuppressInput {
  email: string;
  reason: SuppressionReason;
  note?: string | null;
}

export class SuppressionEntryRepository {
  /**
   * Idempotent suppression keyed on `@@unique([email, reason])`. The second
   * suppression of the same (email, reason) UPDATES the note instead of
   * creating a duplicate. Email is lower-cased by the caller (the service
   * normalises before persisting) so casing never splits a suppression.
   */
  async suppress(
    input: SuppressInput,
    tx?: Prisma.TransactionClient,
  ): Promise<SuppressionEntryRecord> {
    const db: PrismaLike = tx ?? prisma;
    const email = normaliseEmail(input.email);
    return db.suppressionEntry.upsert({
      where: {
        email_reason: { email, reason: input.reason },
      },
      create: {
        email,
        reason: input.reason,
        note: input.note ?? null,
      },
      update: {
        note: input.note ?? null,
      },
      select: SUPPRESSION_SELECT,
    });
  }

  async isSuppressed(email: string): Promise<boolean> {
    const hit = await prisma.suppressionEntry.findFirst({
      where: { email: normaliseEmail(email) },
      select: { id: true },
    });
    return hit !== null;
  }
}

const defaultSuppressionEntryRepository = new SuppressionEntryRepository();

export let suppressionEntryRepository = defaultSuppressionEntryRepository;

export function _setSuppressionEntryRepositoryForTesting(
  repository: SuppressionEntryRepository | null,
): void {
  suppressionEntryRepository = repository ?? defaultSuppressionEntryRepository;
}
