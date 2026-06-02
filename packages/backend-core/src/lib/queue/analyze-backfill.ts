/**
 * Backfill trigger for the M5 analysis pipeline. Re-enqueues `analyze:listing`
 * for EVERY listing so scores are recomputed against the current SearchProfile
 * — the "backfill trigger" half of AC#4 (the other half being the M4 inbound
 * upsert). Called by `preferencesRouter.update` after the profile changes.
 *
 * Enqueue is idempotent (BullMQ dedupes on the jobId), so re-running while jobs
 * are still queued is a no-op. Redis I/O (excluded from unit coverage like the
 * rest of the queue layer); exercised by the preferences E2E path.
 */
import { listingRepository } from "../../repositories/listing.repository.js";
import { enqueueAnalyzeListing } from "./queue-client.js";

/** Enqueue analyze:listing for every listing; returns the count enqueued. */
export async function backfillAnalyzeAll(): Promise<number> {
  const ids = await listingRepository.listAllIds();
  for (const id of ids) {
    await enqueueAnalyzeListing({
      idempotencyKey: `analyze:listing:${id}`,
      payload: { listingId: id },
    });
  }
  return ids.length;
}
