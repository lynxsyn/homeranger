/**
 * ListingAnalysisService (M5 spec AC#1 + #4 + #5) — the per-listing orchestration
 * the `analyze:listing` worker runs:
 *
 *   kill-switch → photos → (dedup → Haiku vision → persist PhotoAnalysis) →
 *   embed the listing text (Voyage) → writeEmbedding → preference re-match.
 *
 * Cost controls (AC#5): `imageHash` dedup skips already-analysed images;
 * `costPence` is recorded per vision call; a monthly-spend kill-switch (an env
 * flag OR a budget compared against the month's persisted PhotoAnalysis spend)
 * short-circuits analysis and LOGS the skip (never silent).
 *
 * DI (backend.md): interface + Default impl with `deps.x ?? defaultX`, no direct
 * Prisma; transport-free typed errors (`ListingAnalysisError.retryable`) the
 * worker maps to BullMQ retry. The vision/embedding providers + photo source +
 * preference-match service are injected by the worker (real vs ANALYSIS_FAKE).
 */
import {
  listingRepository,
  type ListingRecord,
  type ListingRepository,
} from "../repositories/listing.repository.js";
import {
  photoAnalysisRepository,
  type PhotoAnalysisRepository,
} from "../repositories/photo-analysis.repository.js";
import type { EmbeddingProvider } from "../lib/ai/embedding-provider.js";
import type {
  PhotoFeatures,
  VisionScorer,
} from "../lib/ai/vision-scorer.provider.js";
import type { PhotoSource } from "../lib/ai/photo-source.js";
import { analysisKillSwitchTotal } from "../lib/ai/analysis-metrics.js";
import type {
  PreferenceMatchService,
  ScoreListingResult,
} from "./preference-match.service.js";

export interface AnalyzeListingResult {
  listingId: string;
  skipped: boolean;
  skipReason?: "kill_switch_flag" | "monthly_budget";
  photosAnalyzed: number;
  photosSkipped: number;
  embedded: boolean;
  match: ScoreListingResult | null;
}

export interface ListingAnalysisService {
  analyzeListing(listingId: string): Promise<AnalyzeListingResult>;
}

/** Transport-free typed error; `retryable` drives the worker's retry decision. */
export class ListingAnalysisError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ListingAnalysisError";
    this.retryable = retryable;
  }
}

export interface ListingAnalysisConfig {
  /** Hard off-switch (ANALYSIS_KILL_SWITCH=1) — short-circuits all analysis. */
  killSwitch: boolean;
  /** Monthly spend ceiling in pence; 0 disables the budget check. */
  monthlyBudgetPence: number;
}

export function getListingAnalysisConfig(): ListingAnalysisConfig {
  return {
    killSwitch:
      process.env.ANALYSIS_KILL_SWITCH === "1" ||
      process.env.ANALYSIS_KILL_SWITCH === "true",
    monthlyBudgetPence: Number.parseInt(
      process.env.ANALYSIS_MONTHLY_BUDGET_PENCE ?? "0",
      10,
    ),
  };
}

interface ListingAnalysisDeps {
  visionScorer: VisionScorer;
  embeddingProvider: EmbeddingProvider;
  photoSource: PhotoSource;
  preferenceMatchService: PreferenceMatchService;
  config?: ListingAnalysisConfig;
  listingRepository?: ListingRepository;
  photoAnalysisRepository?: PhotoAnalysisRepository;
  /** Injectable clock so tests pin the month boundary deterministically. */
  now?: () => Date;
}

/** First instant of the current UTC month — the kill-switch spend window start. */
function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** A short context hint passed to the vision model to ground the scoring. */
function buildListingContext(listing: ListingRecord): string {
  const parts: string[] = [];
  if (listing.propertyType) parts.push(listing.propertyType.replace(/_/g, " "));
  if (listing.bedrooms !== null) parts.push(`${listing.bedrooms} bed`);
  if (listing.outcode) parts.push(listing.outcode);
  return parts.join(", ") || listing.addressNormalized;
}

/** The text embedded as `Listing.embedding` — fields + this run's photo features. */
export function buildListingEmbeddingText(
  listing: ListingRecord,
  features: PhotoFeatures[],
): string {
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
  const featureWords = new Set<string>();
  for (const f of features) {
    for (const v of [f.style, f.condition, f.naturalLight, f.outdoorSpace]) {
      if (v) featureWords.add(v);
    }
    for (const h of f.highlights) featureWords.add(h);
  }
  if (featureWords.size > 0) {
    parts.push(`Features: ${[...featureWords].join(", ")}`);
  }
  return parts.join(", ");
}

export class DefaultListingAnalysisService implements ListingAnalysisService {
  private readonly visionScorer: VisionScorer;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly photoSource: PhotoSource;
  private readonly preferenceMatchService: PreferenceMatchService;
  private readonly config: ListingAnalysisConfig;
  private readonly listingRepository: ListingRepository;
  private readonly photoAnalysisRepository: PhotoAnalysisRepository;
  private readonly now: () => Date;

