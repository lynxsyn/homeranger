/**
 * The `outreach:inbound` job handler, extracted from the side-effecting worker
 * bootstrap (worker.ts) so its retry-classification logic is unit-testable
 * WITHOUT a live DB/Redis.
 *
 * Poison-pill guard (M4 review fix): the InboundIngestionService + the Claude
 * extraction provider throw typed errors carrying a `retryable` flag (false for
 * malformed JSON / 4xx / programming errors; true for 429/5xx/transient
 * R2/Resend). BullMQ retries EVERY thrown error up to `attempts:3` with backoff
 * — so a deterministically-failing email would burn all 3 retries AND re-bill
 * Claude 3×. We honour the flag here:
 *   - NON-retryable → throw `UnrecoverableError` so BullMQ moves the job
 *     straight to `failed` WITHOUT consuming the remaining attempts and without
 *     re-hitting Claude; log it + increment `homescout_inbound_dropped_total`.
 *   - retryable (or an unknown/untyped error → treated as retryable, the
 *     conservative transient-safe default) → rethrow so the backoff retries run.
 */
import { UnrecoverableError } from "bullmq";
import { inboundDroppedTotal } from "@homescout/backend-core/lib/queue/queue-metrics";
import type { ResendHydrator } from "@homescout/backend-core/lib/inbound/resend-hydrator";
import type { InboundIngestionService } from "@homescout/backend-core/services/inbound-ingestion.service";
import type { InboundEmailJobPayload } from "@homescout/backend-core/lib/queue/queue-config";

/** Duck-type the `retryable` flag so this works for BOTH InboundIngestionError
 *  (service) and ExtractionError (provider) without importing either class.
 *  Unknown/untyped errors default to retryable (transient-safe). */
function isRetryable(error: unknown): boolean {
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  return typeof flag === "boolean" ? flag : true;
}

export interface InboundHandlerDeps {
  hydrator: ResendHydrator;
  inboundIngestionService: InboundIngestionService;
}

/** Build the inbound job handler bound to its (injectable) dependencies. */
export function makeInboundHandler(deps: InboundHandlerDeps) {
  return async function handleInbound(job: {
    data: InboundEmailJobPayload;
  }): Promise<void> {
    try {
      const hydrated = await deps.hydrator.hydrate(job.data);
      await deps.inboundIngestionService.ingestInboundEmail(hydrated);
    } catch (error) {
      if (!isRetryable(error)) {
        // Drop the poison pill — NO secrets / PII bodies in the log, only the
        // email id + the error message.
        inboundDroppedTotal.inc();
        console.error(
          JSON.stringify({
            type: "error",
            scope: "inbound.dropped.non_retryable",
            emailId: job.data.email_id,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        throw new UnrecoverableError(
          error instanceof Error ? error.message : String(error),
        );
      }
      // Transient (429/5xx/R2/Resend) → rethrow so BullMQ retries with backoff.
      throw error;
    }
  };
}
