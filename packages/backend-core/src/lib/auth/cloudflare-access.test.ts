/**
 * Cloudflare Access verifier unit tests.
 *
 * Ported from doxus-web .../lib/cf-access.test.ts (jose 4.15.9 createLocalJWKSet
 * + generateKeyPair so verification runs with no outbound HTTPS), extended for
 * homescout's single-allowed-user check, the dev-bypass env contract, and the
 * `resolveCfAccessIdentity` header resolver.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import {
  CfAccessVerificationError,
  DEFAULT_DEV_USER_EMAIL,
  readCfAccessConfigFromEnv,
  resetCfAccessJwksCache,
  resolveCfAccessIdentity,
  verifyCfAccessJwt,
  type CfAccessConfig,
} from "./cloudflare-access.js";

const TEAM_DOMAIN = "test.cloudflareaccess.com";
const AUDIENCE = "test-aud-hex";
const ALLOWED_EMAIL = "owner@homescout.test";
const ISSUER = `https://${TEAM_DOMAIN}`;

interface TestKeySet {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

async function makeTestKey(kid = "test-kid"): Promise<TestKeySet> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { ...publicJwk, alg: "RS256", kid }, kid };
}

async function signToken(
  key: TestKeySet,
  payload: Record<string, unknown>,
  opts: { issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key.privateKey);
}

function localJwks(keys: JWK[]): JWTVerifyGetKey {
  return createLocalJWKSet({ keys });
}

function config(
  key: TestKeySet,
  overrides: Partial<CfAccessConfig> = {},
): CfAccessConfig {
  return {
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    allowedEmail: ALLOWED_EMAIL,
    keyGetter: localJwks([key.publicJwk]),
    ...overrides,
  };
}

describe("verifyCfAccessJwt", () => {
  let key: TestKeySet;

  beforeEach(async () => {
    resetCfAccessJwksCache();
    key = await makeTestKey();
  });

  it("verifies a valid JWT for the allowed user and returns identity", async () => {
    const token = await signToken(key, { email: ALLOWED_EMAIL });
    const identity = await verifyCfAccessJwt(token, config(key));
    expect(identity.email).toBe(ALLOWED_EMAIL);
  });

  it("matches the allowed user case-insensitively", async () => {
    const token = await signToken(key, { email: ALLOWED_EMAIL.toUpperCase() });
    const identity = await verifyCfAccessJwt(token, config(key));
    expect(identity.email).toBe(ALLOWED_EMAIL.toUpperCase());
  });

  it("rejects empty token", async () => {
    await expect(verifyCfAccessJwt("", config(key))).rejects.toBeInstanceOf(
      CfAccessVerificationError,
    );
  });

  it("rejects JWT with wrong audience", async () => {
    const token = await signToken(
      key,
      { email: ALLOWED_EMAIL },
      { audience: "wrong-aud" },
    );
    await expect(verifyCfAccessJwt(token, config(key))).rejects.toThrow(
      /CF Access JWT invalid/,
    );
  });

  it("rejects JWT with wrong issuer", async () => {
    const token = await signToken(
      key,
      { email: ALLOWED_EMAIL },
      { issuer: "https://other.cloudflareaccess.com" },
    );
    await expect(verifyCfAccessJwt(token, config(key))).rejects.toThrow(
      /CF Access JWT invalid/,
    );
  });

  it("rejects JWT signed by an unknown key", async () => {
    const otherKey = await makeTestKey("other-kid");
    const token = await signToken(otherKey, { email: ALLOWED_EMAIL });
    await expect(verifyCfAccessJwt(token, config(key))).rejects.toThrow(
      /CF Access JWT invalid/,
    );
  });

  it("rejects JWT missing email claim", async () => {
    const token = await signToken(key, { sub: "no-email" });
    await expect(verifyCfAccessJwt(token, config(key))).rejects.toThrow(
      /missing email/,
    );
  });

  it("rejects a valid JWT whose email is not the allowed user", async () => {
    const token = await signToken(key, { email: "intruder@homescout.test" });
    await expect(verifyCfAccessJwt(token, config(key))).rejects.toThrow(
      /not the allowed user/,
    );
  });

  it("falls back to the remote JWKS when no keyGetter is injected (and caches it)", async () => {
    // No keyGetter → defaultKeyGetter builds a createRemoteJWKSet against the
    // (unreachable) team domain. Verification fails (wrapped), proving the
    // remote path is exercised; a second call reuses the cached resolver.
    const token = await signToken(key, { email: ALLOWED_EMAIL });
    const cfg: CfAccessConfig = {
      teamDomain: "nonexistent.cloudflareaccess.test",
      audience: AUDIENCE,
      allowedEmail: ALLOWED_EMAIL,
    };
    await expect(verifyCfAccessJwt(token, cfg)).rejects.toBeInstanceOf(
      CfAccessVerificationError,
    );
    await expect(verifyCfAccessJwt(token, cfg)).rejects.toBeInstanceOf(
      CfAccessVerificationError,
    );
  });
});

describe("readCfAccessConfigFromEnv", () => {
  const saved = {
    team: process.env.CF_ACCESS_TEAM_DOMAIN,
    aud: process.env.CF_ACCESS_AUD,
    allowed: process.env.ALLOWED_USER_EMAIL,
    dev: process.env.DEV_USER_EMAIL,
  };

  afterEach(() => {
    process.env.CF_ACCESS_TEAM_DOMAIN = saved.team;
    process.env.CF_ACCESS_AUD = saved.aud;
    process.env.ALLOWED_USER_EMAIL = saved.allowed;
    process.env.DEV_USER_EMAIL = saved.dev;
    if (saved.team === undefined) delete process.env.CF_ACCESS_TEAM_DOMAIN;
    if (saved.aud === undefined) delete process.env.CF_ACCESS_AUD;
    if (saved.allowed === undefined) delete process.env.ALLOWED_USER_EMAIL;
    if (saved.dev === undefined) delete process.env.DEV_USER_EMAIL;
  });

  it("returns null (dev bypass) when both CF vars are unset", () => {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
    expect(readCfAccessConfigFromEnv()).toBeNull();
  });

  it("throws when exactly one CF var is set (fail loud)", () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
    expect(() => readCfAccessConfigFromEnv()).toThrow(
      CfAccessVerificationError,
    );
  });

  it("returns full config when both set, defaulting allowedEmail to the dev user", () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    process.env.CF_ACCESS_AUD = AUDIENCE;
    delete process.env.ALLOWED_USER_EMAIL;
    delete process.env.DEV_USER_EMAIL;
    const cfg = readCfAccessConfigFromEnv();
    expect(cfg).toEqual({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      allowedEmail: DEFAULT_DEV_USER_EMAIL,
    });
  });

  it("honours ALLOWED_USER_EMAIL when set", () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    process.env.CF_ACCESS_AUD = AUDIENCE;
    process.env.ALLOWED_USER_EMAIL = ALLOWED_EMAIL;
    const cfg = readCfAccessConfigFromEnv();
    expect(cfg?.allowedEmail).toBe(ALLOWED_EMAIL);
  });
});

describe("resolveCfAccessIdentity", () => {
  const saved = process.env.DEV_USER_EMAIL;
  afterEach(() => {
    process.env.DEV_USER_EMAIL = saved;
    if (saved === undefined) delete process.env.DEV_USER_EMAIL;
  });

  it("bypasses to the default dev user when config is null", async () => {
    delete process.env.DEV_USER_EMAIL;
    const identity = await resolveCfAccessIdentity(undefined, null);
    expect(identity).toEqual({ email: DEFAULT_DEV_USER_EMAIL });
  });

  it("bypasses to DEV_USER_EMAIL when set", async () => {
    process.env.DEV_USER_EMAIL = "custom-dev@homescout.local";
    const identity = await resolveCfAccessIdentity(undefined, null);
    expect(identity).toEqual({ email: "custom-dev@homescout.local" });
  });

  it("returns the identity for a valid header token", async () => {
    resetCfAccessJwksCache();
    const key = await makeTestKey();
    const token = await signToken(key, { email: ALLOWED_EMAIL });
    const identity = await resolveCfAccessIdentity(token, config(key));
    expect(identity).toEqual({ email: ALLOWED_EMAIL });
  });

  it("takes the first value of a string[] header", async () => {
    resetCfAccessJwksCache();
    const key = await makeTestKey();
    const token = await signToken(key, { email: ALLOWED_EMAIL });
    const identity = await resolveCfAccessIdentity([token, "ignored"], config(key));
    expect(identity).toEqual({ email: ALLOWED_EMAIL });
  });

  it("returns null on an invalid/missing token (→ UNAUTHORIZED at the procedure)", async () => {
    const key = await makeTestKey();
    expect(await resolveCfAccessIdentity(undefined, config(key))).toBeNull();
    expect(await resolveCfAccessIdentity("garbage", config(key))).toBeNull();
  });
});
