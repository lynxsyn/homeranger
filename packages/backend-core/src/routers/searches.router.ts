/**
 * searchesRouter — the M8 search (saved buyer brief) CRUD surface.
 *
 * Single `protectedProcedure` surface (one user, no tenant scoping):
 *   - list     : all searches, most-recently-updated first.
 *   - getById  : a single search, NOT_FOUND on miss.
 *   - create   : a new search (outcodes resolved server-side from location).
 *   - update   : full-replace an existing search, NOT_FOUND on miss.
 *   - delete   : remove a search, echoes `{ id }`.
 *   - setStatus: toggle active ⇄ paused.
 *
 * NO SERVICE LAYER — like listingsRouter, this is a pure CRUD path with no
 * business logic between the wire and storage (the only derivation, outcode
 * resolution, lives in the repository). The router calls `searchRepository`
 * directly. The shared input schemas are `.strict()`, so no stray field slips
 * through; the repository derives `outcodes` from `location` (the form has no
 * outcodes field).
 *
 * Every returned row is a full `SearchRecord` carrying all DB columns, so the SPA
 * infers the search shape via `inferRouterOutputs`.
 *
 * NOT_FOUND mapping: getById + update map a missing row to NOT_FOUND (update
 * pre-checks via getById so the unit test stays simple); delete + setStatus go
 * straight to the repo, so they catch Prisma P2025 ("record not found") and
 * remap it to NOT_FOUND — a consistent 404 contract across all sibling
 * procedures instead of a raw 500 when a row was removed in another session.
 */
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import {
  searchApproveSendsInputSchema,
  searchByIdInputSchema,
  searchCreateInputSchema,
  searchSetStatusInputSchema,
  searchUpdateInputSchema,
} from "@homeranger/shared";
import { operatorProcedure, protectedProcedure, router } from "../trpc.js";
import { ownerKeyFor } from "../lib/auth/supabase-auth.js";
import {
  searchRepository,
  type SearchRecord,
} from "../repositories/search.repository.js";
import {
  agentRepository,
  type AgentRepository,
  type AgentRecord,
} from "../repositories/agent.repository.js";
import { MAX_PAGE_LIMIT } from "../lib/pagination/cursor.js";
import {
  listingRepository,
  type ListingRepository,
} from "../repositories/listing.repository.js";
import {
  complianceGuard as defaultComplianceGuard,
  ComplianceError,
  type AgentForGuard,
  type ComplianceGuard,
} from "../lib/compliance/compliance-guard.js";
import { draftSearchEmail } from "../lib/searches/search-brief.js";
import {
  searchProfileRepository as defaultSearchProfileRepository,
  type SearchProfileRepository,
} from "../repositories/search-profile.repository.js";
import {
  previewSearchRemoval,
  removeSearchCascade,
  type SearchRemovalPreview,
  type SearchRemovalResult,
} from "../services/search-removal.service.js";
import { currentSenderName } from "../lib/email/email-provider.js";
import { resolveSender } from "@homeranger/shared";
import {
  enqueueDiscoverAgents,
  enqueueOutreachSend,
  type EnqueueInput,
} from "../lib/queue/queue-client.js";
import type {
  DiscoverAgentsJobPayload,
  OutreachSendJobPayload,
} from "../lib/queue/queue-config.js";
import { triggerSearchRecompute } from "../lib/queue/analyze-backfill.js";

/** A single search row as the procedures return it. */
export type SearchRow = SearchRecord;

// The delete-a-search cascade (hide homes + remove agents + delete the search)
// lives in search-removal.service; the router stubs it as ONE seam so the router
// unit test asserts wiring + error-mapping while the service has its own test.
type RemoveSearchCascade = typeof removeSearchCascade;
let searchRemovalCascade: RemoveSearchCascade = removeSearchCascade;
export function _setSearchRemovalCascadeForTesting(
  fn: RemoveSearchCascade | null,
): void {
  searchRemovalCascade = fn ?? removeSearchCascade;
}

