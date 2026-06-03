/**
 * outreach:followup-scan consumer (M6 AC#2/#3) — the cadence PRODUCER the
 * scheduler drives. Lists awaiting_reply threads whose last activity predates
 * the follow-up cadence and fans out one outreach:followup per due thread. The
 * scan runs in the processor (DB access); the scheduler (Redis-only) just
 * registers the cadence. Thread status gates eligibility — a replied/closed
 * thread is never returned by listFollowupDue — so no separate reply check.
 *
 * The enqueue is keyed per (thread, UTC-day), so a scan re-run within the day
 * dedupes (BullMQ jobId) and a later cadence window sends a fresh follow-up.
 */
import {
  outreachRepository as defaultOutreachRepository,
  type OutreachRepository,
} from "@homeranger/backend-core/repositories/outreach.repository";
import { enqueueOutreachFollowup as defaultEnqueueFollowup } from "@homeranger/backend-core/lib/queue/queue-client";
import { getOutreachConfig } from "@homeranger/backend-core/services/outreach.service";
import type { OutreachFollowupScanJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";
import type { EnqueueInput } from "@homeranger/backend-core/lib/queue/queue-client";
import type { OutreachFollowupJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";
import { toWorkerError } from "./worker-error.js";

export interface FollowupScanHandlerDeps {
  outreachRepository?: OutreachRepository;
  enqueueFollowup?: (
    input: EnqueueInput<OutreachFollowupJobPayload>,
  ) => Promise<void>;
  /** Hours of silence before a follow-up is due (defaults to getOutreachConfig). */
  followupCadenceHours?: number;
  /** Max threads to fan out per scan (back-pressure). */
  limit?: number;
  now?: () => Date;
}

export function makeFollowupScanHandler(deps: FollowupScanHandlerDeps = {}) {
  const outreachRepository = deps.outreachRepository ?? defaultOutreachRepository;
  const enqueueFollowup = deps.enqueueFollowup ?? defaultEnqueueFollowup;
  const cadenceHours =
    deps.followupCadenceHours ?? getOutreachConfig().followupCadenceHours;
  const limit = deps.limit ?? 100;
  const now = deps.now ?? (() => new Date());

  return async function handleFollowupScan(_job: {
    data: OutreachFollowupScanJobPayload;
  }): Promise<void> {
    try {
      const at = now();
      const cutoff = new Date(at.getTime() - cadenceHours * 3_600_000);
      const dayKey = at.toISOString().slice(0, 10);
      const due = await outreachRepository.listFollowupDue({ cutoff, limit });
      for (const thread of due) {
        await enqueueFollowup({
          idempotencyKey: `outreach:followup:${thread.id}:${dayKey}`,
          payload: { threadId: thread.id },
        });
      }
      console.info(
        JSON.stringify({
          type: "info",
          scope: "outreach.followup.scan",
          due: due.length,
        }),
      );
    } catch (error) {
      throw toWorkerError(error, { scope: "outreach.followup.scan.failed" });
    }
  };
}
