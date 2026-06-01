/**
 * Outreach repository — owns all Prisma access for OutreachThread /
 * OutreachMessage. Inbound dedup is enforced by the DB unique on
 * `providerMessageId`; `createInboundMessageOrIgnore` uses the
 * createMany+skipDuplicates+findUnique idiom from Doxus
 * notification.repository.ts so a redelivered webhook is a no-op.
 */
import {
  Prisma,
  type EmailAuthVerdict,
  type MessageDirection,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  clampLimit,
  decodeCursor,
  paginate,
  type CursorPage,
} from "../lib/pagination/cursor.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const THREAD_SELECT = Prisma.validator<Prisma.OutreachThreadSelect>()({
  id: true,
  agentId: true,
  subject: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
});

const MESSAGE_SELECT = Prisma.validator<Prisma.OutreachMessageSelect>()({
  id: true,
  threadId: true,
  direction: true,
  providerMessageId: true,
  fromEmail: true,
  toEmail: true,
  subject: true,
  bodyText: true,
  spfVerdict: true,
  dkimVerdict: true,
  parsedListingIds: true,
  sentAt: true,
  receivedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type OutreachThreadRecord = Prisma.OutreachThreadGetPayload<{
  select: typeof THREAD_SELECT;
}>;
export type OutreachMessageRecord = Prisma.OutreachMessageGetPayload<{
  select: typeof MESSAGE_SELECT;
}>;

export interface CreateThreadInput {
  agentId: string;
  subject: string;
}

export interface CreateOutboundMessageInput {
  threadId: string;
  providerMessageId: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  sentAt: Date;
}

export interface CreateInboundMessageInput {
  threadId: string;
  providerMessageId: string;
  fromEmail: string;
  toEmail: string;
  subject: string | null;
  bodyText: string | null;
  spfVerdict: EmailAuthVerdict;
  dkimVerdict: EmailAuthVerdict;
  parsedListingIds: string[];
  receivedAt: Date;
}

export interface CreateInboundResult {
  message: OutreachMessageRecord;
  created: boolean;
}

function buildMessageCursorFilter(cursor: {
  id: string;
  createdAt: Date;
}): Prisma.OutreachMessageWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

export class OutreachRepository {
  async createThread(
    input: CreateThreadInput,
    tx?: Prisma.TransactionClient,
  ): Promise<OutreachThreadRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.outreachThread.create({
      data: { agentId: input.agentId, subject: input.subject },
      select: THREAD_SELECT,
    });
  }

  async getThreadById(id: string): Promise<OutreachThreadRecord | null> {
    return prisma.outreachThread.findUnique({
      where: { id },
      select: THREAD_SELECT,
    });
  }

  async createOutboundMessage(
    input: CreateOutboundMessageInput,
    tx?: Prisma.TransactionClient,
  ): Promise<OutreachMessageRecord> {
    const db: PrismaLike = tx ?? prisma;
    return db.outreachMessage.create({
      data: {
        threadId: input.threadId,
        direction: "outbound" satisfies MessageDirection,
        providerMessageId: input.providerMessageId,
        fromEmail: input.fromEmail,
        toEmail: input.toEmail,
        subject: input.subject,
        bodyText: input.bodyText,
        parsedListingIds: [],
        sentAt: input.sentAt,
      },
      select: MESSAGE_SELECT,
    });
  }

  /**
   * Insert an inbound message, ignoring redeliveries. The DB unique on
   * `providerMessageId` makes this idempotent: `createMany` with
   * `skipDuplicates` inserts 0 rows on a repeat, then we read the existing row
   * back. `created` tells the caller whether this was the first delivery.
   */
  async createInboundMessageOrIgnore(
    input: CreateInboundMessageInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CreateInboundResult> {
    const db: PrismaLike = tx ?? prisma;
    const { count } = await db.outreachMessage.createMany({
      data: [
        {
          threadId: input.threadId,
          direction: "inbound" satisfies MessageDirection,
          providerMessageId: input.providerMessageId,
          fromEmail: input.fromEmail,
          toEmail: input.toEmail,
          subject: input.subject,
          bodyText: input.bodyText,
          spfVerdict: input.spfVerdict,
          dkimVerdict: input.dkimVerdict,
          parsedListingIds: input.parsedListingIds,
          receivedAt: input.receivedAt,
        },
      ],
      skipDuplicates: true,
    });
    const message = await db.outreachMessage.findUnique({
      where: { providerMessageId: input.providerMessageId },
      select: MESSAGE_SELECT,
    });
    if (!message) {
      throw new Error(
        `OutreachMessage not found after createInboundMessageOrIgnore for ${input.providerMessageId}`,
      );
    }
    return { message, created: count > 0 };
  }

  async listMessagesByThread(input: {
    threadId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CursorPage<OutreachMessageRecord>> {
    const limit = clampLimit(input.limit);
    const cursorFilter = input.cursor
      ? buildMessageCursorFilter(decodeCursor(input.cursor))
      : {};
    const rows = await prisma.outreachMessage.findMany({
      where: { threadId: input.threadId, ...cursorFilter },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: MESSAGE_SELECT,
    });
    return paginate(rows, limit);
  }
}

const defaultOutreachRepository = new OutreachRepository();

export let outreachRepository = defaultOutreachRepository;

export function _setOutreachRepositoryForTesting(
  repository: OutreachRepository | null,
): void {
  outreachRepository = repository ?? defaultOutreachRepository;
}