  constructor(deps: ListingAnalysisDeps) {
    this.visionScorer = deps.visionScorer;
    this.embeddingProvider = deps.embeddingProvider;
    this.photoSource = deps.photoSource;
    this.preferenceMatchService = deps.preferenceMatchService;
    this.config = deps.config ?? getListingAnalysisConfig();
    this.listingRepository = deps.listingRepository ?? listingRepository;
    this.photoAnalysisRepository =
      deps.photoAnalysisRepository ?? photoAnalysisRepository;
    this.now = deps.now ?? (() => new Date());
  }

  async analyzeListing(listingId: string): Promise<AnalyzeListingResult> {
    const killed = await this.killSwitchReason(listingId);
    if (killed) {
      return {
        listingId,
        skipped: true,
        skipReason: killed,
        photosAnalyzed: 0,
        photosSkipped: 0,
        embedded: false,
        match: null,
      };
    }

    const listing = await this.listingRepository.getById(listingId);
    if (!listing) {
      // A missing listing is a programming/race error, not transient.
      throw new ListingAnalysisError(`Listing ${listingId} not found`, false);
    }

    const photos = await this.photoSource.getPhotos(listingId);
    const context = buildListingContext(listing);
    const analysedFeatures: PhotoFeatures[] = [];
    let photosAnalyzed = 0;
    let photosSkipped = 0;

    for (const photo of photos) {
      const existing = await this.photoAnalysisRepository.findByImageHash(
        photo.imageHash,
      );
      if (existing) {
        // Already analysed → skip (no re-bill). Reuse its features for the embed.
        photosSkipped += 1;
        const reused = coercePhotoFeatures(existing.featuresJson);
        if (reused) analysedFeatures.push(reused);
        continue;
      }
      const score = await this.visionScorer.scorePhoto({
        data: photo.data,
        mediaType: photo.mediaType,
        context,
      });
      await this.photoAnalysisRepository.upsertByImageHash({
        listingId,
        imageHash: photo.imageHash,
        imageUrl: photo.imageUrl,
        tasteScore: score.tasteScore,
        featuresJson: { ...score.features },
        model: score.metrics.model,
        costPence: score.metrics.costPence,
      });
      analysedFeatures.push(score.features);
      photosAnalyzed += 1;
    }

    // Embed the listing text (+ this run's photo features) and persist the vector.
    const embedded = await this.embeddingProvider.embed(
      buildListingEmbeddingText(listing, analysedFeatures),
      { inputType: "document" },
    );
    await this.listingRepository.writeEmbedding(listingId, embedded.embedding);

    // Score THIS listing against the profile (one bounded LLM re-score), so an
    // analysed listing always gets a ListingScore — even when it falls outside
    // the profile's top-K. The profile-wide top-K recompute is a separate,
    // bounded job fired on profile change (preferencesRouter.update).
    const match = await this.preferenceMatchService.scoreListing(listingId);

    return {
      listingId,
      skipped: false,
      photosAnalyzed,
      photosSkipped,
      embedded: true,
      match,
    };
  }

  /** Returns the kill-switch reason (logged + metered) or null when clear. */
  private async killSwitchReason(
    listingId: string,
  ): Promise<"kill_switch_flag" | "monthly_budget" | null> {
    if (this.config.killSwitch) {
      this.logSkip(listingId, "kill_switch_flag");
      return "kill_switch_flag";
    }
    if (this.config.monthlyBudgetPence > 0) {
      const spent = await this.photoAnalysisRepository.sumCostPenceSince(
        startOfMonth(this.now()),
      );
      if (spent >= this.config.monthlyBudgetPence) {
        this.logSkip(listingId, "monthly_budget", spent);
        return "monthly_budget";
      }
    }
    return null;
  }

  private logSkip(
    listingId: string,
    reason: "kill_switch_flag" | "monthly_budget",
    spentPence?: number,
  ): void {
    analysisKillSwitchTotal.labels({ reason }).inc();
    console.warn(
      JSON.stringify({
        type: "warn",
        scope: "analyze.skipped.kill_switch",
        reason,
        listingId,
        ...(spentPence !== undefined ? { spentPence } : {}),
        budgetPence: this.config.monthlyBudgetPence,
      }),
    );
  }
}

/** Best-effort coerce a stored featuresJson back to PhotoFeatures (for re-embed). */
function coercePhotoFeatures(value: unknown): PhotoFeatures | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  return {
    style: typeof v.style === "string" ? v.style : null,
    condition: typeof v.condition === "string" ? v.condition : null,
    naturalLight: typeof v.naturalLight === "string" ? v.naturalLight : null,
    outdoorSpace: typeof v.outdoorSpace === "string" ? v.outdoorSpace : null,
    highlights: Array.isArray(v.highlights)
      ? v.highlights.filter((h): h is string => typeof h === "string")
      : [],
  };
}

let singleton: ListingAnalysisService | null = null;

/** Lazy singleton — the worker injects the real/fake providers via `deps`. */
export function getListingAnalysisService(
  deps?: ListingAnalysisDeps,
): ListingAnalysisService {
  if (deps) {
    singleton = new DefaultListingAnalysisService(deps);
    return singleton;
  }
  if (!singleton) {
    throw new Error(
      "ListingAnalysisService not initialised — call getListingAnalysisService(deps) at worker boot",
    );
  }
  return singleton;
}

export function _setListingAnalysisServiceForTesting(
  service: ListingAnalysisService | null,
): void {
  singleton = service;
}
