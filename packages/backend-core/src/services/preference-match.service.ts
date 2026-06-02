/**
 * PreferenceMatchService (M5 spec AC#3 + #5) — ranks listings against the single
 * SearchProfile with a hybrid vector + LLM score.
 *
 * Flow:
 *   1. Build the profile query text (freeTextPreferences + structured filters)
 *      and embed it (Voyage) → persist `SearchProfile.preferenceEmbedding`.
 *   2. `listingRepository.vectorTopK` recalls the top-K candidate listings
 *      (cosine ANN, with the structured pre-filter applied BEFORE ranking).
 *   3. Claude (Haiku) re-scores ONLY those K candidates — never the full corpus
 *      (the core cost control). `combinedScore = wVec·vectorScore + wLlm·llmScore`.
 *   4. Upsert one `ListingScore` per candidate (vectorScore, llmScore,
 *      combinedScore, rationale) — what the listings table sorts by.
 *
 * DI (backend.md): interface + Default impl with `deps.x ?? defaultX`, no direct
 * Prisma (everything via repositories), a bottom `let` singleton + test setter.
 */
import {
  listingRepository,
  type ListingFilter,
  type ListingRepository,
  type VectorTopKResult,
} from "../repositories/listing.repository.js";
import {
  searchProfileRepository,
  type SearchProfileRecord,
  type SearchProfileRepository,
} from "../repositories/search-profile.repository.js";
import {
  listingScoreRepository,
  type ListingScoreRepository,
} from "../repositories/listing-score.repository.js";
import type { EmbeddingProvider } from "../lib/ai/embedding-provider.js";
import type { MatchScorer } from "../lib/ai/match-scorer.provider.js";

export interface MatchRecomputeResult {
  /** False when the profile is empty (nothing to match) → a no-op recompute. */
  profileEmbedded: boolean;
  candidates: number;
  scored: number;
}

export interface PreferenceMatchService {
  recompute(opts?: { k?: number }): Promise<MatchRecomputeResult>;
}

export interface PreferenceMatchConfig {
  topK: number;
  weightVector: number;
  weightLlm: number;
}

export function getPreferenceMatchConfig(): PreferenceMatchConfig {
  const wVec = Number.parseFloat(process.env.MATCH_WEIGHT_VECTOR ?? "0.4");
  const wLlm = Number.parseFloat(process.env.MATCH_WEIGHT_LLM ?? "0.6");
  return {
    topK: Number.parseInt(process.env.MATCH_TOP_K ?? "25", 10),
    weightVector: wVec,
    weightLlm: wLlm,
  };
}

interface PreferenceMatchDeps {
  embeddingProvider: EmbeddingProvider;
  matchScorer: MatchScorer;
  config?: PreferenceMatchConfig;
  listingRepository?: ListingRepository;
  searchProfileRepository?: SearchProfileRepository;
  listingScoreRepository?: ListingScoreRepository;
}

/** Compact, deterministic free-text description of a listing for the LLM. */
export function describeListing(listing: VectorTopKResult): string {
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

/** The profile preferences rendered as the embedding/LLM query text. */
export function buildProfileText(profile: SearchProfileRecord): string {
  const lines: string[] = [];
  if (profile.freeTextPreferences.trim()) {
    lines.push(profile.freeTextPreferences.trim());
  }
  if (profile.minBedrooms !== null) lines.push(`At least ${profile.minBedrooms} bedrooms.`);
  if (profile.maxPricePence !== null) {
    lines.push(`Budget up to £${Math.round(profile.maxPricePence / 100).toLocaleString("en-GB")}.`);
  }
  if (profile.outcodes.length > 0) lines.push(`Areas: ${profile.outcodes.join(", ")}.`);
  if (profile.requiredTenure) lines.push(`Tenure: ${profile.requiredTenure.replace(/_/g, " ")}.`);
  return lines.join(" ");
}

function buildPrefilter(profile: SearchProfileRecord): ListingFilter | undefined {
  const filter: ListingFilter = {};
  if (profile.minBedrooms !== null) filter.minBedrooms = profile.minBedrooms;
  if (profile.maxPricePence !== null) filter.maxPricePence = profile.maxPricePence;
  if (profile.outcodes.length > 0) filter.outcodes = profile.outcodes;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

/** Cosine distance (`<=>`, 0..2) → similarity in [0,1]. */
export function vectorScoreFromDistance(distance: number): number {
  return Math.min(1, Math.max(0, 1 - distance));
}

export class DefaultPreferenceMatchService implements PreferenceMatchService {
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly matchScorer: MatchScorer;
  private readonly config: PreferenceMatchConfig;
  private readonly listingRepository: ListingRepository;
  private readonly searchProfileRepository: SearchProfileRepository;
  private readonly listingScoreRepository: ListingScoreRepository;

  constructor(deps: PreferenceMatchDeps) {
    this.embeddingProvider = deps.embeddingProvider;
    this.matchScorer = deps.matchScorer;
    this.config = deps.config ?? getPreferenceMatchConfig();
    this.listingRepository = deps.listingRepository ?? listingRepository;
    this.searchProfileRepository =
      deps.searchProfileRepository ?? searchProfileRepository;
    this.listingScoreRepository =
      deps.listingScoreRepository ?? listingScoreRepository;
  }

  async recompute(opts: { k?: number } = {}): Promise<MatchRecomputeResult> {
    const k = opts.k ?? this.config.topK;
    const profile = await this.searchProfileRepository.getOrCreate();
    const profileText = buildProfileText(profile);

    if (profileText.trim().length === 0) {
      console.info(
        JSON.stringify({
          type: "info",
          scope: "match.recompute.skipped.empty_profile",
        }),
      );
      return { profileEmbedded: false, candidates: 0, scored: 0 };
    }

    const embedded = await this.embeddingProvider.embed(profileText, {
      inputType: "query",
    });
    await this.searchProfileRepository.writePreferenceEmbedding(
      embedded.embedding,
    );

    const candidates = await this.listingRepository.vectorTopK(
      embedded.embedding,
      k,
      buildPrefilter(profile),
    );

    // Re-score ONLY the K recalled candidates (never the full corpus).
    let scored = 0;
    for (const candidate of candidates) {
      const vectorScore = vectorScoreFromDistance(candidate.distance);
      const match = await this.matchScorer.scoreMatch({
        profileText,
        listingDescription: describeListing(candidate),
      });
      const combinedScore =
        this.config.weightVector * vectorScore +
        this.config.weightLlm * match.llmScore;
      await this.listingScoreRepository.upsertByListingId({
        listingId: candidate.id,
        vectorScore,
        llmScore: match.llmScore,
        combinedScore,
        rationale: match.rationale,
      });
      scored += 1;
    }

    return {
      profileEmbedded: true,
      candidates: candidates.length,
      scored,
    };
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
