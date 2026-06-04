/**
 * Supabase Auth JWT verifier — multi-user homeranger.
 *
 * Replaces the Cloudflare-Access single-user identity (lib/auth/cloudflare-access.ts)
 * as the tRPC identity source: the SPA signs in with @supabase/supabase-js
 * (email + password) and sends the resulting access token as
 * `Authorization: Bearer <jwt>`; this module verifies it and resolves
 * `ctx.user = { id, email } | null`.
 *
 * Mirrors the CF-Access verifier SHAPE verbatim (jose `createRemoteJWKSet` +
 * `jwtVerify`, an injectable `keyGetter` so tests run over a local key pair, and
 * the expected-vs-infra error split — a verification failure resolves to "no
 * identity" → UNAUTHORIZED; a genuine JWKS infra fault RETHROWS → 500). The
 * differences vs CF Access:
 *   - Supabase signs with ASYMMETRIC keys (this project's JWKS is ES256; RS256 is
 *     also accepted for forward-compat with key rotation). The public JWKS lives
 *     at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, so NO shared secret is
 *     needed at runtime — verification is fully local after the first JWKS fetch.
 *   - The identity is `{ id, email }`: `id` is the JWT `sub` (the Supabase user
 *     UUID, used as the per-user owner key); `email` drives the operator check.
 *   - Multi-user: there is NO single-allowed-email gate. Any user Supabase
 *     authenticates is a valid identity; the OPERATOR (the person whose email is
 *     OPERATOR_USER_EMAIL / ALLOWED_USER_EMAIL / DEV_USER_EMAIL) maps to the
 *     NULL owner namespace, everyone else to their own `id` namespace.
 *   - DEV BYPASS: when `SUPABASE_URL` is unset (local dev + Playwright E2E, no
 *     Supabase in front) the verifier short-circuits to the dev operator
 *     identity WITHOUT calling jose — the linchpin that lets the existing E2E
 *     suite run authenticated with no real token. A request that DOES carry a
 *     Bearer token while configured is verified for real.
 */
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

/** The per-request identity attached to `ctx.user`. */
export interface SupabaseIdentity {
  /** Supabase user UUID (JWT `sub`) — the per-user owner key. */
  id: string;
  email: string;
}

/** Default dev identity email when Supabase Auth is not configured. */
export const DEFAULT_DEV_USER_EMAIL = "dev@homeranger.local";

/**
 * Stable dev identity id (a valid UUID) used in the dev bypass. The operator
 * resolves to the NULL owner namespace, so this value is never written as a
 * `userId`; it only fills `ctx.user.id` for the bypassed request.
 */
export const DEFAULT_DEV_USER_ID = "00000000-0000-0000-0000-0000000000de";

/** The audience Supabase stamps on user access tokens. */
export const DEFAULT_SUPABASE_AUDIENCE = "authenticated";

export class SupabaseAuthVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseAuthVerificationError";
  }
}

/** Resolved configuration when Supabase Auth is enabled. */
export interface SupabaseAuthConfig {
  /** The GoTrue issuer — `${SUPABASE_URL}/auth/v1`. */
  issuer: string;
  /** Expected audience claim (defaults to "authenticated"). */
  audience: string;
  /** The JWKS endpoint — `${issuer}/.well-known/jwks.json`. */
  jwksUri: string;
  /**
   * Optional JWKS resolver. Defaults to a cached `createRemoteJWKSet` over
   * `jwksUri`. Tests inject a `createLocalJWKSet` so verification runs without
   * an outbound HTTPS request.
   */
  keyGetter?: JWTVerifyGetKey;
}

let cachedKeyGetter: JWTVerifyGetKey | null = null;
let cachedJwksUri: string | null = null;

function defaultKeyGetter(jwksUri: string): JWTVerifyGetKey {
  if (cachedKeyGetter && cachedJwksUri === jwksUri) {
    return cachedKeyGetter;
  }
  cachedKeyGetter = createRemoteJWKSet(new URL(jwksUri), {
    cacheMaxAge: 60 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  cachedJwksUri = jwksUri;
  return cachedKeyGetter;
}

export function resetSupabaseJwksCache(): void {
  cachedKeyGetter = null;
  cachedJwksUri = null;
}

/** The dev-user email, honouring `DEV_USER_EMAIL` with the locked default. */
export function devUserEmail(): string {
  return process.env.DEV_USER_EMAIL || DEFAULT_DEV_USER_EMAIL;
}

/** The dev-user id, honouring `DEV_USER_ID` with the locked default. */
export function devUserId(): string {
  return process.env.DEV_USER_ID || DEFAULT_DEV_USER_ID;
}

/**
 * The operator's email — the single identity whose data lives in the NULL owner
 * namespace (the legacy single-user rows + what the backend automation engine
 * reads). Resolution order: OPERATOR_USER_EMAIL → ALLOWED_USER_EMAIL (the
 * pre-multi-user single allowed user) → DEV_USER_EMAIL → the locked default.
 */
export function operatorEmail(): string {
  return (
    process.env.OPERATOR_USER_EMAIL ||
    process.env.ALLOWED_USER_EMAIL ||
    process.env.DEV_USER_EMAIL ||
    DEFAULT_DEV_USER_EMAIL
  );
}

/** True when `email` is the operator (case-insensitive). */
export function isOperator(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }
  return email.toLowerCase() === operatorEmail().toLowerCase();
}

/**
 * The owner key for a resolved identity: NULL for the operator (the default
 * namespace shared with the backend automation engine) or for an absent
 * identity; otherwise the user's Supabase id. This is the single chokepoint the
 * repository/router layer uses to scope every per-user read + write.
 */
export function ownerKeyFor(
  identity: SupabaseIdentity | null | undefined,
): string | null {
  if (!identity || isOperator(identity.email)) {
    return null;
  }
  return identity.id;
}

/**
 * Read the Supabase Auth configuration from the environment.
 *
 * Returns `null` (DEV BYPASS) when `SUPABASE_URL` is unset — local dev +
 * Playwright E2E only. In production an unset `SUPABASE_URL` instead THROWS:
 * the dev bypass resolves every request to the operator identity, so a deployed
 * pod that loses the var must refuse to serve rather than silently authenticate
 * all callers as the operator. Mirrors the RESEND_WEBHOOK_SECRET /
 * UNSUBSCRIBE_TOKEN_SECRET production fail-closed guards. When set, returns the
 * full config (issuer + JWKS uri + audience); a trailing slash is tolerated.
 */
export function readSupabaseAuthConfigFromEnv(): SupabaseAuthConfig | null {
  const rawUrl = process.env.SUPABASE_URL;
  if (!rawUrl) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SUPABASE_URL is required in production: refusing to start with the auth dev-bypass enabled",
      );
    }
    return null; // DEV BYPASS (local dev + Playwright E2E only)
  }
  const base = rawUrl.replace(/\/+$/, "");
  const issuer = `${base}/auth/v1`;
  return {
    issuer,
    audience: process.env.SUPABASE_JWT_AUD || DEFAULT_SUPABASE_AUDIENCE,
    jwksUri: `${issuer}/.well-known/jwks.json`,
  };
}

