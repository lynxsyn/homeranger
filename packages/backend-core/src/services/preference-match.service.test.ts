/**
 * Unit tests for PreferenceMatchService (per-search match scoring). All
 * collaborators are mocked (no DB, no network, no Voyage/Haiku spend).
 *
 * The two paths under test:
 *   - recomputeSearch / recomputeAll: embed a search's taste → vectorTopK recall →
 *     LLM re-scores ONLY the top-K → upsert one ListingScore per (listing, search).
 *   - scoreListing: score ONE listing against each active operator search covering
 *     its outcode (capped), lazily embedding a search if needed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultPreferenceMatchService,
  buildSearchText,
  describeListing,
  getPreferenceMatchConfig,
  getPreferenceMatchService,
  searchHasTaste,
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
  SearchRecord,
  SearchRepository,
} from "../repositories/search.repository.js";
import type { ListingScoreRepository } from "../repositories/listing-score.repository.js";

const CONFIG: PreferenceMatchConfig = {
  topK: 25,
  weightVector: 0.4,
  weightLlm: 0.6,
  maxSearchesPerListing: 10,
};

function search(overrides: Partial<SearchRecord> = {}): SearchRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Snowdonia stone cottage",
    location: "Snowdonia",
    outcodes: ["LL55", "LL41"],
    types: [],
    condition: [],
    land: [],
    saleMethods: ["Private treaty"],
    minBedrooms: null,
    maxPricePence: null,
    keywords: "detached stone cottage with mountain views",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function candidate(id: string, distance: number): VectorTopKResult {
  return {
    id,
    addressNormalized: `addr ${id}`,
    postcode: "LL55 1AA",
    outcode: "LL55",
    pricePence: 50_000_000,
    bedrooms: 3,
    bathrooms: 2,
    tenure: "freehold",
    propertyType: "detached",
    epcRating: "d",
    listingStatus: "pre_market",
    isPreMarket: true,
    listingUrl: null,
    primarySource: "agent_email",
    agentEmail: null,
    agencyName: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    distance,
  } as VectorTopKResult;
}

function vec(n = 1024): number[] {
  return Array.from({ length: n }, () => 0.01);
}

interface HarnessOpts {
  search?: SearchRecord;
  searches?: SearchRecord[];
  coveringSearches?: SearchRecord[];
  candidates?: VectorTopKResult[];
  listing?: VectorTopKResult | null;
  distance?: number | null;
  /** Persisted keyword embedding for scoreListing; null = not yet embedded. */
  keywordsEmbedding?: number[] | null;
  llmScore?: number;
  config?: PreferenceMatchConfig;
}

