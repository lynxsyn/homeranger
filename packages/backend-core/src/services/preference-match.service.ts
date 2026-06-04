/**
 * PreferenceMatchService — per-search match scoring (supersedes the M5 single
 * global SearchProfile path). A listing is scored against the taste of each
 * active OPERATOR Search whose outcodes contain it, with a hybrid vector + LLM
 * score, so two searches rank the same home differently.
 *
 * Two paths, both upserting one `ListingScore` per (listing, search):
 *   1. scoreListing(listingId) — the analyze:listing "match" step. For a freshly
 *      ingested + embedded listing, find the active operator searches covering its
 *      outcode (capped), and score the listing against each (one bounded LLM
 *      re-score per search). Lazily embeds a search's keywords if not done yet, so
 *      this path is self-sufficient and never waits on a recompute.
 *   2. recomputeSearch(searchId) — the search-change re-rank. Embed the search's
 *      taste, vectorTopK recall its top-K candidate listings (structured
 *      pre-filter applied BEFORE ranking), Claude re-scores ONLY those K (the core
 *      cost control), upsert per (listing, search). recomputeAll() loops every
 *      active operator search.
 *
 * Scope (mirrors the existing preferences.router decision): scoring is the
 * OPERATOR's engine — only `userId IS NULL` searches drive scoring of the global
 * catalogue. A non-operator's searches are stored but not scored (per-user
 * matching is a future enhancement).
 *
 * Cost: the kill-switch (ANALYSIS_KILL_SWITCH) short-circuits the recompute paths
 * (analyze:listing is already gated by ListingAnalysisService before scoreListing
 * runs); the per-listing fan-out is bounded by MATCH_MAX_SEARCHES_PER_LISTING and
 * each recompute by MATCH_TOP_K.
 *
 * DI (backend.md): interface + Default impl with `deps.x ?? defaultX`, no direct
 * Prisma (everything via repositories), a bottom `let` singleton + test setter.
 */
import {
  listingRepository,
  type ListingFilter,
  type ListingRecord,
  type ListingRepository,
} from "../repositories/listing.repository.js";
import {
  searchRepository,
  type SearchRecord,
  type SearchRepository,
} from "../repositories/search.repository.js";
import {
  listingScoreRepository,
  type ListingScoreRepository,
} from "../repositories/listing-score.repository.js";
import type { EmbeddingProvider } from "../lib/ai/embedding-provider.js";
import type { MatchScorer } from "../lib/ai/match-scorer.provider.js";

/** Result of recomputing ONE search's top-K re-rank. */
export interface MatchRecomputeResult {
  /** False when the search is empty/blank (no taste) or the kill-switch is on. */
  searchEmbedded: boolean;
  candidates: number;
  scored: number;
}

/** Result of recomputing every active operator search. */
export interface RecomputeAllResult {
  searchesRecomputed: number;
  scored: number;
}

/** Result of the per-listing match step (analyze:listing). */
export interface ScoreListingResult {
  /** True iff the listing was scored against at least one search. */
  scored: boolean;
  /** How many searches the listing was scored against this run. */
  searchesScored: number;
}

export interface PreferenceMatchService {
  /**
   * Re-rank ONE search's top-K (the search-change trigger): embed the search's
   * taste → vectorTopK recall → Claude re-scores ONLY the top-K → upsert one
   * ListingScore per (listing, search). Bounded to the top-K re-score.
   */
  recomputeSearch(
    searchId: string,
    opts?: { k?: number },
  ): Promise<MatchRecomputeResult>;
  /** Re-rank EVERY active operator search (the full backfill). */
  recomputeAll(opts?: { k?: number }): Promise<RecomputeAllResult>;
  /**
   * Per-listing match (analyze:listing): score ONE listing against each active
   * operator search covering its outcode (capped), so an analysed listing always
   * gets a ListingScore as soon as it lands — even outside any search's top-K.
   */
  scoreListing(listingId: string): Promise<ScoreListingResult>;
}

/** Clamp a value into the [0,1] contract combinedScore/vectorScore must hold. */
function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** ANALYSIS_KILL_SWITCH — the hard off-switch for paid analysis/scoring spend. */
function isAnalysisKilled(): boolean {
  return (
    process.env.ANALYSIS_KILL_SWITCH === "1" ||
    process.env.ANALYSIS_KILL_SWITCH === "true"
  );
}

export interface PreferenceMatchConfig {
  topK: number;
  weightVector: number;
  weightLlm: number;
  /** Max searches a single listing is scored against per analyze run (cost bound). */
  maxSearchesPerListing: number;
}

export function getPreferenceMatchConfig(): PreferenceMatchConfig {
  const wVec = Number.parseFloat(process.env.MATCH_WEIGHT_VECTOR ?? "0.4");
  const wLlm = Number.parseFloat(process.env.MATCH_WEIGHT_LLM ?? "0.6");
  return {
    topK: Number.parseInt(process.env.MATCH_TOP_K ?? "25", 10),
    weightVector: wVec,
    weightLlm: wLlm,
    maxSearchesPerListing: Number.parseInt(
      process.env.MATCH_MAX_SEARCHES_PER_LISTING ?? "10",
      10,
    ),
  };
}

