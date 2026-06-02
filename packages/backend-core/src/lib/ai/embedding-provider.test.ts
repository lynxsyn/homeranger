/**
 * Unit tests for the Voyage embedding provider (M5 test plan, Unit row 2:
 * returns a 1024-dim vector; a wrong-dim response is rejected). `fetch` is
 * injected, so no network/spend.
 */
import { describe, expect, it, vi } from "vitest";
import {
  VoyageEmbeddingProvider,
  type EmbeddingConfig,
  type EmbeddingProviderDeps,
} from "./embedding-provider.js";
import { EMBEDDING_DIMENSIONS } from "../../repositories/listing.repository.js";
import type { ProviderError } from "./provider-errors.js";

const CONFIG: EmbeddingConfig = {
  apiKey: "test-voyage-key",
  model: "voyage-3.5",
  dimensions: EMBEDDING_DIMENSIONS,
  timeoutMs: 1000,
  pricePencePerMTok: 5,
};

function vec(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 7) * 0.01);
}

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errResponse(status: number, text = "error") {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  };
}

function providerWith(fetchImpl: ReturnType<typeof vi.fn>) {
  return new VoyageEmbeddingProvider({
    config: CONFIG,
    fetchImpl: fetchImpl as unknown as EmbeddingProviderDeps["fetchImpl"],
  });
}

describe("VoyageEmbeddingProvider.embed", () => {
  it("returns a 1024-dim vector and records token cost", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        data: [{ embedding: vec(EMBEDDING_DIMENSIONS) }],
        usage: { total_tokens: 2_000_000 },
      }),
    );
    const result = await providerWith(fetchImpl).embed("a bright modern flat", {
      inputType: "document",
    });

    expect(result.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    // 2M tokens @ 5p/MTok = 10p.
    expect(result.metrics.costPence).toBe(10);
    expect(result.metrics.totalTokens).toBe(2_000_000);

    // Posted the right model + dimension + input_type.
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.model).toBe("voyage-3.5");
    expect(body.output_dimension).toBe(EMBEDDING_DIMENSIONS);
    expect(body.input_type).toBe("document");
    expect(init.headers.authorization).toBe("Bearer test-voyage-key");
  });

  it("rejects a wrong-dimension response as non-retryable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse({ data: [{ embedding: vec(512) }] }));
    await expect(
      providerWith(fetchImpl).embed("text"),
    ).rejects.toMatchObject({ retryable: false } as Partial<ProviderError>);
  });

  it("rejects a missing embedding array as non-retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ data: [] }));
    await expect(
      providerWith(fetchImpl).embed("text"),
    ).rejects.toMatchObject({ retryable: false } as Partial<ProviderError>);
  });

  it("rejects a non-finite value in the embedding as non-retryable", async () => {
    const bad = vec(EMBEDDING_DIMENSIONS);
    bad[3] = Number.NaN;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse({ data: [{ embedding: bad }] }));
    await expect(
      providerWith(fetchImpl).embed("text"),
    ).rejects.toMatchObject({ retryable: false } as Partial<ProviderError>);
  });

  it("classifies a 429 as retryable and a 400 as non-retryable", async () => {
    const f429 = vi.fn().mockResolvedValue(errResponse(429, "rate limited"));
    await expect(providerWith(f429).embed("x")).rejects.toMatchObject({
      retryable: true,
    } as Partial<ProviderError>);

    const f400 = vi.fn().mockResolvedValue(errResponse(400, "bad request"));
    await expect(providerWith(f400).embed("x")).rejects.toMatchObject({
      retryable: false,
    } as Partial<ProviderError>);
  });

  it("exposes the model and dimensions", () => {
    const provider = providerWith(vi.fn());
    expect(provider.getModel()).toBe("voyage-3.5");
    expect(provider.getDimensions()).toBe(EMBEDDING_DIMENSIONS);
  });
});
