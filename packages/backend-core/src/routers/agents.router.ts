/**
 * agentsRouter (PR1). The operator's view of the discovered estate-agent pool.
 *
 * An "agent" row is a real estate AGENT/agency we discovered (and optionally
 * contacted), enriched with TWO server-side derivations:
 *   - `status`: the design's relationship status (`replied | awaiting | queued
 *     | opted_out`), derived from `Agent.optedOut` + the agent's latest
 *     NON-`closed` OutreachThread status (see `deriveAgentStatus`).
 *   - `homesCount`: how many listings this agent has sent (listings whose
 *     `agentEmail` matches), so the screen shows who is actually feeding homes.
 *
 * OPERATOR-ONLY: the discovered-agent pool + its outreach state is the
 * compliance-governed engine's surface (same boundary as outreach.killSwitch /
 * searches.launch), so both procedures use `operatorProcedure` (FORBIDDEN for a
 * non-operator). Agents are GLOBAL (NOT per-user), so there is NO owner-scope on
 * the agent/listing/outreach reads.
 *
 * `list` and `stats` share ONE internal `buildAgentRows(outcodes?)` builder so
 * the table and the metric tiles are always computed from the SAME enriched
 * rows; `list` returns them, `stats` aggregates over them. Both take the same
 * optional `{ outcodes }` scope (the search drill-in narrows to a patch; absent
 * / empty → every agent). The reads use the live `agentRepository` /
 * `outreachRepository` / `listingRepository` singletons (ESM live bindings), so
 * a unit test injects fakes via each repo's own `_setXRepositoryForTesting` seam.
 */
import { Prisma, type OutreachThreadStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  agentByIdInputSchema,
  agentsListInputSchema,
  agentsStatsInputSchema,
} from "@homeranger/shared";
import { operatorProcedure, router } from "../trpc.js";
import { agentRepository, type AgentRecord } from "../repositories/agent.repository.js";
import { outreachRepository } from "../repositories/outreach.repository.js";
import { listingRepository } from "../repositories/listing.repository.js";
import { summariseCoverage, type CoverageSummary } from "../lib/geo/coverage.js";

/** The design's relationship status for an agent row. */
export type AgentThreadStatus = "replied" | "awaiting" | "queued" | "opted_out";

/** One enriched agent row as `list` returns it (Date round-trips via superjson). */
export interface AgentRow {
  id: string;
  agencyName: string | null;
  email: string;
  /** = `Agent.coveredOutcodes`. */
  outcodes: string[];
  /**
   * `outcodes` rolled up to a place-led summary (dominant principal area + a
   * count, town groups for the popover, HQ = first outcode) via the bundled UK
   * outcode index. Computed server-side so the index never ships to the client.
   */
  coverage: CoverageSummary;
  status: AgentThreadStatus;
  /** Listings whose `agentEmail` === this agent's email. */
  homesCount: number;
  lastContactedAt: Date | null;
}

/** Aggregate metrics over the rows in scope (the four metric tiles). */
export interface AgentStatsResult {
  /** Agents in scope with `lastContactedAt != null`. */
  contacted: number;
  /** Rows with `status === "replied"`. */
  replied: number;
  /** Rows with `status === "awaiting"` OR `"queued"` (queued folds into awaiting). */
  awaiting: number;
  /** Sum of `rows.homesCount`: total homes the agents in scope have sent. */
  homesIngested: number;
}

/**
 * Map an agent's persistence state to the design status. `optedOut` is checked
 * FIRST (a closed thread also implies opted-out, so opt-out always wins); then
 * the latest NON-`closed` thread status maps across; an agent with no open
 * thread (absent from the status Map) is `"queued"`: discovered, first send
 * pending.
 */
function deriveAgentStatus(
  optedOut: boolean,
  latestThreadStatus: OutreachThreadStatus | undefined,
): AgentThreadStatus {
  if (optedOut) {
    return "opted_out";
  }
  switch (latestThreadStatus) {
    case "replied":
      return "replied";
    case "awaiting_reply":
      return "awaiting";
    case "active":
      return "queued";
    default:
      // No non-closed thread at all → created, first send pending.
      return "queued";
  }
}