/**
 * jose error `code`s that represent an EXPECTED JWT-verification failure (the
 * token is bad / not for us). These resolve to "no identity" → UNAUTHORIZED
 * (401). Everything else thrown out of `jwtVerify` — a JWKS timeout, the bare
 * `JOSEError` jose raises on a non-200/parse JWKS response, or a raw network
 * error — is a genuine INFRA fault and RETHROWS so tRPC surfaces a 500 (fail
 * loud on a Supabase Auth outage instead of silently denying every user).
 */
const EXPECTED_JWT_ERROR_CODES: ReadonlySet<string> = new Set([
  errors.JWTClaimValidationFailed.code,
  errors.JWTExpired.code,
  errors.JWTInvalid.code,
  errors.JWSInvalid.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWKSMultipleMatchingKeys.code,
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
]);

function isExpectedVerificationError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && EXPECTED_JWT_ERROR_CODES.has(code);
}

function extractClaim(payload: JWTPayload, claim: "sub" | "email"): string {
  const raw = payload[claim];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new SupabaseAuthVerificationError(
      `Supabase JWT missing ${claim} claim`,
    );
  }
  return raw;
}

/**
 * Strip a `Bearer ` scheme (case-insensitive) from an Authorization header
 * value. A bare token (no scheme) is returned as-is. Empty/whitespace → "".
 */
export function extractBearerToken(
  header: string | string[] | undefined,
): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

/**
 * Verify a Supabase access token against `config` and return the identity.
 * Throws `SupabaseAuthVerificationError` on any expected failure (missing/
 * invalid token, wrong issuer/audience, missing sub/email claim).
 */
export async function verifySupabaseJwt(
  token: string,
  config: SupabaseAuthConfig,
): Promise<SupabaseIdentity> {
  if (!token) {
    throw new SupabaseAuthVerificationError("Supabase JWT missing");
  }

  const keyGetter = config.keyGetter ?? defaultKeyGetter(config.jwksUri);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, keyGetter, {
      issuer: config.issuer,
      audience: config.audience,
      // Supabase asymmetric signing keys are ES256 (this project) or RS256.
      // Pinning to the asymmetric algorithms is defense-in-depth against an
      // alg-confusion downgrade to the HS256 secret (which is never in the JWKS).
      algorithms: ["ES256", "RS256"],
    });
    payload = verified.payload;
  } catch (err: unknown) {
    if (!isExpectedVerificationError(err)) {
      throw err; // genuine JWKS infra fault → 500
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new SupabaseAuthVerificationError(`Supabase JWT invalid: ${reason}`);
  }

  return {
    id: extractClaim(payload, "sub"),
    email: extractClaim(payload, "email"),
  };
}

/**
 * Resolve the request identity from a raw `Authorization` header.
 *
 * - DEV BYPASS (no `config`): returns the dev operator identity
 *   `{ id: DEV_USER_ID, email: DEV_USER_EMAIL }`.
 * - Configured: verifies the Bearer token and returns the identity, or `null`
 *   on any expected verification failure (→ caller throws UNAUTHORIZED). A JWKS
 *   infra error RETHROWS (→ 500).
 */
export async function resolveSupabaseIdentity(
  authHeader: string | string[] | undefined,
  config: SupabaseAuthConfig | null,
): Promise<SupabaseIdentity | null> {
  if (config === null) {
    return { id: devUserId(), email: devUserEmail() };
  }

  const token = extractBearerToken(authHeader);
  try {
    return await verifySupabaseJwt(token, config);
  } catch (err) {
    if (err instanceof SupabaseAuthVerificationError) {
      return null; // expected auth failure → UNAUTHORIZED at the procedure
    }
    throw err; // infra error → 500
  }
}
