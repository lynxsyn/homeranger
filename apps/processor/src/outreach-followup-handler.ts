/**
 * outreach:followup consumer — sends a follow-up on an awaiting_reply thread.
 * Same guard re-check + idempotency + error mapping as outreach:send.
 */
import type { OutreachFollowupJobPayload } from "@homescout/backend-core/lib/queue/queue-config";
import type { OutreachService } from "@homescout/backend-core/services/outreach.service";
import { toWorkerError } from "./worker-error.js";

export interface OutreachFollowupHandlerDeps {
  outreachService: OutreachService;
}

export function makeOutreachFollowupHandler(deps: OutreachFollowupHandlerDeps) {
  return async function handleOutreachFollowup(job: {
    data: OutreachFollowupJobPayload;
  }): Promise<void> {
    try {
      await deps.outreachService.sendFollowup({ threadId: job.data.threadId });
    } catch (error) {
      throw toWorkerError(error, {
        scope: "outreach.followup.failed",
        threadId: job.data.threadId,
      });
    }
  };
}