/**
 * Build the enriched rows ONCE (shared by `list` + `stats`). Pulls the agents in
 * scope (opted-out INCLUDED, since there is an "Opted out" filter chip), then joins
 * the latest open-thread status (by agent id) and the homes count (by agent
 * email) in two batch queries. NO owner-scope: agents are global.
 */
/**
 * Walk the WHOLE discovered-agent pool. `agentRepository.list` caps each page at
 * MAX_PAGE_LIMIT (100), so a single call silently truncates once the pool grows
 * past 100 — which would drop agents from the table AND under-count every metric
 * tile (`stats` aggregates the same rows). The Agents screen shows the full pool
 * with no pagination UI, so we page through the cursor until it is exhausted. A
 * high page ceiling bounds a pathological loop far above any realistic
 * single-operator agent pool.
 */
async function collectAgents(outcodes?: string[]): Promise<AgentRecord[]> {
  const PAGE = 100;
  const MAX_PAGES = 50; // 5000 agents — a safety ceiling, never reached in practice
  const all: AgentRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await agentRepository.list({
      outcodes,
      includeOptedOut: true,
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...result.items);
    if (!result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
  }
  return all;
}

async function buildAgentRows(outcodes?: string[]): Promise<AgentRow[]> {
  const items = await collectAgents(outcodes);
  const [statusByAgentId, homesByEmail] = await Promise.all([
    outreachRepository.latestStatusByAgentIds(items.map((agent) => agent.id)),
    listingRepository.countByAgentEmails(items.map((agent) => agent.email)),
  ]);
  return items.map((agent) => ({
    id: agent.id,
    agencyName: agent.agencyName,
    email: agent.email,
    outcodes: agent.coveredOutcodes,
    coverage: summariseCoverage(agent.coveredOutcodes),
    status: deriveAgentStatus(agent.optedOut, statusByAgentId.get(agent.id)),
    homesCount: homesByEmail.get(agent.email) ?? 0,
    lastContactedAt: agent.lastContactedAt,
  }));
}

export const agentsRouter = router({
  /**
   * The discovered-agent pool (opted-out INCLUDED), enriched + optionally scoped
   * to a patch's outcodes. Returns the rows the table renders.
   */
  list: operatorProcedure
    .input(agentsListInputSchema)
    .query(async ({ input }): Promise<AgentRow[]> => {
      return buildAgentRows(input.outcodes);
    }),

  /**
   * The four metric tiles, aggregated over the SAME rows `list` returns so the
   * table and the metrics never disagree. `awaiting` folds `queued` in (both are
   * "no reply yet"); `homesIngested` sums the per-agent home counts.
   */
  stats: operatorProcedure
    .input(agentsStatsInputSchema)
    .query(async ({ input }): Promise<AgentStatsResult> => {
      const rows = await buildAgentRows(input.outcodes);
      let contacted = 0;
      let replied = 0;
      let awaiting = 0;
      let homesIngested = 0;
      for (const row of rows) {
        if (row.lastContactedAt !== null) {
          contacted += 1;
        }
        if (row.status === "replied") {
          replied += 1;
        }
        if (row.status === "awaiting" || row.status === "queued") {
          awaiting += 1;
        }
        homesIngested += row.homesCount;
      }
      return { contacted, replied, awaiting, homesIngested };
    }),

  /**
   * COMPLETELY remove an agent from the pool — the GDPR-compliant erasure behind
   * the Agents table's row "Remove" action. A single atomic delete cascades the
   * agent's OutreachThreads + OutreachMessages (FK ON DELETE CASCADE), so the
   * agent record AND all its correspondence are erased in one statement. The
   * listings it already sent STAY (a global, still-valid catalogue — "you're
   * dropping one agency, not the hunt"); only their denormalised agentEmail now
   * points at a gone agent. OPERATOR-ONLY (the agent pool is global, same
   * boundary as `list`/`stats`). A missing id maps to NOT_FOUND (Prisma P2025),
   * mirroring searches.delete; the agent can be re-discovered by a future search.
   */
  remove: operatorProcedure
    .input(agentByIdInputSchema)
    .mutation(async ({ input }): Promise<{ id: string }> => {
      try {
        await agentRepository.deleteById(input.id);
        return { id: input.id };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2025"
        ) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        throw error;
      }
    }),
});
