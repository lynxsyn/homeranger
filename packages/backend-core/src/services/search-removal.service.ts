/**
 * search-removal.service — the cascade behind deleting a Search.
 *
 * The design (and the operator's ask): "if we remove a search it should hide
 * those listings and completely remove the agents." Three effects, ONE atomic
 * transaction (via `runTransaction`, the same seam inbound-ingestion uses), so a
 * mid-cascade fault never leaves a half-deleted search:
 *
 *   1. HIDE the search's homes for the OWNER — one DismissedListing row per
 *      listing in the search's outcodes. The global Listing rows are never
 *      deleted; the homes are recoverable from the owner's Dismissed view. This
 *      is per-user (a non-operator hides only their own feed).
 *   2. COMPLETELY REMOVE the search's agents (operator only) — a GDPR-compliant
 *      hard delete that cascades each agent's OutreachThreads + OutreachMessages
 *      (FK ON DELETE CASCADE), erasing the agent record AND all its
 *      correspondence. Agents are GLOBAL / operator-owned (same boundary as
 *      agentsRouter + outreach.killSwitch), so a non-operator deleting their own
 *      search does NOT touch the shared pool — only the operator's cascade does.
 *   3. DELETE the Search row (owner-scoped).
 *
 * Agent selection is GDPR-correct AND safe against overlapping searches: an agent
 * is removed iff it covers part of THIS search's patch AND none of any OTHER
 * remaining operator search's patch. Keeping agents another search still relies
 * on preserves a legitimate-interest basis (and avoids orphaning that search's
 * pool); the confirm dialog shows the exact count that WILL be removed.
 *
 * This is the first genuine business-logic seam in the search surface (the rest
 * is pure CRUD straight to the repository). It reads the live repository
 * singletons (swappable per-repo via each repo's `_setXRepositoryForTesting`) and
 * owns ONLY the transaction boundary (`txRunner`), keeping "repositories own all
 * Prisma data access" intact.
 */
import { Prisma } from "@prisma/client";
import { runTransaction } from "../lib/prisma.js";
import { searchRepository } from "../repositories/search.repository.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { listingRepository } from "../repositories/listing.repository.js";
import { dismissedListingRepository } from "../repositories/dismissed-listing.repository.js";

/** Counts the cascade actually applied (echoed to the SPA after a delete). */
export interface SearchRemovalResult {
  id: string;
  /** Homes hidden for the owner (listings in the search's outcodes). */
  dismissedCount: number;
  /** Agents completely removed (operator only; 0 for a non-operator). */
  removedAgentCount: number;
}

/** What the confirm dialog shows BEFORE the delete (no mutation). */
export interface SearchRemovalPreview {
  /** Homes that will be hidden (count of listings in the search's outcodes). */
  listingsToHide: number;
  /** Agents that will be completely removed (operator only; 0 otherwise). */
  agentsToRemove: number;
}

export interface SearchRemovalInput {
  searchId: string;
  /** Resolved owner key — `null` for the operator. */
  ownerId: string | null;
  /** ownerId === null. Only the operator's cascade removes (global) agents. */
  isOperator: boolean;
}

// The transaction boundary is the one swappable seam (so the service unit test
// runs with no DB): a fake runner just invokes the callback with a stub tx.
type TransactionRunner = typeof runTransaction;
let txRunner: TransactionRunner = runTransaction;
export function _setTransactionRunnerForTesting(
  runner: TransactionRunner | null,
): void {
  txRunner = runner ?? runTransaction;
}

/** Build the Prisma P2025 the router's `searchNotFound` remaps to NOT_FOUND. */
function searchNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Search not found for this owner",
    { code: "P2025", clientVersion: Prisma.prismaVersion.client },
  );
}

const uc = (outcode: string): string => outcode.toUpperCase();

