/**
 * Agent repository — owns all Prisma access for the Agent aggregate (estate
 * agents we discover and contact). Single-user: no tenant scoping. Mirrors the
 * Doxus optional-tx + cursor-pagination + explicit-select conventions.
 */
import { Prisma, type MailboxType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  clampLimit,
  decodeCursor,
  paginate,
  type CursorPage,
} from "../lib/pagination/cursor.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const AGENT_SELECT = Prisma.validator<Prisma.AgentSelect>()({
  id: true,
  email: true,
  agencyName: true,
  mailboxType: true,
  optedOut: true,
  coveredOutcodes: true,
  lastContactedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type AgentRecord = Prisma.AgentGetPayload<{
  select: typeof AGENT_SELECT;
}>;

export interface UpsertAgentByEmailInput {
  email: string;
  agencyName: string | null;
  mailboxType?: MailboxType;
  coveredOutcodes?: string[];
}

export interface ListAgentsInput {
  cursor?: string;
  limit?: number;
  /** When set, only agents covering at least one of these outcodes. */
  outcodes?: string[];
  /** When false (default), suppress opted-out agents. */
  includeOptedOut?: boolean;
}

function buildAgentCursorFilter(cursor: { id: string }): Prisma.AgentWhereInput {
  // Keyset on the uuid(7) id (DESC) — exact, no timestamp-precision risk.
  return { id: { lt: cursor.id } };
}

export class AgentRepository {
  async getById(id: string): Promise<AgentRecord | null> {
    return prisma.agent.findUnique({ where: { id }, select: AGENT_SELECT });
  }

