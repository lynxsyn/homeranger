/**
 * tRPC request context — builds `ctx.user` from the Supabase Auth access token.
 *
 * The SPA signs in with @supabase/supabase-js and sends the access token as
 * `Authorization: Bearer <jwt>`; this resolves it to `ctx.user = { id, email } |
 * null` (expected auth failures → `null` → UNAUTHORIZED at the procedure; a JWKS
 * infra error rethrows → 500). Mirrors the prior Cloudflare-Access context SHAPE
 * (read request → resolve identity → `ctx.user`); Supabase replaces CF Access as
 * the identity source so multiple users can sign in.
 *
 * The Supabase config is read from the environment ONCE at module load:
 *   - `SUPABASE_URL` set   → verify the Bearer token against the project JWKS.
 *   - `SUPABASE_URL` unset → DEV BYPASS (identity = the dev operator), the
 *     linchpin that lets local dev + Playwright E2E run authenticated with no
 *     real token.
 */
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import {
  readSupabaseAuthConfigFromEnv,
  resolveSupabaseIdentity,
  type SupabaseAuthConfig,
  type SupabaseIdentity,
} from "./lib/auth/supabase-auth.js";

// Resolved once per process. `null` = dev bypass (SUPABASE_URL unset); a set
// value means every request must present a verifiable Bearer token.
const supabaseAuthConfig: SupabaseAuthConfig | null =
  readSupabaseAuthConfigFromEnv();

export async function createContext({ req }: CreateFastifyContextOptions) {
  const user: SupabaseIdentity | null = await resolveSupabaseIdentity(
    req.headers.authorization,
    supabaseAuthConfig,
  );
  return { user };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