interface PreferenceMatchDeps {
  embeddingProvider: EmbeddingProvider;
  matchScorer: MatchScorer;
  config?: PreferenceMatchConfig;
  listingRepository?: ListingRepository;
  searchRepository?: SearchRepository;
  listingScoreRepository?: ListingScoreRepository;
}

/** Compact, deterministic free-text description of a listing for the LLM. */
export function describeListing(listing: ListingRecord): string {
  const parts: string[] = [listing.addressNormalized];
  if (listing.propertyType) parts.push(listing.propertyType.replace(/_/g, " "));
  if (listing.bedrooms !== null) parts.push(`${listing.bedrooms} bed`);
  if (listing.tenure) parts.push(listing.tenure.replace(/_/g, " "));
  if (listing.epcRating && listing.epcRating !== "unknown") {
    parts.push(`EPC ${listing.epcRating.toUpperCase()}`);
  }
  if (listing.outcode) parts.push(listing.outcode);
  if (listing.pricePence !== null) {
    parts.push(`£${Math.round(listing.pricePence / 100).toLocaleString("en-GB")}`);
  }
  return parts.join(", ");
}

/**
 * The search's taste rendered as the embedding / LLM query text: the free-text
 * `keywords` first (the buyer's own words), then the structured brief. Mirrors
 * the old buildProfileText shape so the LLM prompt + vector stay consistent.
 */
export function buildSearchText(search: SearchRecord): string {
  const lines: string[] = [];
  if (search.keywords.trim()) lines.push(search.keywords.trim());
  if (search.types.length > 0) lines.push(`Property types: ${search.types.join(", ")}.`);
  if (search.condition.length > 0) lines.push(`Condition: ${search.condition.join(", ")}.`);
  if (search.land.length > 0) lines.push(`Land: ${search.land.join(", ")}.`);
  if (search.minBedrooms !== null) lines.push(`At least ${search.minBedrooms} bedrooms.`);
  if (search.maxPricePence !== null) {
    lines.push(`Budget up to £${Math.round(search.maxPricePence / 100).toLocaleString("en-GB")}.`);
  }
  if (search.outcodes.length > 0) lines.push(`Areas: ${search.outcodes.join(", ")}.`);
  return lines.join(" ");
}

/**
 * Whether a search carries enough TASTE to score against. Outcodes alone (WHERE,
 * not WHAT) and the `saleMethods` default do not count — a search with only a
 * location is "blank" and is skipped (logged), exactly as the old empty-profile
 * guard skipped a blank profile.
 */
export function searchHasTaste(search: SearchRecord): boolean {
  return (
    search.keywords.trim().length > 0 ||
    search.minBedrooms !== null ||
    search.maxPricePence !== null ||
    search.types.length > 0 ||
    search.condition.length > 0 ||
    search.land.length > 0
  );
}

/** The structured pre-filter applied BEFORE vectorTopK ranking, from a search. */
function buildSearchPrefilter(search: SearchRecord): ListingFilter | undefined {
  const filter: ListingFilter = {};
  if (search.minBedrooms !== null) filter.minBedrooms = search.minBedrooms;
  if (search.maxPricePence !== null) filter.maxPricePence = search.maxPricePence;
  if (search.outcodes.length > 0) filter.outcodes = search.outcodes;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

/** Cosine distance (`<=>`, 0..2) → similarity in [0,1]. */
export function vectorScoreFromDistance(distance: number): number {
  return Math.min(1, Math.max(0, 1 - distance));
}

function logInfo(scope: string, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ type: "info", scope, ...extra }));
}

export class DefaultPreferenceMatchService implements PreferenceMatchService {
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly matchScorer: MatchScorer;
  private readonly config: PreferenceMatchConfig;
  private readonly listingRepository: ListingRepository;
  private readonly searchRepository: SearchRepository;
  private readonly listingScoreRepository: ListingScoreRepository;

  constructor(deps: PreferenceMatchDeps) {
    this.embeddingProvider = deps.embeddingProvider;
    this.matchScorer = deps.matchScorer;
    this.config = deps.config ?? getPreferenceMatchConfig();
    this.listingRepository = deps.listingRepository ?? listingRepository;
    this.searchRepository = deps.searchRepository ?? searchRepository;
    this.listingScoreRepository =
      deps.listingScoreRepository ?? listingScoreRepository;
  }

  async recomputeSearch(
    searchId: string,
    opts: { k?: number } = {},
  ): Promise<MatchRecomputeResult> {
    if (isAnalysisKilled()) {
      logInfo("match.recompute.skipped.kill_switch", { searchId });
      return { searchEmbedded: false, candidates: 0, scored: 0 };
    }
    // Operator-scoped: only the operator's searches drive global-catalogue scoring.
    const search = await this.searchRepository.getById(searchId, null);
    if (!search) {
      return { searchEmbedded: false, candidates: 0, scored: 0 };
    }
    return this.recomputeForSearch(search, opts.k ?? this.config.topK);
  }