function makeHarness(opts: HarnessOpts = {}) {
  const embed = vi.fn().mockResolvedValue({
    embedding: vec(),
    metrics: { model: "m", totalTokens: 0, costPence: 0, durationMs: 0 },
  });
  const scoreMatch = vi.fn().mockResolvedValue({
    llmScore: opts.llmScore ?? 0.5,
    rationale: "because reasons",
    metrics: { model: "m", inputTokens: 0, outputTokens: 0, costPence: 0, durationMs: 0 },
  });
  const vectorTopK = vi.fn().mockResolvedValue(opts.candidates ?? []);
  const vectorDistanceFor = vi
    .fn()
    .mockResolvedValue(opts.distance === undefined ? 0.2 : opts.distance);
  const getById = vi
    .fn()
    .mockResolvedValue(
      opts.listing === undefined ? candidate("L1", 0.2) : opts.listing,
    );

  const searchGetById = vi.fn().mockResolvedValue(opts.search ?? null);
  const listActive = vi.fn().mockResolvedValue(opts.searches ?? []);
  const listActiveByOutcode = vi
    .fn()
    .mockResolvedValue(opts.coveringSearches ?? []);
  const readKeywordsEmbedding = vi
    .fn()
    .mockResolvedValue(
      opts.keywordsEmbedding === undefined ? vec() : opts.keywordsEmbedding,
    );
  const writeKeywordsEmbedding = vi.fn().mockResolvedValue(1);
  const upsertByListingAndSearch = vi.fn().mockResolvedValue({});

  const service = new DefaultPreferenceMatchService({
    embeddingProvider: { embed, getModel: () => "m", getDimensions: () => 1024 } as unknown as EmbeddingProvider,
    matchScorer: { scoreMatch, getModel: () => "m" } as unknown as MatchScorer,
    config: opts.config ?? CONFIG,
    listingRepository: { vectorTopK, vectorDistanceFor, getById } as unknown as ListingRepository,
    searchRepository: {
      getById: searchGetById,
      listActive,
      listActiveByOutcode,
      readKeywordsEmbedding,
      writeKeywordsEmbedding,
    } as unknown as SearchRepository,
    listingScoreRepository: { upsertByListingAndSearch } as unknown as ListingScoreRepository,
  });

  return {
    service,
    embed,
    scoreMatch,
    vectorTopK,
    vectorDistanceFor,
    getById,
    searchGetById,
    listActive,
    listActiveByOutcode,
    readKeywordsEmbedding,
    writeKeywordsEmbedding,
    upsertByListingAndSearch,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("recomputeSearch", () => {
  it("embeds the search, recalls top-K, re-scores ONLY those K, upserts per (listing, search)", async () => {
    const s = search();
    const h = makeHarness({
      search: s,
      candidates: [candidate("a", 0.1), candidate("b", 0.2), candidate("c", 0.3)],
    });

    const result = await h.service.recomputeSearch(s.id, { k: 3 });

    expect(h.searchGetById).toHaveBeenCalledWith(s.id, null); // operator-scoped
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.writeKeywordsEmbedding).toHaveBeenCalledWith(s.id, vec());
    expect(h.vectorTopK.mock.calls[0]![1]).toBe(3); // k threaded
    // The load-bearing cost control: LLM once per candidate, NOT the full corpus.
    expect(h.scoreMatch).toHaveBeenCalledTimes(3);
    expect(h.upsertByListingAndSearch).toHaveBeenCalledTimes(3);
    // Every upsert carries the search id (composite keying).
    for (const call of h.upsertByListingAndSearch.mock.calls) {
      expect((call[0] as { searchId: string }).searchId).toBe(s.id);
    }
    expect(result).toEqual({ searchEmbedded: true, candidates: 3, scored: 3 });
  });

  it("blends combinedScore = wVec·vectorScore + wLlm·llmScore", async () => {
    const s = search();
    const h = makeHarness({ search: s, candidates: [candidate("a", 0.2)], llmScore: 0.5 });
    await h.service.recomputeSearch(s.id);
    const written = h.upsertByListingAndSearch.mock.calls[0]![0] as {
      vectorScore: number;
      llmScore: number;
      combinedScore: number;
    };
    // vectorScore = 1 - 0.2 = 0.8; combined = 0.4*0.8 + 0.6*0.5 = 0.62.
    expect(written.vectorScore).toBeCloseTo(0.8);
    expect(written.combinedScore).toBeCloseTo(0.62);
  });

  it("passes the search's structured pre-filter (beds/price/outcodes) to vectorTopK", async () => {
    const s = search({ minBedrooms: 3, maxPricePence: 60_000_000, outcodes: ["LL55"] });
    const h = makeHarness({ search: s, candidates: [] });
    await h.service.recomputeSearch(s.id);
    expect(h.vectorTopK.mock.calls[0]![2]).toEqual({
      minBedrooms: 3,
      maxPricePence: 60_000_000,
      outcodes: ["LL55"],
    });
  });

  it("is a no-op for a blank search (no keywords + no structured taste)", async () => {
    const s = search({ keywords: "  ", minBedrooms: null, maxPricePence: null, types: [], condition: [], land: [] });
    const h = makeHarness({ search: s });
    const result = await h.service.recomputeSearch(s.id);
    expect(result).toEqual({ searchEmbedded: false, candidates: 0, scored: 0 });
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.vectorTopK).not.toHaveBeenCalled();
  });

  it("is a no-op when the search is missing / not the operator's", async () => {
    const h = makeHarness({ search: null as unknown as SearchRecord });
    h.searchGetById.mockResolvedValue(null);
    const result = await h.service.recomputeSearch("missing");
    expect(result).toEqual({ searchEmbedded: false, candidates: 0, scored: 0 });
    expect(h.embed).not.toHaveBeenCalled();
  });

  it("is a no-op (no embed) when ANALYSIS_KILL_SWITCH is set", async () => {
    vi.stubEnv("ANALYSIS_KILL_SWITCH", "1");
    const s = search();
    const h = makeHarness({ search: s, candidates: [candidate("a", 0.1)] });
    const result = await h.service.recomputeSearch(s.id);
    expect(result).toEqual({ searchEmbedded: false, candidates: 0, scored: 0 });
    expect(h.searchGetById).not.toHaveBeenCalled();
    expect(h.embed).not.toHaveBeenCalled();
  });
});

