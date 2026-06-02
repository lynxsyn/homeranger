/**
 * tRPC root for @homescout/backend-core (ROOT-level, Doxus convention).
 *
 * Mirrors doxus-web .../trpc.ts: `initTRPC.context<Context>().create({
 * transformer: superjson })` then export `router`, `publicProcedure`,
 * `protectedProcedure`, and `createCallerFactory`. The SPA's tRPC client MUST
 * set the SAME `transformer: superjson` on its link or Date/BigInt round-trips
 * silently corrupt.
 *
 * homescout simplifications vs Doxus: no Sentry middleware wrapper, no
 * tenant/role procedures (single user, no tenant scoping per M3 AC#1).
 */
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

/**
 * Guards on `ctx.user`. Throws `TRPCError UNAUTHORIZED` when the request
 * carried no valid Cloudflare Access identity. On success, narrows `ctx.user`
 * to non-null for downstream resolvers.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
