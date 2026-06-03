/**
 * locationsRouter — UK location type-ahead for the scout location field.
 *
 * A single read-only `protectedProcedure`:
 *   - suggest({ q, limit? }): bundled-index suggestions for what the operator is
 *     typing — counties, unitaries/districts, regions (country), postcode areas
 *     & districts, towns. Each suggestion carries the outcodes it resolves to,
 *     so the form can show the catchment a scout would target before saving.
 *
 * NO SERVICE LAYER and NO DB: the index is in-memory (lib/geo/uk-locations.ts),
 * so this is a pure, deterministic, offline lookup — the resolver is what the
 * repository also uses to derive a scout's outcodes from its saved location.
 */
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.js";
import {
  suggestLocations,
  type LocationSuggestion,
} from "../lib/geo/uk-locations.js";

const locationSuggestInputSchema = z
  .object({
    // Bounded + trimmed to match the scout-location convention — the type-ahead
    // never needs more, and an unbounded operator string is needless surface.
    q: z.string().trim().max(64),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const locationsRouter = router({
  suggest: protectedProcedure
    .input(locationSuggestInputSchema)
    .query(({ input }): LocationSuggestion[] =>
      suggestLocations(input.q, input.limit ?? 8),
    ),
});