describe("recomputeAll", () => {
  it("recomputes every active operator search and aggregates the counts", async () => {
    const s1 = search({ id: "11111111-1111-4111-8111-111111111111" });
    const s2 = search({ id: "22222222-2222-4222-8222-222222222222", keywords: "barn conversion" });
    const h = makeHarness({ searches: [s1, s2], candidates: [candidate("a", 0.1)] });

    const result = await h.service.recomputeAll({ k: 1 });

    expect(h.listActive).toHaveBeenCalledWith(null);
    // Each search embedded + its one candidate scored.
    expect(h.embed).toHaveBeenCalledTimes(2);
    expect(h.upsertByListingAndSearch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ searchesRecomputed: 2, scored: 2 });
  });

  it("is a no-op when ANALYSIS_KILL_SWITCH is set", async () => {
    vi.stubEnv("ANALYSIS_KILL_SWITCH", "1");
    const h = makeHarness({ searches: [search()] });
    const result = await h.service.recomputeAll();
    expect(result).toEqual({ searchesRecomputed: 0, scored: 0 });
    expect(h.listActive).not.toHaveBeenCalled();
  });
});

describe("scoreListing", () => {
  it("scores a listing against each covering search using the persisted vector", async () => {
    const s1 = search({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const s2 = search({ id: "bbbbbbbb-2222-4222-8222-222222222222", keywords: "river views" });
    const h = makeHarness({
      listing: candidate("L1", 0),
      coveringSearches: [s1, s2],
      distance: 0.2,
      llmScore: 0.5,
    });

    const result = await h.service.scoreListing("L1");

    expect(h.listActiveByOutcode).toHaveBeenCalledWith("LL55", null, 10); // outcode + cap
    expect(h.vectorTopK).not.toHaveBeenCalled(); // per-listing path, not a recall
    expect(h.scoreMatch).toHaveBeenCalledTimes(2);
    expect(h.upsertByListingAndSearch).toHaveBeenCalledTimes(2);
    expect(h.upsertByListingAndSearch.mock.calls.map((c) => (c[0] as { searchId: string }).searchId))
      .toEqual([s1.id, s2.id]);
    const written = h.upsertByListingAndSearch.mock.calls[0]![0] as { combinedScore: number };
    expect(written.combinedScore).toBeCloseTo(0.62); // 0.4*0.8 + 0.6*0.5
    expect(result).toEqual({ scored: true, searchesScored: 2 });
  });

  it("lazily embeds a covering search whose keyword vector is not persisted yet", async () => {
    const s1 = search();
    const h = makeHarness({
      listing: candidate("L1", 0),
      coveringSearches: [s1],
      keywordsEmbedding: null, // not embedded yet
      distance: 0.3,
    });

    const result = await h.service.scoreListing("L1");

    expect(h.readKeywordsEmbedding).toHaveBeenCalledWith(s1.id);
    expect(h.embed).toHaveBeenCalledTimes(1); // embedded on the fly
    expect(h.writeKeywordsEmbedding).toHaveBeenCalledWith(s1.id, vec());
    expect(result).toEqual({ scored: true, searchesScored: 1 });
  });

  it("skips a blank covering search with no persisted vector (nothing to score against)", async () => {
    const blank = search({ keywords: "", minBedrooms: null, maxPricePence: null, types: [], condition: [], land: [] });
    const h = makeHarness({
      listing: candidate("L1", 0),
      coveringSearches: [blank],
      keywordsEmbedding: null,
    });
    const result = await h.service.scoreListing("L1");
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.upsertByListingAndSearch).not.toHaveBeenCalled();
    expect(result).toEqual({ scored: false, searchesScored: 0 });
  });

  it("is a no-op when the listing has no outcode", async () => {
    const h = makeHarness({ listing: candidate("L1", 0) });
    h.getById.mockResolvedValue({ ...candidate("L1", 0), outcode: null });
    const result = await h.service.scoreListing("L1");
    expect(h.listActiveByOutcode).not.toHaveBeenCalled();
    expect(result).toEqual({ scored: false, searchesScored: 0 });
  });

  it("is a no-op when no active search covers the outcode", async () => {
    const h = makeHarness({ listing: candidate("L1", 0), coveringSearches: [] });
    const result = await h.service.scoreListing("L1");
    expect(h.scoreMatch).not.toHaveBeenCalled();
    expect(result).toEqual({ scored: false, searchesScored: 0 });
  });

  it("is a no-op when the listing has no embedding yet (distance null) — stops early", async () => {
    const h = makeHarness({
      listing: candidate("L1", 0),
      coveringSearches: [search(), search({ id: "cccccccc-3333-4333-8333-333333333333" })],
      distance: null,
    });
    const result = await h.service.scoreListing("L1");
    expect(h.scoreMatch).not.toHaveBeenCalled();
    expect(h.upsertByListingAndSearch).not.toHaveBeenCalled();
    expect(result).toEqual({ scored: false, searchesScored: 0 });
  });

  it("is a no-op when the listing does not exist", async () => {
    const h = makeHarness({ listing: null });
    const result = await h.service.scoreListing("missing");
    expect(result).toEqual({ scored: false, searchesScored: 0 });
  });

  it("clamps combinedScore to [0,1] even with misconfigured weights", async () => {
    const h = makeHarness({
      listing: candidate("L1", 0),
      coveringSearches: [search()],
      distance: 0,
      llmScore: 1,
      config: { topK: 25, weightVector: 0.9, weightLlm: 0.9, maxSearchesPerListing: 10 },
    });
    await h.service.scoreListing("L1");
    const written = h.upsertByListingAndSearch.mock.calls.at(-1)![0] as { combinedScore: number };
    expect(written.combinedScore).toBe(1);
  });
});

describe("getPreferenceMatchConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults topK 25, 0.4/0.6 weights, maxSearchesPerListing 10", () => {
    const config = getPreferenceMatchConfig();
    expect(config.topK).toBe(25);
    expect(config.weightVector).toBeCloseTo(0.4);
    expect(config.weightLlm).toBeCloseTo(0.6);
    expect(config.maxSearchesPerListing).toBe(10);
  });

  it("honours env overrides", () => {
    vi.stubEnv("MATCH_TOP_K", "10");
    vi.stubEnv("MATCH_WEIGHT_VECTOR", "0.7");
    vi.stubEnv("MATCH_WEIGHT_LLM", "0.3");
    vi.stubEnv("MATCH_MAX_SEARCHES_PER_LISTING", "3");
    const config = getPreferenceMatchConfig();
    expect(config.topK).toBe(10);
    expect(config.weightVector).toBeCloseTo(0.7);
    expect(config.weightLlm).toBeCloseTo(0.3);
    expect(config.maxSearchesPerListing).toBe(3);
  });
});

