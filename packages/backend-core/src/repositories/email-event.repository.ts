/**
 * EmailEvent repository — owns ALL Prisma access for the provider
 * delivery/bounce/complaint feed. M2 authored the `EmailEvent` MODEL but NOT a
 * repository for it; M4 needs one because the events path persists rows and the
 * `@@unique(providerEventId)` makes a redelivered Resend webhook idempotent.
 *
 * Mirrors the homeranger repository conventions exactly
 * (listing-source-record.repository.ts + outreach.repository.ts):
 *   - `Prisma.validator<...Select>()` projection + `GetPayload` row type
 *   - optional-tx via `const db = tx ?? prisma`
 *   - createMany({ skipDuplicates }) + findUnique read-back for the idempotent
 *     insert (the outreach.repository.ts `createInboundMessageOrIgnore` idiom)
 *   - bottom singleton + `_set…ForTesting` mutable export
 */
import { Prisma, type EmailEventType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const EMAIL_EVENT_SELECT = Prisma.validator<Prisma.EmailEventSelect>()({
  id: true,
  providerEventId: true,
  messageId: true,
  email: true,
  eventType: true,
  payload: true,
  occurredAt: true,
  createdAt: true,
});

export type EmailEventRecord = Prisma.EmailEventGetPayload<{
  select: typeof EMAIL_EVENT_SELECT;
}>;

/** Idempotent insert input keyed on the unique `providerEventId`. */
export interface RecordEmailEventInput {
  providerEventId: string;
  messageId: string | null;
  email: string;
  eventType: EmailEventType;
  payload?: Prisma.InputJsonValue;
  occurredAt: Date;
}

export interface RecordEmailEventResult {
  event: EmailEventRecord;
  /** false when this providerEventId was already stored (redelivery no-op). */
  created: boolean;
}

export class EmailEventRepository {
  /**
   * Insert an event, ignoring redeliveries. The DB unique on `providerEventId`
   * makes this idempotent: `createMany` + `skipDuplicates` inserts 0 rows on a
   * repeat, then we read the existing row back. `created` tells the caller
   * whether this was the first delivery (so suppression only mutates once).
   */
  async recordOrIgnore(
    input: RecordEmailEventInput,
    tx?: Prisma.TransactionClient,
  ): Promise<RecordEmailEventResult> {
    const db: PrismaLike = tx ?? prisma;
    const { count } = await db.emailEvent.createMany({
      data: [
        {
          providerEventId: input.providerEventId,
          messageId: input.messageId,
          email: input.email,
          eventType: input.eventType,
          ...(input.payload !== undefined ? { payload: input.payload } : {}),
          occurredAt: input.occurredAt,
        },
      ],
      skipDuplicates: true,
    });
    const event = await db.emailEvent.findUnique({
      where: { providerEventId: input.providerEventId },
      select: EMAIL_EVENT_SELECT,
    });
    if (!event) {
      throw new Error(
        `EmailEvent not found after recordOrIgnore for ${input.providerEventId}`,
      );
    }
    return { event, created: count > 0 };
  }

  async findByProviderEventId(
    providerEventId: string,
  ): Promise<EmailEventRecord | null> {
    return prisma.emailEvent.findUnique({
      where: { providerEventId },
      select: EMAIL_EVENT_SELECT,
    });
  }

  /**
   * Count events of one type since a cutoff — the NUMERATOR for the M6
   * circuit-breaker (gate 6). Uses the `[eventType, occurredAt DESC]` index.
   * The DENOMINATOR (attempted sends in the window) comes from
   * OutreachRepository.countOutboundSince, NOT from here.
   */
  async countByTypeSince(
    eventType: EmailEventType,
    since: Date,
  ): Promise<number> {
    return prisma.emailEvent.count({
      where: { eventType, occurredAt: { gte: since } },
    });
  }

  /**
   * Erase every delivery/bounce/complaint event for the given email addresses —
   * the GDPR-erasure leg for a removed agent. EmailEvent is keyed by the email
   * STRING (no FK to Agent), so deleting the Agent does NOT cascade these rows,
   * yet each carries the recipient's address + a full webhook `payload` snapshot.
   * Composed into the SAME transaction as the agent delete so the erasure is
   * atomic + complete. Emails are matched lower-cased (both Agent.email and
   * EmailEvent.email are stored normalised). An empty list is a no-op (0).
   */
  async deleteByEmails(
    emails: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (emails.length === 0) {
      return 0;
    }
    const db: PrismaLike = tx ?? prisma;
    const normalised = emails.map((email) => email.trim().toLowerCase());
    const result = await db.emailEvent.deleteMany({
      where: { email: { in: normalised } },
    });
    return result.count;
  }
}

const defaultEmailEventRepository = new EmailEventRepository();

export let emailEventRepository = defaultEmailEventRepository;

export function _setEmailEventRepositoryForTesting(
  repository: EmailEventRepository | null,
): void {
  emailEventRepository = repository ?? defaultEmailEventRepository;
}
