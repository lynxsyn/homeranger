/**
 * Outreach repository — owns all Prisma access for OutreachThread /
 * OutreachMessage. Inbound dedup is enforced by the DB unique on
 * `providerMessageId`; `createInboundMessageOrIgnore` uses the
 * createMany+skipDuplicates+findUnique idiom from Doxus
 * notification.repository.ts so a redelivered webhook is a no-op.
 */
import { Prisma, type EmailAuthVerdict } from "@prisma/client";
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
    _input: CreateThreadInput,
    _tx?: Prisma.TransactionClient,
  ): Promise<OutreachThreadRecord> {
    throw new Error("not implemented");
  }

  async getThreadById(_id: string): Promise<OutreachThreadRecord | null> {
    throw new Error("not implemented");
  }

  async createOutboundMessage(
    _input: CreateOutboundMessageInput,
    _tx?: Prisma.TransactionClient,
  ): Promise<OutreachMessageRecord> {
    throw new Error("not implemented");
  }

  /**
   * Insert an inbound message, ignoring redeliveries. The DB unique on
   * `providerMessageId` makes this idempotent: `createMany` with
   * `skipDuplicates` inserts 0 rows on a repeat, then we read the existing row
   * back. `created` tells the caller whether this was the first delivery.
   */
  async createInboundMessageOrIgnore(
    _input: CreateInboundMessageInput,
    _tx?: Prisma.TransactionClient,
  ): Promise<CreateInboundResult> {
    throw new Error("not implemented");
  }

  async listMessagesByThread(_input: {
    threadId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CursorPage<OutreachMessageRecord>> {
    throw new Error("not implemented");
  }
}

void MESSAGE_SELECT;
void buildMessageCursorFilter;
void clampLimit;
void decodeCursor;
void paginate;

const defaultOutreachRepository = new OutreachRepository();

export let outreachRepository = defaultOutreachRepository;

export function _setOutreachRepositoryForTesting(
  repository: OutreachRepository | null,
): void {
  outreachRepository = repository ?? defaultOutreachRepository;
}
