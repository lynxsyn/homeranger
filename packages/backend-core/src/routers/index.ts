/**
 * appRouter — the single tRPC router tree for homeranger.
 *
 * ROOT-level structure (Doxus convention): `router({ listings, health })`.
 * `AppRouter` is the type the SPA infers over via `inferRouterOutputs`. New
 * milestones add sibling routers here (M4 ingestion, M6/M7 outreach).
 */
import { publicProcedure, router } from "../trpc.js";
import { authRouter } from "./auth.router.js";
import { listingsRouter } from "./listings.router.js";
import { preferencesRouter } from "./preferences.router.js";
import { outreachRouter } from "./outreach.router.js";
import { searchesRouter } from "./searches.router.js";
import { agentsRouter } from "./agents.router.js";
import { locationsRouter } from "./locations.router.js";
import { sourcesRouter } from "./sources.router.js";

export const appRouter = router({
  /** Unauthenticated liveness probe usable through the tRPC client. */
  health: publicProcedure.query(() => ({
    service: "homeranger-api" as const,
    status: "ok" as const,
  })),

  auth: authRouter,
  listings: listingsRouter,
  preferences: preferencesRouter,
  outreach: outreachRouter,
  searches: searchesRouter,
  agents: agentsRouter,
  locations: locationsRouter,
  sources: sourcesRouter,
});

export type AppRouter = typeof appRouter;