type PreviewSearchRemoval = typeof previewSearchRemoval;
let searchRemovalPreviewer: PreviewSearchRemoval = previewSearchRemoval;
export function _setSearchRemovalPreviewerForTesting(
  fn: PreviewSearchRemoval | null,
): void {
  searchRemovalPreviewer = fn ?? previewSearchRemoval;
}

// ── Swappable seams (mirror outreach.router's _set*ForTesting pattern) so unit
// tests assert the launch loop without a live Redis or DB. The guard +
// agent/listing repos default to the real singletons; tests inject fakes.
let searchComplianceGuard: ComplianceGuard = defaultComplianceGuard;
export function _setSearchComplianceGuardForTesting(
  guard: ComplianceGuard | null,
): void {
  searchComplianceGuard = guard ?? defaultComplianceGuard;
}

let searchAgentRepository: AgentRepository = agentRepository;
export function _setSearchAgentRepositoryForTesting(
  repo: AgentRepository | null,
): void {
  searchAgentRepository = repo ?? agentRepository;
}

/**
 * Every agent in the patch (covering any of `outcodes`), paged through the
 * cursor. agentRepository.list clamps to MAX_PAGE_LIMIT (100), so a single call
 * silently caps the review at the first 100 agents — the rest never appear in the
 * review and so can never be approved (a 42-agent patch left ~22 permanently
 * "queued"). Mirrors agents.router's collectAgents; the high page ceiling bounds a
 * pathological loop far above any realistic single-operator patch.
 */
