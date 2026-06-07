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
 *     re-hitting Claude; log it + increment `homeranger_inbound_dropped_total`.
 *   - retryable (or an unknown/untyped error → treated as retryable, the
 *     conservative transient-safe default) → rethrow so the backoff retries run.
 */
import { UnrecoverableError } from "bullmq";
import { inboundDroppedTotal } from "@homeranger/backend-core/lib/queue/queue-metrics";
import type { ResendHydrator } from "@homeranger/backend-core/lib/inbound/resend-hydrator";
import type {
  InboundIngestionService,
  IngestInboundEmailResult,
} from "@homeranger/backend-core/services/inbound-ingestion.service";
import {
  isUnsubscribeIntent,
  type OutreachReplyService,
} from "@homeranger/backend-core/services/outreach-reply.service";
import { extractReplyText } from "@homeranger/backend-core/lib/inbound/reply-text";
import type { InboundEmailJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";

/** Duck-type the `retryable` flag so this works for BOTH InboundIngestionError
 *  (service) and ExtractionError (provider) without importing either class.
 *  Unknown/untyped errors default to retryable (transient-safe). */
function isRetryable(error: unknown): boolean {
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  return typeof flag === "boolean" ? flag : true;
}

/** Hard manual off-switch for ALL inbound extraction (EXTRACTION_KILL_SWITCH),
 *  mirroring the analysis + outreach kill-switches — the operator's brake. */
function extractionKillSwitchOn(): boolean {
  return (
    process.env.EXTRACTION_KILL_SWITCH === "1" ||
    process.env.EXTRACTION_KILL_SWITCH === "true"
  );
}

export interface InboundHandlerDeps {
  hydrator: ResendHydrator;
  inboundIngestionService: InboundIngestionService;
  /** M6: links a listing-bearing agent reply back to its OutreachThread. */
  outreachReplyService?: OutreachReplyService;
}

/** Build the inbound job handler bound to its (injectable) dependencies. */
export function makeInboundHandler(deps: InboundHandlerDeps) {
  return async function handleInbound(job: {
    data: InboundEmailJobPayload;
  }): Promise<void> {
    try {
      const hydrated = await deps.hydrator.hydrate(job.data);
      // M6 AC#5 — compliance opt-out FIRST, BEFORE billing Claude. A STOP/
      // unsubscribe reply MUST suppress; this is NOT swallowed, so a transient
      // failure retries the job (handleOptOut is idempotent + runs pre-ingestion,
      // so a retry does not re-bill the extractor). No-op for a normal reply.
      if (deps.outreachReplyService) {
        await deps.outreachReplyService.handleOptOut(hydrated);
      }

      // Budget guardrail: decide whether this inbound warrants the PAID Claude
      // extraction. We gate ONLY the extraction — the reply is still recorded on
      // its thread (linkReply, below) in every case. Skip when:
      //   - the kill-switch is set (operator's hard brake on ALL extraction), or
      //   - there is nothing to extract — a clear opt-out (STOP/unsubscribe) or
      //     an empty reply (all quoted history) — UNLESS it carries an attachment
      //     (a PDF brochure may hold a listing).
      const hasAttachments = (hydrated.attachments?.length ?? 0) > 0;
      const nothingToExtract =
        !hasAttachments &&
        (isUnsubscribeIntent(hydrated.bodyText) ||
          extractReplyText(hydrated.bodyText) === "");
      const killSwitch = extractionKillSwitchOn();
      // Skip the PAID extraction for mail NOT from a tracked agent — DMARC
      // aggregate reports, autoresponders, and other catch-all noise would
      // otherwise bill Claude on their attachments (and linkReply no-ops for
      // them anyway). Defaults to true when no reply service is wired (so we
      // never over-skip a real reply on that basis).
      const fromTrackedAgent =
        (await deps.outreachReplyService?.isReplyFromTrackedAgent?.(
          hydrated,
        )) ?? true;
      const skipExtraction =
        killSwitch || nothingToExtract || !fromTrackedAgent;

      let result: IngestInboundEmailResult | null = null;
      if (skipExtraction) {
        console.info(
          JSON.stringify({
            type: "info",
            scope: "inbound.extraction_skipped",
            reason: killSwitch
              ? "kill_switch"
              : !fromTrackedAgent
                ? "not_tracked_agent"
                : "nothing_to_extract",
            emailId: job.data.email_id,
          }),
        );
      } else {
        result =
          await deps.inboundIngestionService.ingestInboundEmail(hydrated);
      }

      // M6 AC#4 — link the reply to its OutreachThread (best-effort: a link blip
      // must NOT trigger a retry that re-bills Claude). Runs even when extraction
      // was skipped so an opt-out/empty reply is still recorded + the thread
      // closed/advanced; a null result means no listing was parsed. Skipped when
      // the sender isn't a tracked agent.
      if (deps.outreachReplyService) {
        try {
          await deps.outreachReplyService.linkReply(hydrated, result);
        } catch (linkError) {
          console.error(
            JSON.stringify({
              type: "error",
              scope: "outreach.reply.link_failed",
              emailId: job.data.email_id,
              message:
                linkError instanceof Error
                  ? linkError.message
                  : String(linkError),
            }),
          );
        }
      }
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
