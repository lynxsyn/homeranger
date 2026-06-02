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
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

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

/**
 * jose error `code`s that represent an EXPECTED JWT-verification failure (the
 * token is bad / not for us): bad signature, expiry, wrong issuer/audience,
 * malformed JWT/JWS, no matching key in the JWKS, disallowed/unsupported alg.
 * These resolve to "no identity" → UNAUTHORIZED (401).
 *
 * Everything else thrown out of `jwtVerify` — `JWKSTimeout`
 * (`ERR_JWKS_TIMEOUT`), the bare `JOSEError` (`ERR_JOSE_GENERIC`) jose raises on
 * a non-200 JWKS HTTP response or a JWKS JSON-parse failure, and any raw
 * fetch/network error with no jose code — is a genuine INFRA fault. Those
 * RETHROW so tRPC surfaces a 500 (fail-loud on a CF certs outage instead of
 * silently denying every user). Mirrors the Doxus expected-vs-infra split.
 */
const EXPECTED_JWT_ERROR_CODES: ReadonlySet<string> = new Set([
  errors.JWTClaimValidationFailed.code, // ERR_JWT_CLAIM_VALIDATION_FAILED
  errors.JWTExpired.code, // ERR_JWT_EXPIRED
  errors.JWTInvalid.code, // ERR_JWT_INVALID
  errors.JWSInvalid.code, // ERR_JWS_INVALID
  errors.JWSSignatureVerificationFailed.code, // ERR_JWS_SIGNATURE_VERIFICATION_FAILED
  errors.JWKSNoMatchingKey.code, // ERR_JWKS_NO_MATCHING_KEY
  errors.JWKSMultipleMatchingKeys.code, // ERR_JWKS_MULTIPLE_MATCHING_KEYS
  errors.JOSEAlgNotAllowed.code, // ERR_JOSE_ALG_NOT_ALLOWED
  errors.JOSENotSupported.code, // ERR_JOSE_NOT_SUPPORTED (alg-confusion path)
]);

/** True when `err` is an expected JWT-verification failure (→ UNAUTHORIZED). */
function isExpectedVerificationError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && EXPECTED_JWT_ERROR_CODES.has(code);
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
      // CF Access exclusively signs assertions with RS256 — pin it
      // (defense-in-depth against alg-confusion; jose's JWKS kty mapping
      // already blocks it, this makes the contract explicit).
      algorithms: ["RS256"],
    });
    payload = verified.payload;
  } catch (err: unknown) {
    // Expected JWT-verification failure → wrap to CfAccessVerificationError so
    // the caller resolves null → UNAUTHORIZED. A genuine JWKS infra fault
    // (fetch/network/non-200/timeout) RETHROWS so tRPC surfaces a 500.
    if (!isExpectedVerificationError(err)) {
      throw err;
    }
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
