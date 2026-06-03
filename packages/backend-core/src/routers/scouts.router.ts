/**
 * scoutsRouter — the M8 scout (saved buyer brief) CRUD surface.
 *
 * Single `protectedProcedure` surface (one user, no tenant scoping):
 *   - list     : all scouts, most-recently-updated first.
 *   - getById  : a single scout, NOT_FOUND on miss.
 *   - create   : a new scout (outcodes resolved server-side from location).
 *   - update   : full-replace an existing scout, NOT_FOUND on miss.
 *   - delete   : remove a scout, echoes `{ id }`.
 *   - setStatus: toggle active ⇄ paused.
 *
 * NO SERVICE LAYER — like listingsRouter, this is a pure CRUD path with no
 * business logic between the wire and storage (the only derivation, outcode
 * resolution, lives in the repository). The router calls `scoutRepository`
 * directly. The shared input schemas are `.strict()`, so no stray field slips
 * through; the repository derives `outcodes` from `location` (the form has no
 * outcodes field).
 *
 * Every returned row is a full `ScoutRecord` carrying all DB columns, so the SPA
 * infers the scout shape via `inferRouterOutputs`.
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
  scoutApproveSendsInputSchema,
  scoutByIdInputSchema,
  scoutCreateInputSchema,
  scoutSetStatusInputSchema,
  scoutUpdateInputSchema,
} from "@homeranger/shared";
import { operatorProcedure, protectedProcedure, router } from "../trpc.js";
import { ownerKeyFor } from "../lib/auth/supabase-auth.js";
import {
  scoutRepository,
  type ScoutRecord,
} from "../repositories/scout.repository.js";
import {
  agentRepository,
  type AgentRepository,
} from "../repositories/agent.repository.js";
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
import { draftScoutEmail } from "../lib/scouts/scout-brief.js";
import {
  searchProfileRepository as defaultSearchProfileRepository,
  type SearchProfileRepository,
} from "../repositories/search-profile.repository.js";
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

/** A single scout row as the procedures return it. */
export type ScoutRow = ScoutRecord;

// ── Swappable seams (mirror outreach.router's _set*ForTesting pattern) so unit
// tests assert the launch loop without a live Redis or DB. The guard +
// agent/listing repos default to the real singletons; tests inject fakes.
let scoutComplianceGuard: ComplianceGuard = defaultComplianceGuard;
export function _setScoutComplianceGuardForTesting(
  guard: ComplianceGuard | null,
): void {
  scoutComplianceGuard = guard ?? defaultComplianceGuard;
}

let scoutAgentRepository: AgentRepository = agentRepository;
export function _setScoutAgentRepositoryForTesting(
  repo: AgentRepository | null,
): void {
  scoutAgentRepository = repo ?? agentRepository;
}

let scoutListingRepository: ListingRepository = listingRepository;
export function _setScoutListingRepositoryForTesting(
  repo: ListingRepository | null,
): void {
  scoutListingRepository = repo ?? listingRepository;
}

// The buyer profile drives the reviewed draft's sign-off + urgency so the
// operator reviews EXACTLY what gets sent. Swappable so the router unit test
// asserts reviewDrafts without a live DB.
let scoutSearchProfileRepository: SearchProfileRepository =
  defaultSearchProfileRepository;
