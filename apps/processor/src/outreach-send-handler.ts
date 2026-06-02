/**
 * outreach:send consumer — the authoritative send path. OutreachService
 * re-runs the ComplianceGuard (reserve:true, consuming a warm-up token), drafts,
 * sends with an Idempotency-Key, and persists. A non-retryable ComplianceError
 * (PECR/opt-out/suppression/breaker/kill) drops the job; a retryable one
 * (warm-up cap / Redis unavailable) backs off and retries.
 */
import type { OutreachSendJobPayload } from "@homescout/backend-core/lib/queue/queue-config";
import type { OutreachService } from "@homescout/backend-core/services/outreach.service";
import { toWorkerError } from "./worker-error.js";

export interface OutreachSendHandlerDeps {
  outreachService: OutreachService;
}

export function makeOutreachSendHandler(deps: OutreachSendHandlerDeps) {
  return async function handleOutreachSend(job: {
    data: OutreachSendJobPayload;
  }): Promise<void> {
    try {
      await deps.outreachService.sendOutreach({
        agentId: job.data.agentId,
        // Tie the send to a launched scout so the body is drafted from its brief.
        ...(job.data.scoutId ? { scoutId: job.data.scoutId } : {}),
      });
    } catch (error) {
      throw toWorkerError(error, {
        scope: "outreach.send.failed",
        agentId: job.data.agentId,
        ...(job.data.scoutId ? { scoutId: job.data.scoutId } : {}),
      });
    }
  };
}