  async recomputeAll(opts: { k?: number } = {}): Promise<RecomputeAllResult> {
    if (isAnalysisKilled()) {
      logInfo("match.recompute.skipped.kill_switch");
      return { searchesRecomputed: 0, scored: 0 };
    }
    const k = opts.k ?? this.config.topK;
    const searches = await this.searchRepository.listActive(null);
    let searchesRecomputed = 0;
    let scored = 0;
    for (const search of searches) {
      const result = await this.recomputeForSearch(search, k);
      if (result.searchEmbedded) {
        searchesRecomputed += 1;
        scored += result.scored;
      }
    }
    return { searchesRecomputed, scored };
  }

  /** Embed one search + re-score its top-K candidates. Shared by both triggers. */
  private async recomputeForSearch(
    search: SearchRecord,
    k: number,
  ): Promise<MatchRecomputeResult> {
    if (!searchHasTaste(search)) {
      logInfo("match.recompute.skipped.empty_search", { searchId: search.id });
      return { searchEmbedded: false, candidates: 0, scored: 0 };
    }
    const searchText = buildSearchText(search);
    const embedded = await this.embeddingProvider.embed(searchText, {
      inputType: "query",
    });
    await this.searchRepository.writeKeywordsEmbedding(
      search.id,
      embedded.embedding,
    );

    const candidates = await this.listingRepository.vectorTopK(
      embedded.embedding,
      k,
      buildSearchPrefilter(search),
    );

    let scored = 0;
    for (const candidate of candidates) {
      const vectorScore = vectorScoreFromDistance(candidate.distance);
      const match = await this.matchScorer.scoreMatch({
        profileText: searchText,
        listingDescription: describeListing(candidate),
      });
      const combinedScore = clampUnit(
        this.config.weightVector * vectorScore +
          this.config.weightLlm * match.llmScore,
      );
      await this.listingScoreRepository.upsertByListingAndSearch({
        listingId: candidate.id,
        searchId: search.id,
        vectorScore,
        llmScore: match.llmScore,
        combinedScore,
        rationale: match.rationale,
      });
      scored += 1;
    }

    return { searchEmbedded: true, candidates: candidates.length, scored };
  }

  async scoreListing(listingId: string): Promise<ScoreListingResult> {
    const listing = await this.listingRepository.getById(listingId);
    if (!listing) {
      return { scored: false, searchesScored: 0 };
    }
    if (!listing.outcode) {
      // No outcode → cannot be matched to any search's patch (logged, not silent).
      logInfo("match.score.skipped.no_outcode", { listingId });
      return { scored: false, searchesScored: 0 };
    }

    const searches = await this.searchRepository.listActiveByOutcode(
      listing.outcode,
      null,
      this.config.maxSearchesPerListing,
    );
    if (searches.length === 0) {
      logInfo("match.score.skipped.no_matching_search", {
        listingId,
        outcode: listing.outcode,
      });
      return { scored: false, searchesScored: 0 };
    }

    let searchesScored = 0;
    for (const search of searches) {
      // Reuse the persisted keyword vector; embed it on the fly if a recompute
      // has not run yet (so a newly ingested listing scores immediately).
      let embedding = await this.searchRepository.readKeywordsEmbedding(
        search.id,
      );
      if (!embedding) {
        if (!searchHasTaste(search)) {
          continue; // blank search → nothing to score against.
        }
        const fresh = await this.embeddingProvider.embed(
          buildSearchText(search),
          { inputType: "query" },
        );
        embedding = fresh.embedding;
        await this.searchRepository.writeKeywordsEmbedding(search.id, embedding);
      }

      const distance = await this.listingRepository.vectorDistanceFor(
        listingId,
        embedding,
      );
      if (distance === null) {
        // The listing has no embedding yet (race) → no search can score it; a
        // later analyze run will. Stop (the embedding is shared across searches).
        logInfo("match.score.skipped.listing_unembedded", { listingId });
        break;
      }

      const vectorScore = vectorScoreFromDistance(distance);
      const match = await this.matchScorer.scoreMatch({
        profileText: buildSearchText(search),
        listingDescription: describeListing(listing),
      });
      const combinedScore = clampUnit(
        this.config.weightVector * vectorScore +
          this.config.weightLlm * match.llmScore,
      );
      await this.listingScoreRepository.upsertByListingAndSearch({
        listingId,
        searchId: search.id,
        vectorScore,
        llmScore: match.llmScore,
        combinedScore,
        rationale: match.rationale,
      });
      searchesScored += 1;
    }

    return { scored: searchesScored > 0, searchesScored };
  }
}

let singleton: PreferenceMatchService | null = null;

/** Lazy singleton — the worker injects the real providers via `deps`. */
export function getPreferenceMatchService(
  deps?: PreferenceMatchDeps,
): PreferenceMatchService {
  if (deps) {
    singleton = new DefaultPreferenceMatchService(deps);
    return singleton;
  }
  if (!singleton) {
    throw new Error(
      "PreferenceMatchService not initialised — call getPreferenceMatchService(deps) at worker boot",
    );
  }
  return singleton;
}

export function _setPreferenceMatchServiceForTesting(
  service: PreferenceMatchService | null,
): void {
  singleton = service;
}