export function _setScoutSearchProfileRepositoryForTesting(
  repo: SearchProfileRepository | null,
): void {
  scoutSearchProfileRepository = repo ?? defaultSearchProfileRepository;
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
let scoutOutreachSendEnqueuer: OutreachSendEnqueuer = enqueueOutreachSend;
export function _setScoutOutreachSendEnqueuerForTesting(
  enqueuer: OutreachSendEnqueuer | null,
): void {
  scoutOutreachSendEnqueuer = enqueuer ?? enqueueOutreachSend;
}

/** One reviewed agent: eligible iff the ComplianceGuard precheck passes. */
export interface ScoutReviewAgent {
  id: string;
  email: string;
  agencyName: string | null;
  eligible: boolean;
  /** The ComplianceCode that blocked it (null when eligible). */
  reason: string | null;
}

export interface ScoutLaunchResult {
  enqueued: boolean;
  outcodes: string[];
}

export interface ScoutReviewDraftsResult {
  draft: string;
  agents: ScoutReviewAgent[];
}

export interface ScoutApproveSendsResult {
  enqueued: number;
}

export interface ScoutStatsResult {
  homesFound: number;
  agentsInPatch: number;
  agentsContacted: number;
}

/** Remap Prisma's "record not found" (P2025) to a tRPC NOT_FOUND; rethrow else. */
function scoutNotFound(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
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

export const scoutsRouter = router({
  list: protectedProcedure.query(async ({ ctx }): Promise<ScoutRow[]> => {
    return scoutRepository.list(ownerKeyFor(ctx.user));
  }),

  getById: protectedProcedure
    .input(scoutByIdInputSchema)
    .query(async ({ ctx, input }): Promise<ScoutRow> => {
      const row = await scoutRepository.getById(input.id, ownerKeyFor(ctx.user));
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
      }
      return row;
    }),

  create: protectedProcedure
    .input(scoutCreateInputSchema)
    .mutation(async ({ ctx, input }): Promise<ScoutRow> => {
      return scoutRepository.create(
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
        ownerKeyFor(ctx.user),
      );
    }),

  update: protectedProcedure
    .input(scoutUpdateInputSchema)
    .mutation(async ({ ctx, input }): Promise<ScoutRow> => {
      const ownerId = ownerKeyFor(ctx.user);
      // Pre-check existence (scoped to the owner) so a missing/foreign id maps
      // to NOT_FOUND rather than a raw Prisma P2025 → INTERNAL_SERVER_ERROR.
      const existing = await scoutRepository.getById(input.id, ownerId);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
      }
      return scoutRepository.update(
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
    }),

  delete: protectedProcedure
    .input(scoutByIdInputSchema)
    .mutation(async ({ ctx, input }): Promise<{ id: string }> => {
      try {
        return await scoutRepository.delete(input.id, ownerKeyFor(ctx.user));
      } catch (error) {
        return scoutNotFound(error);
      }
    }),

  setStatus: protectedProcedure
    .input(scoutSetStatusInputSchema)
    .mutation(async ({ ctx, input }): Promise<ScoutRow> => {
      try {
        return await scoutRepository.setStatus(
          input.id,
          input.status,
          ownerKeyFor(ctx.user),
        );
      } catch (error) {
        return scoutNotFound(error);
      }
    }),

  /**
   * LAUNCH a scout's discovery: resolve the scout, then enqueue ONE
   * discover:agents over its target outcodes (the M7 pipeline, taking outcodes
   * directly). A scout with no outcodes is a BAD_REQUEST (nothing to target).
   * Discovery only SOURCES agents — no send fires here. Returns the enqueued
   * flag + the outcodes targeted (so the UI can echo the patch).
   */
  launch: operatorProcedure
    .input(scoutByIdInputSchema)
    .mutation(async ({ input }): Promise<ScoutLaunchResult> => {
      const scout = await scoutRepository.getById(input.id, null);
      if (!scout) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
      }
      if (scout.outcodes.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "scout has no target outcodes",
        });
      }
      await discoverAgentsEnqueuer({
        idempotencyKey: `discover:agents:scout:${scout.id}`,
        // `regionName` is the scout's human place name — it drives the discovery
        // web-search query ("estate agents in <location>, UK"); `outcodes` is what
        // gets stamped onto the discovered agents so reviewDrafts can match them.
        payload: { regionName: scout.location, outcodes: scout.outcodes },
      });
      return { enqueued: true, outcodes: scout.outcodes };
    }),

  /**
   * REVIEW the outreach drafts before any send: build the scout-tailored draft
   * (draftScoutEmail) and, for every agent in the scout's patch, run the
   * ComplianceGuard PRECHECK (reserve:false — peeks, never consumes a token). A
   * blocked agent is returned with eligible=false + the ComplianceCode reason;
   * an eligible one with reason=null. NOTHING is sent — this is the operator's
   * review surface. A non-ComplianceError rethrows (a real fault, not a block).
   */
  reviewDrafts: operatorProcedure
    .input(scoutByIdInputSchema)
    .query(async ({ input }): Promise<ScoutReviewDraftsResult> => {
      const scout = await scoutRepository.getById(input.id, null);
      if (!scout) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
      }
      // Resolve the buyer identity so the reviewed draft is signed + paced
      // exactly like the email the worker will send (operator profile = null).
      const profile = await scoutSearchProfileRepository.getOrCreate(null);
      const sender = resolveSender(profile, currentSenderName());
      const draft = draftScoutEmail(scout, sender);
      const { items } = await scoutAgentRepository.list({
        outcodes: scout.outcodes,
      });
      const agents: ScoutReviewAgent[] = [];
      for (const agent of items) {
        const guardAgent: AgentForGuard = {
          id: agent.id,
          email: agent.email,
          mailboxType: agent.mailboxType,
          optedOut: agent.optedOut,
        };
        try {
          await scoutComplianceGuard.assertCanSend(guardAgent, {
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
   * agent id, each carrying the scoutId so the worker drafts from the scout's
   * brief. The send is STILL guarded at the worker (assertCanSend reserve:true) —
   * approval is consent, not a guard bypass. Returns the count enqueued.
   */
  approveSends: operatorProcedure
    .input(scoutApproveSendsInputSchema)
    .mutation(async ({ input }): Promise<ScoutApproveSendsResult> => {
      for (const agentId of input.agentIds) {
        await scoutOutreachSendEnqueuer({
          // Scope the key to (scout, agent) so a generic outreach:send to the
          // same agent can't swallow this scout approval (and re-approving the
          // same scout+agent stays idempotent).
          idempotencyKey: `outreach:send:scout:${input.id}:${agentId}`,
          payload: { agentId, scoutId: input.id },
        });
      }
      return { enqueued: input.agentIds.length };
    }),

  /**
   * Per-scout stats for the launch dashboard: homes found in the patch (listings
   * whose outcode ∈ scout.outcodes), agents in the patch (agents covering any of
   * the outcodes), and agents already contacted (lastContactedAt != null).
   */
  stats: protectedProcedure
    .input(scoutByIdInputSchema)
    .query(async ({ ctx, input }): Promise<ScoutStatsResult> => {
      const scout = await scoutRepository.getById(input.id, ownerKeyFor(ctx.user));
      if (!scout) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scout not found" });
      }
      const [homesFound, agentsInPatch, agentsContacted] = await Promise.all([
        scoutListingRepository.countByOutcodes(scout.outcodes),
        scoutAgentRepository.countByOutcodes(scout.outcodes),
        scoutAgentRepository.countByOutcodes(scout.outcodes, {
          contactedOnly: true,
        }),
      ]);
      return { homesFound, agentsInPatch, agentsContacted };
    }),
});
