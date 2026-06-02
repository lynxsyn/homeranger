/**
 * warmup:recalc consumer — enqueued on a cadence by the scheduler (leader-lock).
 * Ramps the daily cap + reconciles the window counter. Idempotent; recalc errors
 * are retryable (a transient DB blip).
 */
import type { WarmupRecalcJobPayload } from "@homescout/backend-core/lib/queue/queue-config";
import type { WarmupService } from "@homescout/backend-core/services/warmup.service";
import { toWorkerError } from "./worker-error.js";

export interface WarmupRecalcHandlerDeps {
  warmupService: WarmupService;
}

export function makeWarmupRecalcHandler(deps: WarmupRecalcHandlerDeps) {
  return async function handleWarmupRecalc(_job: {
    data: WarmupRecalcJobPayload;
  }): Promise<void> {
    try {
      await deps.warmupService.recalc();
    } catch (error) {
      throw toWorkerError(error, { scope: "warmup.recalc.failed" });
    }
  };
}
