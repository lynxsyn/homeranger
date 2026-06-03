/**
 * authRouter — the signed-in identity surface for the SPA.
 *
 *   - me : the verified Supabase identity `{ id, email, isOperator }`.
 *
 * The web client uses this to render the account menu (email + initials) and to
 * gate operator-only UI (the outreach launch/review/approve controls). It is a
 * `protectedProcedure`, so an unauthenticated request 401s — the same signal the
 * SPA's auth gate uses. `isOperator` is derived server-side from the configured
 * operator email so the frontend never needs to know that value.
 */
import { protectedProcedure, router } from "../trpc.js";
import { isOperator } from "../lib/auth/supabase-auth.js";

export interface MeResult {
  id: string;
  email: string;
  isOperator: boolean;
}

export const authRouter = router({
  me: protectedProcedure.query(({ ctx }): MeResult => {
    return {
      id: ctx.user.id,
      email: ctx.user.email,
      isOperator: isOperator(ctx.user.email),
    };
  }),
});
