/**
 * The `analyze:recompute` job handler — runs the bounded top-K preference
 * re-rank (PreferenceMatchService.recompute) enqueued once per profile change.
 * Mirrors analyze-handler's poison-pill guard: a non-retryable provider error
 * (4xx) → UnrecoverableError (drop, no wasted retries/spend); transient → rethrow.
 */
import { UnrecoverableError } from "bullmq";
import { analysisDroppedTotal } from "@homeranger/backend-core/lib/ai/analysis-metrics";
import type { PreferenceMatchService } from "@homeranger/backend-core/services/preference-match.service";
import type { AnalyzeRecomputeJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";

function isRetryable(error: unknown): boolean {
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  return typeof flag === "boolean" ? flag : true;
}

export interface RecomputeHandlerDeps {
  preferenceMatchService: PreferenceMatchService;
}

export function makeRecomputeHandler(deps: RecomputeHandlerDeps) {
  return async function handleRecompute(job: {
    data: AnalyzeRecomputeJobPayload;
  }): Promise<void> {
    try {
      // searchId present → re-rank that one search; absent → all active searches.
      if (job.data.searchId) {
        await deps.preferenceMatchService.recomputeSearch(job.data.searchId);
      } else {
        await deps.preferenceMatchService.recomputeAll();
      }
    } catch (error) {
      if (!isRetryable(error)) {
        analysisDroppedTotal.inc();
        console.error(
          JSON.stringify({
            type: "error",
            scope: "recompute.dropped.non_retryable",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        throw new UnrecoverableError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  };
}