  async findByEmail(email: string): Promise<AgentRecord | null> {
    return prisma.agent.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: AGENT_SELECT,
    });
  }

  /** Idempotent upsert keyed on the unique `email`. */
  async upsertByEmail(
    input: UpsertAgentByEmailInput,
    tx?: Prisma.TransactionClient,
  ): Promise<AgentRecord> {
    const db: PrismaLike = tx ?? prisma;
    const email = input.email.trim().toLowerCase();
    return db.agent.upsert({
      where: { email },
      create: {
        email,
        agencyName: input.agencyName,
        ...(input.mailboxType ? { mailboxType: input.mailboxType } : {}),
        coveredOutcodes: input.coveredOutcodes ?? [],
      },
      update: {
        ...(input.agencyName !== undefined
          ? { agencyName: input.agencyName }
          : {}),
        ...(input.mailboxType ? { mailboxType: input.mailboxType } : {}),
        ...(input.coveredOutcodes
          ? { coveredOutcodes: input.coveredOutcodes }
          : {}),
      },
      select: AGENT_SELECT,
    });
  }

  async list(input: ListAgentsInput = {}): Promise<CursorPage<AgentRecord>> {
    const limit = clampLimit(input.limit);
    const where: Prisma.AgentWhereInput = {};
    if (!input.includeOptedOut) {
      where.optedOut = false;
    }
    if (input.outcodes && input.outcodes.length > 0) {
      where.coveredOutcodes = { hasSome: input.outcodes };
    }
    const cursorFilter = input.cursor
      ? buildAgentCursorFilter(decodeCursor(input.cursor))
      : {};
    const rows = await prisma.agent.findMany({
      where: { ...where, ...cursorFilter },
      orderBy: [{ id: "desc" }],
      take: limit + 1,
      select: AGENT_SELECT,
    });
    return paginate(rows, limit);
  }

  /**
   * Count agents covering at least one of the given outcodes — the "agents in
   * the search's patch" stat (PR3 searchesRouter.stats). When `contactedOnly` is
   * set, restricts to agents already contacted (`lastContactedAt != null`).
   * Opted-out agents are EXCLUDED (mirrors `list`'s default), so the patch count
   * reflects who is actually reachable. An empty outcode set returns 0.
   */
  async countByOutcodes(
    outcodes: string[],
    options: { contactedOnly?: boolean } = {},
  ): Promise<number> {
    if (outcodes.length === 0) {
      return 0;
    }
    const where: Prisma.AgentWhereInput = {
      optedOut: false,
      coveredOutcodes: { hasSome: outcodes },
    };
    if (options.contactedOnly) {
      where.lastContactedAt = { not: null };
    }
    return prisma.agent.count({ where });
  }

  /**
   * The id + coverage of every agent touching at least one of `outcodes`,
   * OPTED-OUT INCLUDED. Backs the search-removal cascade's agent selection: it
   * must see the full set covering the patch (opted-out agents still hold PII +
   * correspondence to erase) and each agent's whole `coveredOutcodes` so the
   * service can keep agents still covered by ANOTHER remaining search. Unbounded
   * by design (a tiny projection, NOT the paginated `list`) so it never silently
   * clamps the cascade set at the page cap. An empty outcode set returns [].
   */
  async findIdsByOutcodes(
    outcodes: string[],
  ): Promise<Array<{ id: string; coveredOutcodes: string[] }>> {
    if (outcodes.length === 0) {
      return [];
    }
    return prisma.agent.findMany({
      where: { coveredOutcodes: { hasSome: outcodes } },
      select: { id: true, coveredOutcodes: true },
    });
  }

  /**
   * The (normalised) email addresses for the given agent ids — used by the agent
   * erasure to purge the EmailEvent delivery rows keyed by email (no FK, so they
   * do not cascade with the Agent delete). An empty id list returns [].
   */
  async findEmailsByIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await prisma.agent.findMany({
      where: { id: { in: ids } },
      select: { email: true },
    });
    return rows.map((row) => row.email);
  }

  /**
   * COMPLETELY remove a single agent by id (GDPR erasure). The FK ON DELETE
   * CASCADE drops every OutreachThread → OutreachMessage, so the agent record AND
   * all its correspondence are erased ATOMICALLY in one statement. Throws Prisma
   * P2025 when no row matches (the router remaps it to NOT_FOUND). The listings
   * the agent sent are NOT touched — they are a global, still-valid catalogue
   * (kept per the design; only their denormalised agentEmail references the gone
   * agent).
   */
  async deleteById(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db: PrismaLike = tx ?? prisma;
    await db.agent.delete({ where: { id }, select: { id: true } });
  }

  /**
   * COMPLETELY remove many agents by id in one statement (the search-removal
   * cascade's bulk erasure). Same FK-cascade erasure as `deleteById`, but
   * tolerant of a missing id (deleteMany never throws P2025). Returns the count
   * actually deleted. An empty id list is a no-op (returns 0). Accepts a `tx` so
   * the cascade erases agents, hides homes, and deletes the search atomically.
   */
  async deleteManyByIds(
    ids: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const db: PrismaLike = tx ?? prisma;
    const result = await db.agent.deleteMany({ where: { id: { in: ids } } });
    return result.count;
  }

  async markOptedOut(
    email: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db: PrismaLike = tx ?? prisma;
    await db.agent.updateMany({
      where: { email: email.trim().toLowerCase() },
      data: { optedOut: true },
    });
  }

  async markContacted(
    id: string,
    contactedAt: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db: PrismaLike = tx ?? prisma;
    await db.agent.update({
      where: { id },
      data: { lastContactedAt: contactedAt },
      select: { id: true },
    });
  }

  /**
   * True when ANOTHER agent (id != excludeAgentId) sharing this email `domain`
   * was contacted at/after `since`. Powers the ComplianceGuard per-domain
   * cooldown: one agency (email domain) gets at most one cold approach per
   * window, even across the several mailboxes discovery may surface for it. The
   * `@`-prefixed `endsWith` makes "fletcherpoole.com" match only true mailboxes
   * at that host (never "notfletcherpoole.com"). A blank domain returns false.
   * Opted-out agents still count — opting out doesn't un-contact them, and we
   * never want a second approach to the same agency regardless.
   */
  async wasDomainContactedSince(
    domain: string,
    since: Date,
    excludeAgentId: string,
  ): Promise<boolean> {
    const d = domain.trim().toLowerCase();
    if (!d) {
      return false;
    }
    const hit = await prisma.agent.findFirst({
      where: {
        id: { not: excludeAgentId },
        lastContactedAt: { gte: since },
        // case-insensitive: emails are stored lower-cased, but ILIKE keeps the
        // match correct even if a future non-normalised insert path slips in.
        email: { endsWith: `@${d}`, mode: "insensitive" },
      },
      select: { id: true },
    });
    return hit !== null;
  }
}

const defaultAgentRepository = new AgentRepository();

export let agentRepository = defaultAgentRepository;

export function _setAgentRepositoryForTesting(
  repository: AgentRepository | null,
): void {
  agentRepository = repository ?? defaultAgentRepository;
}
