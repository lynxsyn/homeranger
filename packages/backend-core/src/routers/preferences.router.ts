/**
 * preferencesRouter (M5 spec AC#3 surface + #4 backfill trigger) — the
 * signed-in user's SearchProfile read/update path.
 *
 *   - get    : the caller's profile (getOrCreate — never 404s).
 *   - update : partial update of the profile, then (operator only) fire the
 *              analysis backfill so every listing is re-scored.
 *
 * Per-user scoping: the profile is keyed by `ownerKeyFor(ctx.user)` — NULL for
 * the operator (the singleton row the AI-matching engine reads), the user's id
 * otherwise. The recompute backfill is GATED to the operator: the global
 * listing catalogue is scored against the OPERATOR's preferenceEmbedding, so a
 * non-operator saving their settings must not thrash the matching pipeline (per-
 * user matching is a future enhancement — their settings are still stored).
 *
 * Like listingsRouter this is a pure read/write with no business logic between
 * the wire and storage, so it calls `searchProfileRepository` directly (the
 * repository IS the service for this surface). The backfill is a swappable
 * module-level seam (`_setProfileChangeTriggerForTesting`) so the unit test can
 * assert it fires without a live queue, mirroring the repository test setters.
 */
import { searchProfileUpdateSchema } from "@homeranger/shared";
import { protectedProcedure, router } from "../trpc.js";
import {
  searchProfileRepository,
  type SearchProfileRecord,
} from "../repositories/search-profile.repository.js";
import { triggerProfileRecompute } from "../lib/queue/analyze-backfill.js";
import { ownerKeyFor } from "../lib/auth/supabase-auth.js";

export type PreferencesPayload = SearchProfileRecord;

// Backfill seam: the default enqueues a single bounded top-K recompute job; the
// unit test swaps in a spy via `_setProfileChangeTriggerForTesting`.
let profileChangeTrigger: () => Promise<unknown> = triggerProfileRecompute;

export function _setProfileChangeTriggerForTesting(
  trigger: (() => Promise<unknown>) | null,
): void {
  profileChangeTrigger = trigger ?? triggerProfileRecompute;
}

export const preferencesRouter = router({
  get: protectedProcedure.query(async ({ ctx }): Promise<PreferencesPayload> => {
    return searchProfileRepository.getOrCreate(ownerKeyFor(ctx.user));
  }),

  update: protectedProcedure
    .input(searchProfileUpdateSchema)
    .mutation(async ({ ctx, input }): Promise<PreferencesPayload> => {
      const ownerId = ownerKeyFor(ctx.user);
      const updated = await searchProfileRepository.update(input, ownerId);
      // Re-score every listing against the new preferences (AC#4) — OPERATOR
      // only: the matching pipeline scores the global catalogue against the
      // operator's embedding, so a non-operator's save stores their settings
      // without triggering a global recompute. Best-effort: a queue hiccup must
      // not fail the save, so log + swallow.
      if (ownerId === null) {
        try {
          await profileChangeTrigger();
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "error",
              scope: "preferences.backfill.failed",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      return updated;
    }),
});
