/**
 * Unit tests for PreferenceMatchService (M5 test plan, Unit row 3): vectorTopK
 * recalls candidates → the LLM re-scores ONLY the top-K (assert N calls == K,
 * not the full corpus) → combinedScore blends vector + LLM. All collaborators
 * are mocked (no DB, no network).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultPreferenceMatchService,
  buildProfileText,
  describeListing,
  getPreferenceMatchConfig,
  getPreferenceMatchService,
  vectorScoreFromDistance,
  _setPreferenceMatchServiceForTesting,
  type PreferenceMatchConfig,
} from "./preference-match.service.js";
import type { EmbeddingProvider } from "../lib/ai/embedding-provider.js";
import type { MatchScorer } from "../lib/ai/match-scorer.provider.js";
import type {
  ListingRepository,
  VectorTopKResult,
} from "../repositories/listing.repository.js";
import type {
  SearchProfileRecord,
  SearchProfileRepository,
} from "../repositories/search-profile.repository.js";
import type { ListingScoreRepository } from "../repositories/listing-score.repository.js";

const CONFIG: PreferenceMatchConfig = {
  topK: 25,
  weightVector: 0.4,
  weightLlm: 0.6,
};

function profile(overrides: Partial<SearchProfileRecord> = {}): SearchProfileRecord {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    freeTextPreferences: "Bright modern flat near the river",
    minBedrooms: null,
    maxPricePence: null,
    outcodes: [],
    requiredTenure: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function candidate(id: string, distance: number): VectorTopKResult {
  return {
    id,
    addressNormalized: `addr ${id}`,
    postcode: "SE1 1AA",
    outcode: "SE1",
    pricePence: 50_000_000,
    bedrooms: 2,
    tenure: "leasehold",
    propertyType: "flat",
    epcRating: "c",
    listingStatus: "pre_market",
    isPreMarket: true,
    listingUrl: null,
    primarySource: "agent_email",
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    distance,
  } as VectorTopKResult;
}

function vec(n: number): number[] {
  return Array.from({ length: n }, () => 0.01);
}

interface Harness {
  service: DefaultPreferenceMatchService;
  embed: ReturnType<typeof vi.fn>;
  scoreMatch: ReturnType<typeof vi.fn>;
  vectorTopK: ReturnType<typeof vi.fn>;
  writePreferenceEmbedding: ReturnType<typeof vi.fn>;
  upsertByListingId: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  candidates: VectorTopKResult[];
  llmScore?: number;
  profile?: SearchProfileRecord;
}): Harness {
  const embed = vi
    .fn()
    .mockResolvedValue({ embedding: vec(1024), metrics: { model: "m", totalTokens: 0, costPence: 0, durationMs: 0 } });
  const scoreMatch = vi.fn().mockResolvedValue({
    llmScore: opts.llmScore ?? 0.5,
    rationale: "because reasons",
    metrics: { model: "m", inputTokens: 0, outputTokens: 0, costPence: 0, durationMs: 0 },
  });
  const vectorTopK = vi.fn().mockResolvedValue(opts.candidates);
  const writePreferenceEmbedding = vi.fn().mockResolvedValue(1);
  const getOrCreate = vi.fn().mockResolvedValue(opts.profile ?? profile());
  const upsertByListingId = vi.fn().mockResolvedValue({});

  const service = new DefaultPreferenceMatchService({
    embeddingProvider: { embed, getModel: () => "m", getDimensions: () => 1024 } as unknown as EmbeddingProvider,
    matchScorer: { scoreMatch, getModel: () => "m" } as unknown as MatchScorer,
    config: CONFIG,
    listingRepository: { vectorTopK } as unknown as ListingRepository,
    searchProfileRepository: {
      getOrCreate,
      writePreferenceEmbedding,
    } as unknown as SearchProfileRepository,
    listingScoreRepository: { upsertByListingId } as unknown as ListingScoreRepository,
  });

  return { service, embed, scoreMatch, vectorTopK, writePreferenceEmbedding, upsertByListingId };
}

describe("DefaultPreferenceMatchService.recompute", () => {
  it("re-scores ONLY the K recalled candidates (N LLM calls == K)", async () => {
    const candidates = [
      candidate("a", 0.1),
      candidate("b", 0.2),
      candidate("c", 0.3),
    ];
    const h = makeHarness({ candidates });

    const result = await h.service.recompute({ k: 3 });

    expect(h.vectorTopK).toHaveBeenCalledTimes(1);
    expect(h.vectorTopK.mock.calls[0]![1]).toBe(3); // k passed through
    // The load-bearing cost control: LLM called once per candidate, NOT corpus.
    expect(h.scoreMatch).toHaveBeenCalledTimes(3);
    expect(h.upsertByListingId).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ profileEmbedded: true, candidates: 3, scored: 3 });
    // The profile embedding is persisted.
    expect(h.writePreferenceEmbedding).toHaveBeenCalledTimes(1);
  });

  it("blends combinedScore = wVec·vectorScore + wLlm·llmScore", async () => {
    const h = makeHarness({ candidates: [candidate("a", 0.2)], llmScore: 0.5 });
    await h.service.recompute();
    // vectorScore = 1 - 0.2 = 0.8; combined = 0.4*0.8 + 0.6*0.5 = 0.62.
    const written = h.upsertByListingId.mock.calls[0]![0] as {
      vectorScore: number;
      llmScore: number;
      combinedScore: number;
      rationale: string;
    };
    expect(written.vectorScore).toBeCloseTo(0.8);
    expect(written.llmScore).toBeCloseTo(0.5);
    expect(written.combinedScore).toBeCloseTo(0.62);
    expect(written.rationale).toBe("because reasons");
  });

  it("is a no-op for an empty profile (no embed, no vectorTopK)", async () => {
    const h = makeHarness({
      candidates: [],
      profile: profile({ freeTextPreferences: "   " }),
    });
    const result = await h.service.recompute();
    expect(result).toEqual({ profileEmbedded: false, candidates: 0, scored: 0 });
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.vectorTopK).not.toHaveBeenCalled();
    expect(h.scoreMatch).not.toHaveBeenCalled();
  });

  it("passes the structured pre-filter (minBeds / maxPrice / outcodes) to vectorTopK", async () => {
    const h = makeHarness({
      candidates: [],
      profile: profile({
        minBedrooms: 2,
        maxPricePence: 60_000_000,
        outcodes: ["SE1", "SE16"],
      }),
    });
    await h.service.recompute();
    expect(h.vectorTopK.mock.calls[0]![2]).toEqual({
      minBedrooms: 2,
      maxPricePence: 60_000_000,
      outcodes: ["SE1", "SE16"],
    });
  });
});

describe("getPreferenceMatchConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to topK 25 + 0.4/0.6 weights", () => {
    const config = getPreferenceMatchConfig();
    expect(config.topK).toBe(25);
    expect(config.weightVector).toBeCloseTo(0.4);
    expect(config.weightLlm).toBeCloseTo(0.6);
  });

  it("honours env overrides", () => {
    vi.stubEnv("MATCH_TOP_K", "10");
    vi.stubEnv("MATCH_WEIGHT_VECTOR", "0.7");
    vi.stubEnv("MATCH_WEIGHT_LLM", "0.3");
    const config = getPreferenceMatchConfig();
    expect(config.topK).toBe(10);
    expect(config.weightVector).toBeCloseTo(0.7);
    expect(config.weightLlm).toBeCloseTo(0.3);
  });
});

describe("getPreferenceMatchService", () => {
  afterEach(() => _setPreferenceMatchServiceForTesting(null));

  it("throws when used before initialisation", () => {
    _setPreferenceMatchServiceForTesting(null);
    expect(() => getPreferenceMatchService()).toThrow(/not initialised/);
  });

  it("initialises a singleton from deps and returns it thereafter", () => {
    const h = makeHarness({ candidates: [] });
    const initialised = getPreferenceMatchService({
      embeddingProvider: { embed: h.embed } as never,
      matchScorer: { scoreMatch: h.scoreMatch } as never,
    });
    expect(getPreferenceMatchService()).toBe(initialised);
  });
});

describe("helpers", () => {
  it("vectorScoreFromDistance clamps to [0,1]", () => {
    expect(vectorScoreFromDistance(0)).toBe(1);
    expect(vectorScoreFromDistance(0.25)).toBeCloseTo(0.75);
    expect(vectorScoreFromDistance(1.5)).toBe(0);
  });

  it("describeListing renders a compact line", () => {
    const text = describeListing(candidate("a", 0.1));
    expect(text).toContain("flat");
    expect(text).toContain("2 bed");
    expect(text).toContain("SE1");
    expect(text).toContain("£500,000");
  });

  it("buildProfileText folds in structured filters", () => {
    const text = buildProfileText(
      profile({ minBedrooms: 3, maxPricePence: 75_000_000, outcodes: ["N1"] }),
    );
    expect(text).toContain("Bright modern flat");
    expect(text).toContain("At least 3 bedrooms");
    expect(text).toContain("£750,000");
    expect(text).toContain("N1");
  });
});
