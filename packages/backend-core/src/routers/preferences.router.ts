/**
 * preferencesRouter (M5 spec AC#3 surface + #4 backfill trigger) — the single
 * SearchProfile's read/update path.
 *
 *   - get    : the one profile (getOrCreate — never 404s).
 *   - update : partial update of the profile, then fire the analysis backfill so
 *              every listing is re-scored against the new preferences.
 *
 * Like listingsRouter this is a pure read/write with no business logic between
 * the wire and storage, so it calls `searchProfileRepository` directly (the
 * repository IS the service for this surface). The backfill is a swappable
 * module-level seam (`_setProfileChangeTriggerForTesting`) so the unit test can
 * assert it fires without a live queue, mirroring the repository test setters.
 */
import { searchProfileUpdateSchema } from "@homescout/shared";
import { protectedProcedure, router } from "../trpc.js";
import {
  searchProfileRepository,
  type SearchProfileRecord,
} from "../repositories/search-profile.repository.js";
import { backfillAnalyzeAll } from "../lib/queue/analyze-backfill.js";

export type PreferencesPayload = SearchProfileRecord;

// Backfill seam: the default re-enqueues analyze:listing for every listing; the
// unit test swaps in a spy via `_setProfileChangeTriggerForTesting`.
let profileChangeTrigger: () => Promise<unknown> = backfillAnalyzeAll;

export function _setProfileChangeTriggerForTesting(
  trigger: (() => Promise<unknown>) | null,
): void {
  profileChangeTrigger = trigger ?? backfillAnalyzeAll;
}

export const preferencesRouter = router({
  get: protectedProcedure.query(async (): Promise<PreferencesPayload> => {
    return searchProfileRepository.getOrCreate();
  }),

  update: protectedProcedure
    .input(searchProfileUpdateSchema)
    .mutation(async ({ input }): Promise<PreferencesPayload> => {
      const updated = await searchProfileRepository.update(input);
      // Re-score every listing against the new preferences (AC#4). Best-effort:
      // a queue hiccup must not fail the save, so log + swallow.
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
      return updated;
    }),
});
