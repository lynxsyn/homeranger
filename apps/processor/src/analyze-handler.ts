/**
 * The `analyze:listing` job handler, extracted from the side-effecting worker
 * bootstrap so its retry-classification logic is unit-testable WITHOUT a live
 * DB/Redis. Mirrors `inbound-handler.ts`:
 *   - NON-retryable (a missing listing / a 4xx provider error, both carrying
 *     `retryable: false`) → `UnrecoverableError` so BullMQ moves the job straight
 *     to `failed` without burning the remaining attempts or re-billing the LLM;
 *     log it + increment `homeranger_analysis_dropped_total`.
 *   - retryable (429/5xx/transient, or an unknown/untyped error → treated as
 *     retryable, the transient-safe default) → rethrow so the backoff retries run.
 */
import { UnrecoverableError } from "bullmq";
import { analysisDroppedTotal } from "@homeranger/backend-core/lib/ai/analysis-metrics";
import type { ListingAnalysisService } from "@homeranger/backend-core/services/listing-analysis.service";
import type { AnalyzeListingJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";

/** Duck-type the `retryable` flag (works for ListingAnalysisError + ProviderError). */
function isRetryable(error: unknown): boolean {
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  return typeof flag === "boolean" ? flag : true;
}

export interface AnalyzeHandlerDeps {
  listingAnalysisService: ListingAnalysisService;
}

export function makeAnalyzeHandler(deps: AnalyzeHandlerDeps) {
  return async function handleAnalyze(job: {
    data: AnalyzeListingJobPayload;
  }): Promise<void> {
    try {
      await deps.listingAnalysisService.analyzeListing(job.data.listingId);
    } catch (error) {
      if (!isRetryable(error)) {
        analysisDroppedTotal.inc();
        console.error(
          JSON.stringify({
            type: "error",
            scope: "analyze.dropped.non_retryable",
            listingId: job.data.listingId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        throw new UnrecoverableError(
          error instanceof Error ? error.message : String(error),
        );
      }
      // Transient (429/5xx/network) → rethrow so BullMQ retries with backoff.
      throw error;
    }
  };
}
