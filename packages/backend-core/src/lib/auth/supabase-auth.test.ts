/**
 * Supabase Auth verifier unit tests.
 *
 * Mirrors cloudflare-access.test.ts (jose createLocalJWKSet + generateKeyPair so
 * verification runs with no outbound HTTPS), retargeted to Supabase's ES256
 * asymmetric keys, the `{ id, email }` identity (sub + email claims), the
 * operator / owner-key helpers, and the dev-bypass env contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import {
  DEFAULT_DEV_USER_EMAIL,
  DEFAULT_DEV_USER_ID,
  extractBearerToken,
  isOperator,
  operatorEmail,
  ownerKeyFor,
  readSupabaseAuthConfigFromEnv,
  resetSupabaseJwksCache,
  resolveSupabaseIdentity,
  SupabaseAuthVerificationError,
  verifySupabaseJwt,
  type SupabaseAuthConfig,
} from "./supabase-auth.js";

const SUPABASE_URL = "https://test.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
const AUDIENCE = "authenticated";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const USER_EMAIL = "user@homeranger.test";

interface TestKeySet {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

async function makeTestKey(
  kid = "test-kid",
  alg: "ES256" | "RS256" = "ES256",
): Promise<TestKeySet> {
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { ...publicJwk, alg, kid }, kid };
}

async function signToken(
  key: TestKeySet,
  payload: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; alg?: "ES256" | "RS256" } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: opts.alg ?? "ES256", kid: key.kid })
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
  overrides: Partial<SupabaseAuthConfig> = {},
): SupabaseAuthConfig {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: JWKS_URI,
    keyGetter: localJwks([key.publicJwk]),
    ...overrides,
  };
}

describe("verifySupabaseJwt", () => {
  let key: TestKeySet;

  beforeEach(async () => {
    resetSupabaseJwksCache();
    key = await makeTestKey();
  });

  it("verifies a valid token and returns { id, email }", async () => {
    const token = await signToken(key, { sub: USER_ID, email: USER_EMAIL });
    const identity = await verifySupabaseJwt(token, config(key));
    expect(identity).toEqual({ id: USER_ID, email: USER_EMAIL });
  });

  it("accepts an RS256-signed token (forward-compat key rotation)", async () => {
    const rsKey = await makeTestKey("rs-kid", "RS256");
    const token = await signToken(
      rsKey,
      { sub: USER_ID, email: USER_EMAIL },
      { alg: "RS256" },
    );
    const identity = await verifySupabaseJwt(
      token,
      config(rsKey, { keyGetter: localJwks([rsKey.publicJwk]) }),
    );
    expect(identity).toEqual({ id: USER_ID, email: USER_EMAIL });
  });

  it("rejects an empty token", async () => {
    await expect(verifySupabaseJwt("", config(key))).rejects.toBeInstanceOf(
      SupabaseAuthVerificationError,
    );
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await signToken(
      key,
      { sub: USER_ID, email: USER_EMAIL },
      { audience: "anon" },
    );
    await expect(verifySupabaseJwt(token, config(key))).rejects.toThrow(
      /Supabase JWT invalid/,
    );
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await signToken(
      key,
      { sub: USER_ID, email: USER_EMAIL },
      { issuer: "https://evil.supabase.co/auth/v1" },
    );
    await expect(verifySupabaseJwt(token, config(key))).rejects.toThrow(
      /Supabase JWT invalid/,
    );
  });

  it("rejects a token signed by an unknown key", async () => {
    const otherKey = await makeTestKey("other-kid");
    const token = await signToken(otherKey, { sub: USER_ID, email: USER_EMAIL });
    await expect(verifySupabaseJwt(token, config(key))).rejects.toThrow(
      /Supabase JWT invalid/,
    );
  });

  it("rejects a token missing the sub claim", async () => {
    const token = await signToken(key, { email: USER_EMAIL });
    await expect(verifySupabaseJwt(token, config(key))).rejects.toThrow(
      /missing sub/,
    );
  });

  it("rejects a token missing the email claim", async () => {
    const token = await signToken(key, { sub: USER_ID });
    await expect(verifySupabaseJwt(token, config(key))).rejects.toThrow(
      /missing email/,
    );
  });

  it("RETHROWS a JWKS infra error (timeout) instead of wrapping it (→ 500, not 401)", async () => {
    const token = await signToken(key, { sub: USER_ID, email: USER_EMAIL });
    const timeoutGetter: JWTVerifyGetKey = () => {
      throw new errors.JWKSTimeout();
    };
    await expect(
      verifySupabaseJwt(token, config(key, { keyGetter: timeoutGetter })),
    ).rejects.toBeInstanceOf(errors.JWKSTimeout);
  });

  it("RETHROWS the bare JOSEError (non-200/parse JWKS failure) as infra", async () => {
    const token = await signToken(key, { sub: USER_ID, email: USER_EMAIL });
    const genericGetter: JWTVerifyGetKey = () => {
      throw new errors.JOSEError("Expected 200 OK from the JSON Web Key Set");
    };
    const promise = verifySupabaseJwt(
      token,
      config(key, { keyGetter: genericGetter }),
    );
    await expect(promise).rejects.toBeInstanceOf(errors.JOSEError);
    await expect(promise).rejects.not.toBeInstanceOf(
      SupabaseAuthVerificationError,
    );
  });
});

describe("readSupabaseAuthConfigFromEnv", () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    aud: process.env.SUPABASE_JWT_AUD,
  };
  afterEach(() => {
    process.env.SUPABASE_URL = saved.url;
    process.env.SUPABASE_JWT_AUD = saved.aud;
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    if (saved.aud === undefined) delete process.env.SUPABASE_JWT_AUD;
  });

  it("returns null (dev bypass) when SUPABASE_URL is unset", () => {
    delete process.env.SUPABASE_URL;
    expect(readSupabaseAuthConfigFromEnv()).toBeNull();
  });

  it("derives issuer + jwksUri + default audience from SUPABASE_URL", () => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    delete process.env.SUPABASE_JWT_AUD;
    expect(readSupabaseAuthConfigFromEnv()).toEqual({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: JWKS_URI,
    });
  });

  it("tolerates a trailing slash on SUPABASE_URL", () => {
    process.env.SUPABASE_URL = `${SUPABASE_URL}/`;
    expect(readSupabaseAuthConfigFromEnv()?.issuer).toBe(ISSUER);
  });

  it("honours SUPABASE_JWT_AUD when set", () => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_JWT_AUD = "custom-aud";
    expect(readSupabaseAuthConfigFromEnv()?.audience).toBe("custom-aud");
  });
});

describe("operator / owner-key helpers", () => {
  const saved = {
    op: process.env.OPERATOR_USER_EMAIL,
    allowed: process.env.ALLOWED_USER_EMAIL,
    dev: process.env.DEV_USER_EMAIL,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries({
      OPERATOR_USER_EMAIL: saved.op,
      ALLOWED_USER_EMAIL: saved.allowed,
      DEV_USER_EMAIL: saved.dev,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults the operator email to the dev default", () => {
    delete process.env.OPERATOR_USER_EMAIL;
    delete process.env.ALLOWED_USER_EMAIL;
    delete process.env.DEV_USER_EMAIL;
    expect(operatorEmail()).toBe(DEFAULT_DEV_USER_EMAIL);
  });

  it("resolves operator email OPERATOR > ALLOWED > DEV", () => {
    process.env.ALLOWED_USER_EMAIL = "allowed@homeranger.test";
    process.env.DEV_USER_EMAIL = "dev@homeranger.test";
    delete process.env.OPERATOR_USER_EMAIL;
    expect(operatorEmail()).toBe("allowed@homeranger.test");
    process.env.OPERATOR_USER_EMAIL = "op@homeranger.test";
    expect(operatorEmail()).toBe("op@homeranger.test");
  });

  it("isOperator matches case-insensitively; ownerKeyFor → null for the operator", () => {
    process.env.OPERATOR_USER_EMAIL = "Op@Homeranger.Test";
    expect(isOperator("op@homeranger.test")).toBe(true);
    expect(ownerKeyFor({ id: USER_ID, email: "OP@homeranger.test" })).toBeNull();
  });

  it("ownerKeyFor → the user id for a non-operator, null for absent identity", () => {
    process.env.OPERATOR_USER_EMAIL = "op@homeranger.test";
    expect(ownerKeyFor({ id: USER_ID, email: USER_EMAIL })).toBe(USER_ID);
    expect(ownerKeyFor(null)).toBeNull();
    expect(ownerKeyFor(undefined)).toBeNull();
  });
});

describe("extractBearerToken", () => {
  it("strips a Bearer scheme case-insensitively", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer  abc.def.ghi")).toBe("abc.def.ghi");
  });
  it("returns a bare token unchanged", () => {
    expect(extractBearerToken("abc.def.ghi")).toBe("abc.def.ghi");
  });
  it("takes the first value of a string[] header; empty → ''", () => {
    expect(extractBearerToken(["Bearer one", "two"])).toBe("one");
    expect(extractBearerToken(undefined)).toBe("");
    expect(extractBearerToken("   ")).toBe("");
  });
});

describe("resolveSupabaseIdentity", () => {
  const saved = {
    devEmail: process.env.DEV_USER_EMAIL,
    devId: process.env.DEV_USER_ID,
  };
  afterEach(() => {
    process.env.DEV_USER_EMAIL = saved.devEmail;
    process.env.DEV_USER_ID = saved.devId;
    if (saved.devEmail === undefined) delete process.env.DEV_USER_EMAIL;
    if (saved.devId === undefined) delete process.env.DEV_USER_ID;
  });

  it("bypasses to the default dev operator identity when config is null", async () => {
    delete process.env.DEV_USER_EMAIL;
    delete process.env.DEV_USER_ID;
    expect(await resolveSupabaseIdentity(undefined, null)).toEqual({
      id: DEFAULT_DEV_USER_ID,
      email: DEFAULT_DEV_USER_EMAIL,
    });
  });

  it("honours DEV_USER_EMAIL / DEV_USER_ID in the bypass", async () => {
    process.env.DEV_USER_EMAIL = "custom@homeranger.local";
    process.env.DEV_USER_ID = "22222222-2222-4222-8222-222222222222";
    expect(await resolveSupabaseIdentity(undefined, null)).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      email: "custom@homeranger.local",
    });
  });

  it("returns the identity for a valid Bearer header token", async () => {
    resetSupabaseJwksCache();
    const key = await makeTestKey();
    const token = await signToken(key, { sub: USER_ID, email: USER_EMAIL });
    expect(
      await resolveSupabaseIdentity(`Bearer ${token}`, config(key)),
    ).toEqual({ id: USER_ID, email: USER_EMAIL });
  });

  it("returns null on a missing/garbage token (→ UNAUTHORIZED)", async () => {
    const key = await makeTestKey();
    expect(await resolveSupabaseIdentity(undefined, config(key))).toBeNull();
    expect(await resolveSupabaseIdentity("Bearer garbage", config(key))).toBeNull();
  });

  it("RETHROWS on a JWKS infra error rather than resolving null (→ 500)", async () => {
    const key = await makeTestKey();
    const token = await signToken(key, { sub: USER_ID, email: USER_EMAIL });
    const timeoutGetter: JWTVerifyGetKey = () => {
      throw new errors.JWKSTimeout();
    };
    await expect(
      resolveSupabaseIdentity(
        `Bearer ${token}`,
        config(key, { keyGetter: timeoutGetter }),
      ),
    ).rejects.toBeInstanceOf(errors.JWKSTimeout);
  });
});