/**
 * PURE selection: which candidate agents to remove when the search covering
 * `targetOutcodes` is deleted, given the outcodes covered by all OTHER remaining
 * operator searches. Remove an agent iff it touches the target patch AND touches
 * none of the others (so an agent another search still needs is kept). Exported
 * for direct unit testing.
 */
export function selectAgentsToRemove(
  targetOutcodes: string[],
  otherSearchOutcodes: Iterable<string>,
  candidates: Array<{ id: string; coveredOutcodes: string[] }>,
): string[] {
  const target = new Set(targetOutcodes.map(uc));
  const others = new Set([...otherSearchOutcodes].map(uc));
  const removed: string[] = [];
  for (const agent of candidates) {
    const coverage = agent.coveredOutcodes.map(uc);
    const touchesTarget = coverage.some((outcode) => target.has(outcode));
    if (!touchesTarget) {
      continue; // defensive: findIdsByOutcodes already pre-filters to the patch
    }
    const touchesOther = coverage.some((outcode) => others.has(outcode));
    if (!touchesOther) {
      removed.push(agent.id);
    }
  }
  return removed;
}

/**
 * Resolve the agent ids the cascade would erase for the operator. Reads the
 * other remaining operator searches' outcodes + the agents covering the patch,
 * then applies `selectAgentsToRemove`. Returns [] for a search with no outcodes.
 */
async function resolveCascadeAgentIds(
  searchId: string,
  targetOutcodes: string[],
): Promise<string[]> {
  if (targetOutcodes.length === 0) {
    return [];
  }
  const [otherSearches, candidates] = await Promise.all([
    searchRepository.list(null),
    agentRepository.findIdsByOutcodes(targetOutcodes),
  ]);
  const otherOutcodes = otherSearches
    .filter((search) => search.id !== searchId)
    .flatMap((search) => search.outcodes);
  return selectAgentsToRemove(targetOutcodes, otherOutcodes, candidates);
}

/**
 * Preview the cascade for the confirm dialog — NO mutation. `listingsToHide` is
 * the homes in the patch; `agentsToRemove` is the precise set the operator's
 * cascade would erase (0 for a non-operator). NOT_FOUND (P2025) when the search
 * is missing or another owner's.
 */
export async function previewSearchRemoval(
  input: SearchRemovalInput,
): Promise<SearchRemovalPreview> {
  const search = await searchRepository.getById(input.searchId, input.ownerId);
  if (!search) {
    throw searchNotFound();
  }
  const listingsToHide = await listingRepository.countByOutcodes(search.outcodes);
  const agentsToRemove = input.isOperator
    ? (await resolveCascadeAgentIds(search.id, search.outcodes)).length
    : 0;
  return { listingsToHide, agentsToRemove };
}

/**
 * Run the full cascade ATOMICALLY: hide the search's homes for the owner,
 * (operator only) completely remove its non-shared agents, then delete the
 * search. NOT_FOUND (P2025) when the search is missing or another owner's —
 * raised BEFORE the transaction so nothing is mutated. The scoped delete inside
 * the transaction re-checks ownership (also P2025), so a concurrent foreign
 * delete can never slip through.
 */
export async function removeSearchCascade(
  input: SearchRemovalInput,
): Promise<SearchRemovalResult> {
  const search = await searchRepository.getById(input.searchId, input.ownerId);
  if (!search) {
    throw searchNotFound();
  }
  const listingIds = await listingRepository.listIdsByOutcodes(search.outcodes);
  const agentIds = input.isOperator
    ? await resolveCascadeAgentIds(search.id, search.outcodes)
    : [];

  await txRunner(async (tx) => {
    await dismissedListingRepository.dismissMany(input.ownerId, listingIds, tx);
    if (agentIds.length > 0) {
      await agentRepository.deleteManyByIds(agentIds, tx);
    }
    await searchRepository.delete(search.id, input.ownerId, tx);
  });

  return {
    id: search.id,
    dismissedCount: listingIds.length,
    removedAgentCount: agentIds.length,
  };
}
