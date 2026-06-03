/**
 * tRPC root for @homeranger/backend-core (ROOT-level, Doxus convention).
 *
 * Mirrors doxus-web .../trpc.ts: `initTRPC.context<Context>().create({
 * transformer: superjson })` then export `router`, `publicProcedure`,
 * `protectedProcedure`, and `createCallerFactory`. The SPA's tRPC client MUST
 * set the SAME `transformer: superjson` on its link or Date/BigInt round-trips
 * silently corrupt.
 *
 * homeranger simplifications vs Doxus: no Sentry middleware wrapper, no
 * tenant/role procedures. Multi-user via Supabase Auth: `ctx.user` is the
 * verified Supabase identity `{ id, email }` (see context.ts); per-user data is
 * scoped in the repository layer by `ownerKeyFor(ctx.user)`, not by RLS.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context.js";
import { ownerKeyFor } from "./lib/auth/supabase-auth.js";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

/**
 * Guards on `ctx.user`. Throws `TRPCError UNAUTHORIZED` when the request
 * carried no valid Supabase identity. On success, narrows `ctx.user` to
 * non-null for downstream resolvers.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Operator-only procedure. The single chokepoint for the compliance-governed
 * automation engine (the outreach loop + the global send kill-switch + warm-up):
 * these act on ONE shared sending domain / warm-up budget / kill-switch, so they
 * must NOT fan out to every signed-in user. `ownerKeyFor(ctx.user) === null`
 * means the operator (the NULL data namespace the engine reads); any other
 * authenticated user is FORBIDDEN. This is the server-side boundary behind the
 * UI's `isOperator`-gated controls — UI hiding is not a security boundary.
 */
export const operatorProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ownerKeyFor(ctx.user) !== null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Operator only" });
  }
  return next({ ctx });
});
