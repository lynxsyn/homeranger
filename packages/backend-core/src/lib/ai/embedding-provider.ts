/**
 * Voyage `voyage-3.5` embedding provider for the M5 analysis pipeline (spec
 * AC#2 + #6). Produces the `vector(1024)` written to `Listing.embedding` and
 * `SearchProfile.preferenceEmbedding`.
 *
 * Voyage has no first-party Node SDK we depend on, so this is a thin `fetch`
 * client (the `fetch` impl is injectable for unit tests — no network/spend).
 * Unlike the Claude/Haiku calls, Voyage does NOT ride the Cloudflare AI Gateway:
 * it has no Voyage provider, so a `/voyage` path 400s with "Invalid provider".
 * `voyageEmbeddingsEndpoint` therefore always returns Voyage's direct API URL.
 * The response dimension is asserted to be exactly 1024 — a wrong-dim response
 * is a non-retryable error (it would corrupt the pgvector column).
 *
 * Retryable-vs-terminal classification reuses the shared `provider-errors`
 * rules (429/5xx retryable; 4xx incl. 404 terminal) so a misconfigured call
 * fails fast rather than burning BullMQ attempts.
 */
import { EMBEDDING_DIMENSIONS } from "../../repositories/listing.repository.js";
import { voyageEmbeddingsEndpoint } from "./ai-gateway.js";
import {
  classifyProviderError,
  createNonRetryableError,
} from "./provider-errors.js";
import { recordAiCall } from "./analysis-metrics.js";

/** Voyage `input_type` tunes the embedding for retrieval (asymmetric search). */
export type EmbeddingInputType = "document" | "query";

export interface EmbeddingMetrics {
  model: string;
  totalTokens: number;
  costPence: number;
  durationMs: number;
}

export interface EmbeddingResult {
  embedding: number[];
  metrics: EmbeddingMetrics;
}

export interface EmbeddingProvider {
  embed(
    text: string,
    opts?: { inputType?: EmbeddingInputType },
  ): Promise<EmbeddingResult>;
  getModel(): string;
  getDimensions(): number;
}

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface EmbeddingConfig {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  /** Per-million-token price in pence for the costPence metric. */
  pricePencePerMTok: number;
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const apiKey = process.env.VOYAGE_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is required for Voyage embeddings");
  }
  return {
    apiKey,
    model: process.env.EMBEDDING_MODEL ?? "voyage-3.5",
    dimensions: EMBEDDING_DIMENSIONS,
    timeoutMs: Number.parseInt(process.env.EMBEDDING_TIMEOUT_MS ?? "30000", 10),
    // voyage-3.5 ≈ $0.06/MTok → ~5p/MTok at ~0.8 GBP.
    pricePencePerMTok: Number.parseFloat(
      process.env.EMBEDDING_PENCE_PER_MTOK ?? "5",
    ),
  };
}

export interface EmbeddingProviderDeps {
  config?: EmbeddingConfig;
  /** Injected for unit tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private readonly config: EmbeddingConfig;
  private readonly fetchImpl: FetchLike;

  constructor(deps: EmbeddingProviderDeps = {}) {
    this.config = deps.config ?? getEmbeddingConfig();
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  getModel(): string {
    return this.config.model;
  }

  getDimensions(): number {
    return this.config.dimensions;
  }

  async embed(
    text: string,
    opts: { inputType?: EmbeddingInputType } = {},
  ): Promise<EmbeddingResult> {
    const startTime = Date.now();
    const endpoint = voyageEmbeddingsEndpoint();
    try {
      const response = await this.fetchImpl(endpoint.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          ...endpoint.headers,
        },
        body: JSON.stringify({
          input: [text],
          model: this.config.model,
          output_dimension: this.config.dimensions,
          ...(opts.inputType ? { input_type: opts.inputType } : {}),
        }),
      });

      if (!response.ok) {
        // Build a status-bearing error so the shared classifier decides retry.
        const detail = await safeText(response);
        throw classifyProviderError(
          Object.assign(new Error(`Voyage embeddings HTTP ${response.status}: ${detail}`), {
            status: response.status,
          }),
          "Voyage embeddings request failed",
        );
      }

      const payload = (await response.json()) as VoyageEmbeddingResponse;
      const embedding = payload?.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) {
        throw createNonRetryableError(
          "Voyage response did not contain an embedding array",
        );
      }
      if (embedding.length !== this.config.dimensions) {
        throw createNonRetryableError(
          `Voyage returned ${embedding.length} dims, expected ${this.config.dimensions}`,
        );
      }
      for (const value of embedding) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw createNonRetryableError(
            "Voyage embedding contained a non-finite value",
          );
        }
      }

      const durationMs = Date.now() - startTime;
      const totalTokens = payload?.usage?.total_tokens ?? 0;
      const costPence = Math.round(
        (totalTokens / 1_000_000) * this.config.pricePencePerMTok,
      );

      recordAiCall({
        provider: "voyage",
        model: this.config.model,
        inputTokens: totalTokens,
        outputTokens: 0,
        costPence,
        durationMs,
        status: "ok",
      });

      return {
        embedding,
        metrics: { model: this.config.model, totalTokens, costPence, durationMs },
      };
    } catch (error) {
      recordAiCall({
        provider: "voyage",
        model: this.config.model,
        inputTokens: 0,
        outputTokens: 0,
        costPence: 0,
        durationMs: Date.now() - startTime,
        status: "error",
      });
      throw classifyProviderError(error, "Voyage embeddings request failed");
    }
  }
}

interface VoyageEmbeddingResponse {
  data?: Array<{ embedding?: unknown }>;
  usage?: { total_tokens?: number };
}

async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}

let singleton: EmbeddingProvider | undefined;

export function getEmbeddingProvider(
  deps?: EmbeddingProviderDeps,
): EmbeddingProvider {
  if (deps) {
    return new VoyageEmbeddingProvider(deps);
  }
  if (!singleton) {
    singleton = new VoyageEmbeddingProvider();
  }
  return singleton;
}