async function collectPatchAgents(outcodes: string[]): Promise<AgentRecord[]> {
  const MAX_PAGES = 50; // 5000 agents — a safety ceiling, never reached in practice
  const all: AgentRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await searchAgentRepository.list({
      outcodes,
      // Include opted-out agents so the review shows them as blocked (reason
      // OPTED_OUT) rather than hiding them — reviewDrafts already surfaces every
      // other block reason (PECR / suppressed / domain-cooldown), and the guard
      // marks opt-outs ineligible. Matches agents.router's collectAgents.
      includeOptedOut: true,
      limit: MAX_PAGE_LIMIT,
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

let searchListingRepository: ListingRepository = listingRepository;
export function _setSearchListingRepositoryForTesting(
  repo: ListingRepository | null,
): void {
  searchListingRepository = repo ?? listingRepository;
}

// The buyer profile drives the reviewed draft's sign-off + urgency so the
// operator reviews EXACTLY what gets sent. Swappable so the router unit test
// asserts reviewDrafts without a live DB.
let reviewProfileRepository: SearchProfileRepository =
  defaultSearchProfileRepository;
export function _setReviewProfileRepositoryForTesting(
  repo: SearchProfileRepository | null,
): void {
  reviewProfileRepository = repo ?? defaultSearchProfileRepository;
}

type DiscoverAgentsEnqueuer = (
  input: EnqueueInput<DiscoverAgentsJobPayload>,
) => Promise<void>;
let discoverAgentsEnqueuer: DiscoverAgentsEnqueuer = enqueueDiscoverAgents;
export function _setDiscoverAgentsEnqueuerForTesting(
  enqueuer: DiscoverAgentsEnqueuer | null,
): void {
  discoverAgentsEnqueuer = enqueuer ?? enqueueDiscoverAgents;
}

type OutreachSendEnqueuer = (
  input: EnqueueInput<OutreachSendJobPayload>,
) => Promise<void>;
let searchOutreachSendEnqueuer: OutreachSendEnqueuer = enqueueOutreachSend;
export function _setSearchOutreachSendEnqueuerForTesting(
  enqueuer: OutreachSendEnqueuer | null,
): void {
  searchOutreachSendEnqueuer = enqueuer ?? enqueueOutreachSend;
}

// Per-search match-scoring re-rank trigger. A swappable seam so the router unit
// test asserts it fires (operator + active only) without a live queue.
type SearchRecomputeTrigger = (searchId: string) => Promise<void>;
let searchRecomputeTrigger: SearchRecomputeTrigger = triggerSearchRecompute;
export function _setSearchRecomputeTriggerForTesting(
  fn: SearchRecomputeTrigger | null,
): void {
  searchRecomputeTrigger = fn ?? triggerSearchRecompute;
}

/** One reviewed agent: eligible iff the ComplianceGuard precheck passes. */
export interface SearchReviewAgent {
  id: string;
  email: string;
  agencyName: string | null;
  eligible: boolean;
  /** The ComplianceCode that blocked it (null when eligible). */
  reason: string | null;
}

export interface SearchLaunchResult {
  enqueued: boolean;
  outcodes: string[];
}

export interface SearchReviewDraftsResult {
  draft: string;
  agents: SearchReviewAgent[];
}

export interface SearchApproveSendsResult {
  enqueued: number;
}

export interface SearchStatsResult {
  homesFound: number;
  agentsInPatch: number;
  agentsContacted: number;
}

/**
 * Fire the per-search re-rank when an OPERATOR's ACTIVE search changes. Scoring
 * is the operator's global-catalogue engine (ownerId === null), mirroring
 * preferences.router; a non-operator's searches are stored but NOT scored
 * (per-user matching is a future enhancement). A paused search never scores (it
 * stops new outreach + scoring). Best-effort: a queue hiccup must not fail the
 * write, so log + swallow (mirrors preferences.update's backfill trigger).
 */
async function maybeTriggerRecompute(
  ownerId: string | null,
  search: SearchRow,
): Promise<void> {
  if (ownerId !== null || search.status !== "active") {
    return;
  }
  try {
    await searchRecomputeTrigger(search.id);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "error",
        scope: "searches.recompute.failed",
        searchId: search.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Remap Prisma's "record not found" (P2025) to a tRPC NOT_FOUND; rethrow else. */
function searchNotFound(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Search not found" });
  }
  throw error;
}

// The outreach loop (launch → discover → review → guarded send) is the
// OPERATOR's compliance-governed engine: it cold-emails estate agents on the
// shared sending domain under one global warmup budget + kill-switch + sign-off
// profile. Multi-user does NOT fan that out — a non-operator can manage their
// own searches/listings/settings but cannot drive sends. Those three procedures
// use `operatorProcedure` (FORBIDDEN for a non-operator); the CRUD surface uses
// `protectedProcedure` and scopes by ownerKeyFor(ctx.user).

export const searchesRouter = router({
  list: protectedProcedure.query(async ({ ctx }): Promise<SearchRow[]> => {
    return searchRepository.list(ownerKeyFor(ctx.user));
  }),

  getById: protectedProcedure
    .input(searchByIdInputSchema)
    .query(async ({ ctx, input }): Promise<SearchRow> => {
      const row = await searchRepository.getById(input.id, ownerKeyFor(ctx.user));
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Search not found" });
      }
      return row;
    }),

  create: protectedProcedure
    .input(searchCreateInputSchema)
    .mutation(async ({ ctx, input }): Promise<SearchRow> => {
      const ownerId = ownerKeyFor(ctx.user);
      const created = await searchRepository.create(
        {
          name: input.name,
          location: input.location,
          types: input.types,
          condition: input.condition,
          land: input.land,
          saleMethods: input.saleMethods,
          minBedrooms: input.minBedrooms ?? null,
          maxPricePence: input.maxPricePence ?? null,
          keywords: input.keywords,
          status: input.status,
        },
        ownerId,
      );
      // Score the catalogue against the new search's taste (operator + active).
      await maybeTriggerRecompute(ownerId, created);
      return created;
    }),

  update: protectedProcedure
    .input(searchUpdateInputSchema)
    .mutation(async ({ ctx, input }): Promise<SearchRow> => {
      const ownerId = ownerKeyFor(ctx.user);
      // Pre-check existence (scoped to the owner) so a missing/foreign id maps
      // to NOT_FOUND rather than a raw Prisma P2025 → INTERNAL_SERVER_ERROR.
      const existing = await searchRepository.getById(input.id, ownerId);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Search not found" });
      }
      const updated = await searchRepository.update(
        {
          id: input.id,
          name: input.name,
          location: input.location,
          types: input.types,
          condition: input.condition,
          land: input.land,
          saleMethods: input.saleMethods,
          minBedrooms: input.minBedrooms ?? null,
          maxPricePence: input.maxPricePence ?? null,
          keywords: input.keywords,
          status: input.status,
        },
        ownerId,
      );
      // Re-rank against the (possibly changed) taste (operator + active).
      await maybeTriggerRecompute(ownerId, updated);
      return updated;
    }),

  /**
   * DELETE a search as a CASCADE (design + operator ask: "removing a search hides
   * those listings and completely removes the agents"). Delegates to
   * search-removal.service, which atomically: HIDES the search's homes for the
   * owner (per-user DismissedListing rows — restorable, never deleted), and — for
   * the OPERATOR only — COMPLETELY removes the agents the search found that no
   * other search still covers (GDPR erasure cascading their threads + messages),
   * then deletes the search row. Returns the cascade counts so the SPA can echo
   * what happened. P2025 (missing/foreign id) → NOT_FOUND, as before.
   */
  delete: protectedProcedure
    .input(searchByIdInputSchema)
    .mutation(async ({ ctx, input }): Promise<SearchRemovalResult> => {
      const ownerId = ownerKeyFor(ctx.user);
      try {
        return await searchRemovalCascade({
          searchId: input.id,
          ownerId,
          isOperator: ownerId === null,
        });
      } catch (error) {
        return searchNotFound(error);
      }
    }),

  /**
   * PREVIEW the delete cascade for the confirm dialog (no mutation): how many
   * homes will be hidden + how many agents will be completely removed (0 for a
   * non-operator). Owner-scoped; P2025 → NOT_FOUND.
   */
  removalPreview: protectedProcedure
    .input(searchByIdInputSchema)
    .query(async ({ ctx, input }): Promise<SearchRemovalPreview> => {
      const ownerId = ownerKeyFor(ctx.user);
      try {
        return await searchRemovalPreviewer({
          searchId: input.id,
          ownerId,
          isOperator: ownerId === null,
        });
      } catch (error) {
        return searchNotFound(error);
      }
    }),

  setStatus: protectedProcedure
    .input(searchSetStatusInputSchema)
    .mutation(async ({ ctx, input }): Promise<SearchRow> => {
      const ownerId = ownerKeyFor(ctx.user);
      try {
        const updated = await searchRepository.setStatus(
          input.id,
          input.status,
          ownerId,
        );
        // Resuming a search (→ active) re-scores its patch; pausing is a no-op.
        await maybeTriggerRecompute(ownerId, updated);
        return updated;
      } catch (error) {
        return searchNotFound(error);
      }
    }),

  /**
   * LAUNCH a search's discovery: resolve the search, then enqueue ONE
   * discover:agents over its target outcodes (the M7 pipeline, taking outcodes
   * directly). A search with no outcodes is a BAD_REQUEST (nothing to target).
   * Discovery only SOURCES agents — no send fires here. Returns the enqueued
   * flag + the outcodes targeted (so the UI can echo the patch).
   */
  launch: operatorProcedure
    .input(searchByIdInputSchema)
    .mutation(async ({ input }): Promise<SearchLaunchResult> => {
      const search = await searchRepository.getById(input.id, null);
      if (!search) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Search not found" });
      }
      if (search.outcodes.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "search has no target outcodes",
        });
      }
      await discoverAgentsEnqueuer({
        idempotencyKey: `discover:agents:search:${search.id}`,
        // `regionName` is the search's human place name — it drives the discovery
        // web-search query ("estate agents in <location>, UK"); `outcodes` is what
        // gets stamped onto the discovered agents so reviewDrafts can match them.
        payload: { regionName: search.location, outcodes: search.outcodes },
      });
      return { enqueued: true, outcodes: search.outcodes };
    }),

  /**
   * REVIEW the outreach drafts before any send: build the search-tailored draft
   * (draftSearchEmail) and, for every agent in the search's patch, run the
   * ComplianceGuard PRECHECK (reserve:false — peeks, never consumes a token). A
   * blocked agent is returned with eligible=false + the ComplianceCode reason;
   * an eligible one with reason=null. NOTHING is sent — this is the operator's
   * review surface. A non-ComplianceError rethrows (a real fault, not a block).
   */
  reviewDrafts: operatorProcedure
    .input(searchByIdInputSchema)
    .query(async ({ input }): Promise<SearchReviewDraftsResult> => {
      const search = await searchRepository.getById(input.id, null);
      if (!search) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Search not found" });
      }
      // Resolve the buyer identity so the reviewed draft is signed + paced
      // exactly like the email the worker will send (operator profile = null).
      const profile = await reviewProfileRepository.getOrCreate(null);
      const sender = resolveSender(profile, currentSenderName());
      const draft = draftSearchEmail(search, sender);
      // Page the ENTIRE patch — a single list() call clamps to 100 and would hide
      // (and so make un-approvable) every agent past the first page.
      const patchAgents = await collectPatchAgents(search.outcodes);
      const agents: SearchReviewAgent[] = [];
      for (const agent of patchAgents) {
        const guardAgent: AgentForGuard = {
          id: agent.id,
          email: agent.email,
          mailboxType: agent.mailboxType,
          optedOut: agent.optedOut,
        };
        try {
          await searchComplianceGuard.assertCanSend(guardAgent, {
            reserve: false,
          });
          agents.push({
            id: agent.id,
            email: agent.email,
            agencyName: agent.agencyName,
            eligible: true,
            reason: null,
          });
        } catch (error) {
          if (error instanceof ComplianceError) {
            agents.push({
              id: agent.id,
              email: agent.email,
              agencyName: agent.agencyName,
              eligible: false,
              reason: error.code,
            });
            continue;
          }
          throw error;
        }
      }
      return { draft, agents };
    }),

  /**
   * APPROVE the operator-selected sends: enqueue one guarded outreach:send per
   * agent id, each carrying the searchId so the worker drafts from the search's
   * brief. The send is STILL guarded at the worker (assertCanSend reserve:true) —
   * approval is consent, not a guard bypass. Returns the count enqueued.
   */
  approveSends: operatorProcedure
    .input(searchApproveSendsInputSchema)
    .mutation(async ({ input }): Promise<SearchApproveSendsResult> => {
      for (const agentId of input.agentIds) {
        await searchOutreachSendEnqueuer({
          // Scope the key to (search, agent) so a generic outreach:send to the
          // same agent can't swallow this search approval (and re-approving the
          // same search+agent stays idempotent).
          idempotencyKey: `outreach:send:search:${input.id}:${agentId}`,
          payload: { agentId, searchId: input.id },
        });
      }
      return { enqueued: input.agentIds.length };
    }),

  /**
   * Per-search stats for the launch dashboard: homes found in the patch (listings
   * whose outcode ∈ search.outcodes), agents in the patch (agents covering any of
   * the outcodes), and agents already contacted (lastContactedAt != null).
   */
  stats: protectedProcedure
    .input(searchByIdInputSchema)
    .query(async ({ ctx, input }): Promise<SearchStatsResult> => {
      const search = await searchRepository.getById(input.id, ownerKeyFor(ctx.user));
      if (!search) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Search not found" });
      }
      const [homesFound, agentsInPatch, agentsContacted] = await Promise.all([
        searchListingRepository.countByOutcodes(search.outcodes),
        searchAgentRepository.countByOutcodes(search.outcodes),
        searchAgentRepository.countByOutcodes(search.outcodes, {
          contactedOnly: true,
        }),
      ]);
      return { homesFound, agentsInPatch, agentsContacted };
    }),
});
