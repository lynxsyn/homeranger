/**
 * Env-gated FAKE embedding provider (`ANALYSIS_FAKE=1` / `EMBEDDING_FAKE=1`).
 * Produces a DETERMINISTIC unit `vector(1024)` seeded from the text hash — so
 * the E2E analysis path writes a real pgvector + `vectorTopK` ranks
 * reproducibly, with no Voyage call or spend. Never used in production.
 */
import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "../../repositories/listing.repository.js";
import type {
  EmbeddingProvider,
  EmbeddingResult,
} from "./embedding-provider.js";

function hashToSeed(text: string): number {
  const hex = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) >>> 0;
}

/** Tiny deterministic PRNG (mulberry32) — same seed → same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  private readonly model = "fake-voyage-3.5";

  getModel(): string {
    return this.model;
  }

  getDimensions(): number {
    return EMBEDDING_DIMENSIONS;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const rnd = mulberry32(hashToSeed(text));
    const raw = Array.from({ length: EMBEDDING_DIMENSIONS }, () => rnd() * 2 - 1);
    const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
    const embedding = raw.map((x) => x / norm);
    return {
      embedding,
      metrics: {
        model: this.model,
        totalTokens: 0,
        costPence: 0,
        durationMs: 0,
      },
    };
  }
}
