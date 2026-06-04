/**
 * Recompute triggers for the per-search match-scoring pipeline. A trigger
 * enqueues a SINGLE bounded `analyze:recompute` job; the worker runs
 * PreferenceMatchService.recomputeSearch (one search) or recomputeAll (every
 * active operator search), each bounded to the top-K re-score.
 *
 * This deliberately does NOT enqueue an analyze:listing job per listing — that
 * would fan out one paid LLM/embedding job per row. BullMQ dedupes the fixed
 * jobId so rapid successive edits collapse to one in-flight recompute. Redis I/O
 * (excluded from unit coverage like the rest of the queue layer).
 */
import { enqueueRecompute } from "./queue-client.js";

/**
 * Re-rank EVERY active operator search (no searchId). Kept as the
 * preferences.update side effect (operator settings change → refresh scores);
 * BullMQ dedupes the fixed jobId so concurrent saves collapse to one run.
 */
export async function triggerProfileRecompute(): Promise<void> {
  await enqueueRecompute({
    idempotencyKey: "analyze:recompute:all",
    payload: { reason: "profile-updated" },
  });
}

/** Re-rank ONE search's top-K (a search was created / edited / resumed). */
export async function triggerSearchRecompute(searchId: string): Promise<void> {
  await enqueueRecompute({
    idempotencyKey: `analyze:recompute:search:${searchId}`,
    payload: { searchId, reason: "search-updated" },
  });
}
