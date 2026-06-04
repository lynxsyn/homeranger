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
  type OutreachThreadStatus,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  clampLimit,
  decodeCursor,
  paginate,
  type CursorPage,
} from "../lib/pagination/cursor.js";
import {
  advanceThreadStatus,
  type ThreadEvent,
} from "../lib/outreach/thread-status.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const THREAD_SELECT = Prisma.validator<Prisma.OutreachThreadSelect>()({
  id: true,
  agentId: true,
  subject: true,
  status: true,
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
  bodyHtml: true,
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
  /** Rendered HTML body, persisted alongside bodyText for draft inspection. */
  bodyHtml?: string | null;
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
}): Prisma.OutreachMessageWhereInput {
  // Keyset on the uuid(7) id (DESC) — exact, no timestamp-precision risk.
  return { id: { lt: cursor.id } };
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

  /**
   * Resolve the open conversation for an agent: the most recent non-`closed`
   * thread, or a fresh `active` one. One open thread per agent at a time — a
   * `closed` (opted-out) thread is never reused, so an opt-out is permanent.
   */
  async findOrCreateOpenThreadByAgent(
    input: { agentId: string; subject: string },
    tx?: Prisma.TransactionClient,
  ): Promise<OutreachThreadRecord> {
    const db: PrismaLike = tx ?? prisma;
    const existing = await db.outreachThread.findFirst({
      where: { agentId: input.agentId, status: { not: "closed" } },
      orderBy: { createdAt: "desc" },
      select: THREAD_SELECT,
    });
    if (existing) {
      return existing;
    }
    return db.outreachThread.create({
      data: { agentId: input.agentId, subject: input.subject },
      select: THREAD_SELECT,
    });
  }

  /**
   * Advance a thread through the guarded state machine (AC#4). Reads the current
   * status, applies the pure `advanceThreadStatus` reducer, and persists ONLY
   * when the status actually changes (an illegal/no-op event leaves the row
   * untouched). `bumpLastMessageAt` updates lastMessageAt for send/reply events.
   * Returns the resulting status.
   */
  async applyThreadEvent(
    input: { threadId: string; event: ThreadEvent; at?: Date },
    tx?: Prisma.TransactionClient,
  ): Promise<OutreachThreadStatus> {
    const db: PrismaLike = tx ?? prisma;
    const thread = await db.outreachThread.findUnique({
      where: { id: input.threadId },
      select: { status: true },
    });
    if (!thread) {
      throw new Error(`OutreachThread ${input.threadId} not found`);
    }
    const next = advanceThreadStatus(thread.status, input.event);
    const bump = input.event === "outbound_sent" || input.event === "inbound_reply";
    if (next === thread.status && !bump) {
      return thread.status;
    }
    await db.outreachThread.update({
      where: { id: input.threadId },
      data: {
        ...(next !== thread.status ? { status: next } : {}),
        ...(bump ? { lastMessageAt: input.at ?? new Date() } : {}),
      },
      select: { id: true },
    });
    return next;
  }

  /**
   * Attempted outbound sends since a cutoff — the DENOMINATOR for the M6
   * circuit-breaker (gate 4). Counts persisted outbound messages (a send is
   * persisted only after the provider accepted it), so the rate is
   * bounced/complained events ÷ this count.
   */
  async countOutboundSince(since: Date): Promise<number> {
    return prisma.outreachMessage.count({
      where: { direction: "outbound", sentAt: { gte: since } },
    });
  }

  /** Close every open thread for an agent (opt-out / unsubscribe). Idempotent. */
  async closeThreadsByAgent(
    agentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db: PrismaLike = tx ?? prisma;
    const { count } = await db.outreachThread.updateMany({
      where: { agentId, status: { not: "closed" } },
      data: { status: "closed" },
    });
    return count;
  }

  /**
   * Threads due a follow-up: still `awaiting_reply` (the status machine moves a
   * replied thread to `replied`, so this inherently means "no reply since the
   * last send") with no activity since the cutoff, oldest first. Drives the
   * outreach:followup cadence.
   */
  async listFollowupDue(input: {
    cutoff: Date;
    limit: number;
  }): Promise<OutreachThreadRecord[]> {
    return prisma.outreachThread.findMany({
      where: {
        status: "awaiting_reply",
        lastMessageAt: { lt: input.cutoff },
      },
      orderBy: { lastMessageAt: "asc" },
      take: input.limit,
      select: THREAD_SELECT,
    });
  }

  /**
   * The latest NON-`closed` thread status per agent. Backs the Agents screen's
   * status column (PR1 agentsRouter). For each agentId, picks the status of its
   * MOST-RECENT open thread (most recent activity first, then most recently
   * created as a tiebreak when `lastMessageAt` is still NULL). An agent whose
   * threads are all `closed` (opted-out) or who has no thread at all is ABSENT
   * from the Map (the router treats absence as "queued"). An empty id list
   * returns an empty Map (no query). One `IN (...)` query, reduced to first-seen
   * per agentId, so there is no N+1.
   */
  async latestStatusByAgentIds(
    agentIds: string[],
  ): Promise<Map<string, OutreachThreadStatus>> {
    if (agentIds.length === 0) {
      return new Map();
    }
    const threads = await prisma.outreachThread.findMany({
      where: { agentId: { in: agentIds }, status: { not: "closed" } },
      // NULLS LAST: a real activity timestamp must outrank a never-sent thread
      // (Postgres defaults DESC to NULLS FIRST, which would let an `active`
      // thread with no lastMessageAt eclipse a timestamped replied/awaiting one).
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { agentId: true, status: true },
    });
    const latest = new Map<string, OutreachThreadStatus>();
    for (const thread of threads) {
      // findMany returns most-recent first, so the FIRST row seen per agentId is
      // its latest open thread. Later rows for the same agent are ignored.
      if (!latest.has(thread.agentId)) {
        latest.set(thread.agentId, thread.status);
      }
    }
    return latest;
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
        bodyHtml: input.bodyHtml ?? null,
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
      orderBy: [{ id: "desc" }],
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
