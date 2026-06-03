/**
 * Unit tests for the M5 provider config readers + client builders + singleton
 * factories. These exercise the env-default branches and the AI Gateway base-URL
 * wiring (mirrors the extraction provider's createAnthropicClient tests), keeping
 * the providers' branch coverage honest without a live LLM/Voyage call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVisionAnthropicClient,
  getVisionScorer,
  getVisionScorerConfig,
} from "./vision-scorer.provider.js";
import {
  getEmbeddingConfig,
  getEmbeddingProvider,
} from "./embedding-provider.js";
import {
  createMatchAnthropicClient,
  getMatchScorer,
  getMatchScorerConfig,
} from "./match-scorer.provider.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getVisionScorerConfig", () => {
  it("defaults to Haiku + the documented price/timeout when env is unset", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    const config = getVisionScorerConfig();
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.maxOutputTokens).toBe(1024);
    expect(config.inputPricePencePerMTok).toBe(80);
    expect(config.outputPricePencePerMTok).toBe(400);
  });

  it("honours env overrides", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("VISION_MODEL", "claude-haiku-test");
    vi.stubEnv("VISION_MAX_OUTPUT_TOKENS", "256");
    expect(getVisionScorerConfig().model).toBe("claude-haiku-test");
    expect(getVisionScorerConfig().maxOutputTokens).toBe(256);
  });

  it("throws when ANTHROPIC_API_KEY is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => getVisionScorerConfig()).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("createVisionAnthropicClient", () => {
  const config = {
    apiKey: "k",
    model: "claude-haiku-4-5",
    maxOutputTokens: 1024,
    timeoutMs: 1000,
    inputPricePencePerMTok: 80,
    outputPricePencePerMTok: 400,
  };

  it("talks directly to Anthropic when the gateway env is unset", () => {
    expect(createVisionAnthropicClient(config).baseURL).toContain(
      "api.anthropic.com",
    );
  });

  it("routes through the AI Gateway when CF_AI_GATEWAY_* is set", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    expect(createVisionAnthropicClient(config).baseURL).toContain(
      "gateway.ai.cloudflare.com/v1/acc123/homeranger/anthropic",
    );
  });
});

describe("getVisionScorer", () => {
  it("builds a fresh scorer from deps, and a singleton otherwise", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    const a = getVisionScorer({ config: getVisionScorerConfig() });
    const b = getVisionScorer({ config: getVisionScorerConfig() });
    expect(a).not.toBe(b); // deps → always a new instance
    expect(getVisionScorer()).toBe(getVisionScorer()); // no deps → cached
  });
});

describe("getEmbeddingConfig", () => {
  it("defaults to voyage-3.5 + 1024 dims when env is unset", () => {
    vi.stubEnv("VOYAGE_API_KEY", "k");
    const config = getEmbeddingConfig();
    expect(config.model).toBe("voyage-3.5");
    expect(config.dimensions).toBe(1024);
    expect(config.pricePencePerMTok).toBe(5);
  });

  it("honours EMBEDDING_MODEL + price overrides", () => {
    vi.stubEnv("VOYAGE_API_KEY", "k");
    vi.stubEnv("EMBEDDING_MODEL", "voyage-test");
    vi.stubEnv("EMBEDDING_PENCE_PER_MTOK", "9");
    expect(getEmbeddingConfig().model).toBe("voyage-test");
    expect(getEmbeddingConfig().pricePencePerMTok).toBe(9);
  });

  it("throws when VOYAGE_API_KEY is missing", () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    expect(() => getEmbeddingConfig()).toThrow(/VOYAGE_API_KEY/);
  });
});

describe("getEmbeddingProvider", () => {
  it("builds a fresh provider from deps, and a singleton otherwise", () => {
    vi.stubEnv("VOYAGE_API_KEY", "k");
    const a = getEmbeddingProvider({ config: getEmbeddingConfig() });
    const b = getEmbeddingProvider({ config: getEmbeddingConfig() });
    expect(a).not.toBe(b);
    expect(getEmbeddingProvider()).toBe(getEmbeddingProvider());
    expect(getEmbeddingProvider().getDimensions()).toBe(1024);
  });
});

describe("getMatchScorerConfig", () => {
  it("defaults to Haiku when env is unset", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    expect(getMatchScorerConfig().model).toBe("claude-haiku-4-5");
    expect(getMatchScorerConfig().maxOutputTokens).toBe(512);
  });

  it("honours MATCH_MODEL override and throws without the API key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("MATCH_MODEL", "claude-haiku-match");
    expect(getMatchScorerConfig().model).toBe("claude-haiku-match");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => getMatchScorerConfig()).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("createMatchAnthropicClient", () => {
  const config = {
    apiKey: "k",
    model: "claude-haiku-4-5",
    maxOutputTokens: 512,
    timeoutMs: 1000,
    inputPricePencePerMTok: 80,
    outputPricePencePerMTok: 400,
  };
  it("direct by default, gateway when configured", () => {
    expect(createMatchAnthropicClient(config).baseURL).toContain(
      "api.anthropic.com",
    );
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    expect(createMatchAnthropicClient(config).baseURL).toContain(
      "/acc123/homeranger/anthropic",
    );
  });
});

describe("getMatchScorer", () => {
  it("builds a fresh scorer from deps, and a singleton otherwise", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    const a = getMatchScorer({ config: getMatchScorerConfig() });
    const b = getMatchScorer({ config: getMatchScorerConfig() });
    expect(a).not.toBe(b);
    expect(getMatchScorer()).toBe(getMatchScorer());
  });
});
