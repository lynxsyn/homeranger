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

function buildAgentCursorFilter(cursor: {
  id: string;
  createdAt: Date;
}): Prisma.AgentWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

export class AgentRepository {
  async getById(_id: string): Promise<AgentRecord | null> {
    throw new Error("not implemented");
  }

  async findByEmail(_email: string): Promise<AgentRecord | null> {
    throw new Error("not implemented");
  }

  /** Idempotent upsert keyed on the unique `email`. */
  async upsertByEmail(
    _input: UpsertAgentByEmailInput,
    _tx?: Prisma.TransactionClient,
  ): Promise<AgentRecord> {
    throw new Error("not implemented");
  }

  async list(_input: ListAgentsInput = {}): Promise<CursorPage<AgentRecord>> {
    throw new Error("not implemented");
  }

  async markOptedOut(
    _email: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  async markContacted(
    _id: string,
    _contactedAt: Date,
    _tx?: Prisma.TransactionClient,
  ): Promise<void> {
    throw new Error("not implemented");
  }
}

void AGENT_SELECT;
void buildAgentCursorFilter;
void clampLimit;
void decodeCursor;
void paginate;

const defaultAgentRepository = new AgentRepository();

export let agentRepository = defaultAgentRepository;

export function _setAgentRepositoryForTesting(
  repository: AgentRepository | null,
): void {
  agentRepository = repository ?? defaultAgentRepository;
}
