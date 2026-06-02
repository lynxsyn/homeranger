/**
 * Enqueue helpers — re-exported from queue-client so callers can deep-import
 * either `@homescout/backend-core/lib/queue/enqueue` (intent-named) or
 * `.../queue-client` (the implementation). The webhook routes use these to
 * enqueue without importing bullmq types; the inbound-ingestion service uses
 * `enqueueAnalyzeListing` (via the AnalyzeListingEnqueuer seam) after each
 * Listing upsert.
 */
export {
  enqueueInboundEmail,
  enqueueResendEvent,
  enqueueAnalyzeListing,
  type EnqueueInput,
} from "./queue-client.js";