describe("getPreferenceMatchService", () => {
  afterEach(() => _setPreferenceMatchServiceForTesting(null));

  it("throws when used before initialisation", () => {
    _setPreferenceMatchServiceForTesting(null);
    expect(() => getPreferenceMatchService()).toThrow(/not initialised/);
  });

  it("initialises a singleton from deps and returns it thereafter", () => {
    const h = makeHarness();
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
    expect(text).toContain("detached");
    expect(text).toContain("3 bed");
    expect(text).toContain("LL55");
    expect(text).toContain("£500,000");
  });

  it("buildSearchText folds keywords + structured brief", () => {
    const text = buildSearchText(
      search({ keywords: "barn conversion", minBedrooms: 3, maxPricePence: 75_000_000, types: ["Detached"], outcodes: ["LL41"] }),
    );
    expect(text).toContain("barn conversion");
    expect(text).toContain("Property types: Detached");
    expect(text).toContain("At least 3 bedrooms");
    expect(text).toContain("£750,000");
    expect(text).toContain("LL41");
  });

  it("searchHasTaste is true for keywords or structured prefs, false for a location-only search", () => {
    expect(searchHasTaste(search({ keywords: "stone cottage" }))).toBe(true);
    expect(searchHasTaste(search({ keywords: "", minBedrooms: 2 }))).toBe(true);
    expect(searchHasTaste(search({ keywords: "", types: ["Detached"] }))).toBe(true);
    expect(
      searchHasTaste(
        search({ keywords: "  ", minBedrooms: null, maxPricePence: null, types: [], condition: [], land: [] }),
      ),
    ).toBe(false);
  });
});
