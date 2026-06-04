/**
 * Unit tests for the Cloudflare AI Gateway wiring (env → SDK client options).
 *
 * The gateway is OPTIONAL and env-driven: with `CF_AI_GATEWAY_*` unset the
 * helpers return empty options so the SDK talks to the provider directly (the
 * local-dev / unit-test / CI path). Env is manipulated with `vi.stubEnv` and
 * cleared in `afterEach` so tests never leak gateway state into each other.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anthropicGatewayClientOptions,
  gatewayBaseUrl,
  getAiGatewayConfig,
  voyageEmbeddingsEndpoint,
} from "./ai-gateway.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAiGatewayConfig", () => {
  it("returns null when neither account nor gateway id is set", () => {
    expect(getAiGatewayConfig()).toBeNull();
  });

  it("returns null when only one of account/gateway id is set (half-configured = off)", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    expect(getAiGatewayConfig()).toBeNull();
    vi.unstubAllEnvs();
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    expect(getAiGatewayConfig()).toBeNull();
  });

  it("treats whitespace-only env values as unset", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "   ");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    expect(getAiGatewayConfig()).toBeNull();
  });

  it("returns account + gateway id (no token) when both are set", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    expect(getAiGatewayConfig()).toEqual({
      accountId: "acc123",
      gatewayId: "homeranger",
    });
  });

  it("includes a trimmed token when CF_AI_GATEWAY_TOKEN is present", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    vi.stubEnv("CF_AI_GATEWAY_TOKEN", "  tok_secret  ");
    expect(getAiGatewayConfig()).toEqual({
      accountId: "acc123",
      gatewayId: "homeranger",
      token: "tok_secret",
    });
  });

  it("omits the token when CF_AI_GATEWAY_TOKEN is whitespace-only", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    vi.stubEnv("CF_AI_GATEWAY_TOKEN", "   ");
    expect(getAiGatewayConfig()).toEqual({
      accountId: "acc123",
      gatewayId: "homeranger",
    });
  });
});

describe("gatewayBaseUrl", () => {
  it("builds the provider-scoped gateway URL", () => {
    expect(
      gatewayBaseUrl("anthropic", { accountId: "acc123", gatewayId: "homeranger" }),
    ).toBe("https://gateway.ai.cloudflare.com/v1/acc123/homeranger/anthropic");
  });
});

describe("anthropicGatewayClientOptions", () => {
  it("returns empty options when the gateway is unconfigured", () => {
    expect(anthropicGatewayClientOptions()).toEqual({});
  });

  it("returns the gateway baseURL (no auth header) for an unauthenticated gateway", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    expect(anthropicGatewayClientOptions()).toEqual({
      baseURL: "https://gateway.ai.cloudflare.com/v1/acc123/homeranger/anthropic",
    });
  });

  it("adds the cf-aig-authorization header when a token is configured", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    vi.stubEnv("CF_AI_GATEWAY_TOKEN", "tok_secret");
    expect(anthropicGatewayClientOptions()).toEqual({
      baseURL: "https://gateway.ai.cloudflare.com/v1/acc123/homeranger/anthropic",
      defaultHeaders: { "cf-aig-authorization": "Bearer tok_secret" },
    });
  });

  it("honours an explicitly-passed config over the environment", () => {
    expect(
      anthropicGatewayClientOptions({ accountId: "x", gatewayId: "y" }),
    ).toEqual({
      baseURL: "https://gateway.ai.cloudflare.com/v1/x/y/anthropic",
    });
  });
});

describe("voyageEmbeddingsEndpoint", () => {
  it("posts directly to Voyage (no headers) when the gateway is unconfigured", () => {
    expect(voyageEmbeddingsEndpoint()).toEqual({
      url: "https://api.voyageai.com/v1/embeddings",
      headers: {},
    });
  });

  it("ALWAYS posts directly to Voyage even when CF_AI_GATEWAY_* is set (the gateway has NO Voyage provider)", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    // Cloudflare AI Gateway rejects a /voyage path with AiGatewayError 2008
    // "Invalid provider" — Voyage is not a supported provider — so we bypass it.
    expect(voyageEmbeddingsEndpoint()).toEqual({
      url: "https://api.voyageai.com/v1/embeddings",
      headers: {},
    });
  });

  it("bypasses the gateway even when it carries an auth token (Voyage never rides the gateway)", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    vi.stubEnv("CF_AI_GATEWAY_TOKEN", "tok_secret");
    expect(voyageEmbeddingsEndpoint()).toEqual({
      url: "https://api.voyageai.com/v1/embeddings",
      headers: {},
    });
  });

  it("honours a custom direct base URL", () => {
    expect(voyageEmbeddingsEndpoint("https://proxy.test/v9").url).toBe(
      "https://proxy.test/v9/embeddings",
    );
  });
});
