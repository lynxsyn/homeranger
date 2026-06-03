/**
 * outreach router (M6) — the request-side trigger for an outbound send. It runs
 * the ComplianceGuard PRECHECK (reserve:false — peeks the warm-up cap, never
 * consumes) and maps a ComplianceError to a TRPCError (AC#1's "typed TRPCError"
 * contract honoured at the transport boundary), then enqueues outreach:send.
 * The WORKER is the authoritative guard + send path (reserve:true). M7 adds
 * metrics + killSwitch.toggle alongside this.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { killSwitchToggleInputSchema } from "@homeranger/shared";
import { protectedProcedure, router } from "../trpc.js";
import { agentRepository } from "../repositories/agent.repository.js";
import {
  warmupStateRepository as defaultWarmupStateRepository,
  type WarmupStateRepository,
} from "../repositories/warmup-state.repository.js";
import {
  complianceGuard,
  ComplianceError,
  type AgentForGuard,
} from "../lib/compliance/compliance-guard.js";
import {
  enqueueOutreachSend,
  type EnqueueInput,
} from "../lib/queue/queue-client.js";
import type { OutreachSendJobPayload } from "../lib/queue/queue-config.js";

const sendInput = z.object({ agentEmail: z.email() });

export interface OutreachSendResult {
  enqueued: boolean;
  agentId: string;
}

// Swappable enqueue seam (mirrors preferences.router.ts) so a unit test can
// assert the enqueue without a live Redis.
type OutreachSendEnqueuer = (
  input: EnqueueInput<OutreachSendJobPayload>,
) => Promise<void>;
let outreachSendEnqueuer: OutreachSendEnqueuer = enqueueOutreachSend;
export function _setOutreachSendEnqueuerForTesting(
  enqueuer: OutreachSendEnqueuer | null,
): void {
  outreachSendEnqueuer = enqueuer ?? enqueueOutreachSend;
}

// Swappable warmup-state seam so the killSwitch sub-router is unit-testable
// without a live DB (mirrors the enqueue seam above).
let warmupStateRepository: WarmupStateRepository = defaultWarmupStateRepository;
export function _setWarmupStateRepositoryForTesting(
  repo: WarmupStateRepository | null,
): void {
  warmupStateRepository = repo ?? defaultWarmupStateRepository;
}

/** The global kill-switch state the operator reads + toggles. */
export interface KillSwitchState {
  enabled: boolean;
}

export const outreachRouter = router({
  send: protectedProcedure
    .input(sendInput)
    .mutation(async ({ input }): Promise<OutreachSendResult> => {
      const agent = await agentRepository.findByEmail(input.agentEmail);
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }
      const guardAgent: AgentForGuard = {
        id: agent.id,
        email: agent.email,
        mailboxType: agent.mailboxType,
        optedOut: agent.optedOut,
      };
      try {
        await complianceGuard.assertCanSend(guardAgent, { reserve: false });
      } catch (error) {
        if (error instanceof ComplianceError) {
          throw new TRPCError({ code: error.trpcCode, message: error.code });
        }
        throw error;
      }
      await outreachSendEnqueuer({
        idempotencyKey: `outreach:send:${agent.id}`,
        payload: { agentId: agent.id },
      });
      return { enqueued: true, agentId: agent.id };
    }),

  /**
   * Global send kill-switch (ComplianceGuard gate 5). `get` reads the current
   * WarmupState.killSwitch; `toggle` sets it. Flipping it ON halts ALL outbound
   * sends at once (the guard blocks every send with KILL_SWITCH) — the operator's
   * emergency brake. Idempotent on the value.
   */
  killSwitch: router({
    get: protectedProcedure.query(async (): Promise<KillSwitchState> => {
      const state = await warmupStateRepository.getOrCreate();
      return { enabled: state.killSwitch };
    }),

    toggle: protectedProcedure
      .input(killSwitchToggleInputSchema)
      .mutation(async ({ input }): Promise<KillSwitchState> => {
        const state = await warmupStateRepository.setKillSwitch(input.enabled);
        return { enabled: state.killSwitch };
      }),
  }),
});
