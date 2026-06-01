/**
 * Cursor-pagination primitives shared FE/BE.
 *
 * Mirrors the Doxus contract verbatim (`aide/rules/backend.md`: `{ items,
 * nextCursor }`, default 20 / max 100) and the exact zod shape from
 * `doxus .../packages/backend-core/src/schemas/scheduled-report.schema.ts`
 * (`paginationInputSchema` + `*ListOutputSchema`). Repositories in
 * `packages/backend-core` consume `paginationInputSchema` for their list
 * methods; `apps/web` infers the matching row/page types via
 * `inferRouterInputs`/`inferRouterOutputs` over the AppRouter rather than
 * importing these output schemas directly (the `scheduledReportTypes.ts`
 * precedent).
 */
import { z } from "zod";

/** Default page size when the client omits `limit`. */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard upper bound on page size; the repository never returns more. */
export const MAX_PAGE_SIZE = 100;

/**
 * Standard cursor-pagination input. `cursor` is an opaque forward token
 * (omit for the first page); `limit` defaults to 20 and is clamped to 100.
 * Matches `scheduled-report.schema.ts` exactly so the contract is identical
 * across both apps.
 */
export const paginationInputSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationInput = z.infer<typeof paginationInputSchema>;

/**
 * Build a `{ items, nextCursor }` output schema for a given item schema.
 * `nextCursor` is `null` on the final page (Doxus uses `.nullable()` rather
 * than `.optional()` so the field is always present on the wire).
 */
export function listOutputSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });
}
