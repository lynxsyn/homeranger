/**
 * Profile-change recompute trigger for the M5 analysis pipeline (the "backfill
 * trigger" half of AC#4). When the SearchProfile changes, enqueue a SINGLE
 * `analyze:recompute` job; the worker runs PreferenceMatchService.recompute(),
 * which is bounded to the top-K re-score (AC#3/#5).
 *
 * This deliberately does NOT enqueue an analyze:listing job per listing — that
 * would fan out one paid LLM/embedding job per row (unbounded on a large
 * corpus). The single recompute job re-ranks the most-relevant candidates at a
 * bounded cost, and BullMQ dedupes the fixed jobId so rapid successive profile
 * edits collapse to one in-flight recompute. Redis I/O (excluded from unit
 * coverage like the rest of the queue layer); exercised by the preferences path.
 */
import { enqueueRecompute } from "./queue-client.js";

/** Enqueue the single bounded top-K recompute job for a profile change. */
export async function triggerProfileRecompute(): Promise<void> {
  await enqueueRecompute({
    idempotencyKey: "analyze:recompute:profile",
    payload: { reason: "profile-updated" },
  });
}
