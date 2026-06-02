/**
 * Cloudflare Access JWT verifier — single-user homescout.
 *
 * Mirrors the Doxus verifier (doxus-web .../lib/cf-access.ts) verbatim in shape:
 * jose 4.15.9 `createRemoteJWKSet` + `jwtVerify`, an injectable `keyGetter` so
 * tests can supply a `createLocalJWKSet` over a generated key pair, and the
 * expected-vs-infra error split (a verification failure resolves to "no
 * identity" → the procedure throws UNAUTHORIZED; an infra error rethrows).
 *
 * homescout differences vs Doxus:
 *   - Single allowed user (`ALLOWED_USER_EMAIL`), no tenant/role lookup. The
 *     verified `email` claim must match `ALLOWED_USER_EMAIL` (case-insensitive)
 *     or the identity is rejected.
 *   - DEV BYPASS: when BOTH `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are
 *     unset (local dev + Playwright E2E, no Cloudflare in front), the verifier
 *     short-circuits to `{ email: DEV_USER_EMAIL }` WITHOUT calling jose. This
 *     is the linchpin that lets E2E run authenticated with no real Access
 *     token. When EXACTLY ONE is set, we THROW — a half-configured prod env
 *     fails loudly rather than silently bypassing.
 */
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

/** The single-request identity attached to `ctx.user`. */
export interface CfAccessIdentity {
  email: string;
}

/** Default dev identity when no Cloudflare Access is configured. */
export const DEFAULT_DEV_USER_EMAIL = "dev@homescout.local";

/** Lower-cased request header Cloudflare injects on every proxied request. */
export const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export class CfAccessVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfAccessVerificationError";
  }
}

/** Resolved configuration when Cloudflare Access is enabled. */
export interface CfAccessConfig {
  teamDomain: string;
  audience: string;
  /** The single allowed user; the `email` claim must match (case-insensitive). */
  allowedEmail: string;
  /**
   * Optional JWKS resolver. Defaults to the remote CF Access certs endpoint
   * for `teamDomain`. Tests inject a `createLocalJWKSet` so verification runs
   * without an outbound HTTPS request.
   */
  keyGetter?: JWTVerifyGetKey;
}

let cachedKeyGetter: JWTVerifyGetKey | null = null;
let cachedTeamDomain: string | null = null;

function defaultKeyGetter(teamDomain: string): JWTVerifyGetKey {
  if (cachedKeyGetter && cachedTeamDomain === teamDomain) {
    return cachedKeyGetter;
  }
  cachedKeyGetter = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    {
      cacheMaxAge: 60 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    },
  );
  cachedTeamDomain = teamDomain;
  return cachedKeyGetter;
}

export function resetCfAccessJwksCache(): void {
  cachedKeyGetter = null;
  cachedTeamDomain = null;
}

/** The dev-user email, honouring `DEV_USER_EMAIL` with the locked default. */
export function devUserEmail(): string {
  return process.env.DEV_USER_EMAIL || DEFAULT_DEV_USER_EMAIL;
}

/**
 * Read the CF Access configuration from the environment.
 *
 * Returns `null` (DEV BYPASS) when BOTH `CF_ACCESS_TEAM_DOMAIN` and
 * `CF_ACCESS_AUD` are unset. THROWS when exactly one is set (fail loud — a
 * half-configured prod env must not silently bypass auth). When both are set,
 * returns the full config (with `ALLOWED_USER_EMAIL`, defaulting to the dev
 * user when unset).
 */
export function readCfAccessConfigFromEnv(): CfAccessConfig | null {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const audience = process.env.CF_ACCESS_AUD;

  const hasTeam = Boolean(teamDomain);
  const hasAud = Boolean(audience);

  if (!hasTeam && !hasAud) {
    return null; // DEV BYPASS
  }
  if (hasTeam !== hasAud) {
    throw new CfAccessVerificationError(
      "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together " +
        "(set both for Cloudflare Access, or neither for dev bypass)",
    );
  }

  return {
    teamDomain: teamDomain!,
    audience: audience!,
    allowedEmail: process.env.ALLOWED_USER_EMAIL || devUserEmail(),
  };
}

function extractEmail(payload: JWTPayload): string {
  const raw = payload["email"];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CfAccessVerificationError("CF Access JWT missing email claim");
  }
  return raw;
}

/**
 * Verify a Cloudflare Access JWT against `config` and return the identity.
 * Throws `CfAccessVerificationError` on any failure (missing/invalid token,
 * wrong issuer/audience, missing email claim, or email not the allowed user).
 */
export async function verifyCfAccessJwt(
  token: string,
  config: CfAccessConfig,
): Promise<CfAccessIdentity> {
  if (!token) {
    throw new CfAccessVerificationError("CF Access JWT missing");
  }

  const keyGetter = config.keyGetter ?? defaultKeyGetter(config.teamDomain);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, keyGetter, {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
    });
    payload = verified.payload;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CfAccessVerificationError(`CF Access JWT invalid: ${reason}`);
  }

  const email = extractEmail(payload);
  if (email.toLowerCase() !== config.allowedEmail.toLowerCase()) {
    throw new CfAccessVerificationError(
      "CF Access JWT email is not the allowed user",
    );
  }

  return { email };
}

/**
 * Resolve the request identity from a raw `cf-access-jwt-assertion` header.
 *
 * - DEV BYPASS (no `config`): returns `{ email: DEV_USER_EMAIL }`.
 * - Configured: verifies the JWT and returns the identity, or `null` on any
 *   verification failure (expected auth failure → caller throws UNAUTHORIZED).
 *
 * The header may be a string or string[] (Fastify normalises duplicates); we
 * take the first value.
 */
export async function resolveCfAccessIdentity(
  rawHeader: string | string[] | undefined,
  config: CfAccessConfig | null,
): Promise<CfAccessIdentity | null> {
  if (config === null) {
    return { email: devUserEmail() };
  }

  const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  try {
    return await verifyCfAccessJwt(token ?? "", config);
  } catch (err) {
    if (err instanceof CfAccessVerificationError) {
      return null; // expected auth failure → UNAUTHORIZED at the procedure
    }
    throw err; // infra error → 500
  }
}
