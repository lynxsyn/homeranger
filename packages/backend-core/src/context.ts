/**
 * tRPC request context — builds `ctx.user` from the Cloudflare Access JWT.
 *
 * Mirrors the Doxus context.ts SHAPE (read request → resolve identity →
 * `ctx.user = {...} | null`; expected auth failures become `null` →
 * UNAUTHORIZED at the procedure; infra errors rethrow → 500) but swaps the
 * SuperTokens session lookup for Cloudflare Access JWT verification.
 *
 * The CF Access config is read from the environment ONCE at module load:
 *   - both CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD set → verify the JWT.
 *   - neither set → DEV BYPASS (identity = { email: DEV_USER_EMAIL }).
 *   - exactly one set → readCfAccessConfigFromEnv throws (fail loud).
 */
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import {
  CF_ACCESS_JWT_HEADER,
  readCfAccessConfigFromEnv,
  resolveCfAccessIdentity,
  type CfAccessConfig,
  type CfAccessIdentity,
} from "./lib/auth/cloudflare-access.js";

// Resolved once per process. `readCfAccessConfigFromEnv` throws on a
// half-configured env, so a misconfigured prod deploy fails fast at startup
// (the first context build) rather than silently bypassing auth.
const cfAccessConfig: CfAccessConfig | null = readCfAccessConfigFromEnv();

export async function createContext({ req }: CreateFastifyContextOptions) {
  const rawHeader = req.headers[CF_ACCESS_JWT_HEADER];
  const user: CfAccessIdentity | null = await resolveCfAccessIdentity(
    rawHeader,
    cfAccessConfig,
  );
  return { user };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
