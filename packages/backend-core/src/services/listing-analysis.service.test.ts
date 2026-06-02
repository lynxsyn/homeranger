/**
 * Unit tests for ListingAnalysisService (M5 test plan, Unit row 1 dedup/cost +
 * the kill-switch behaviour the integration row also covers). All collaborators
 * are mocked (no DB, no network, no spend).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultListingAnalysisService,
  ListingAnalysisError,
  buildListingEmbeddingText,
  getListingAnalysisConfig,
  getListingAnalysisService,
  _setListingAnalysisServiceForTesting,
  type ListingAnalysisConfig,
} from "./listing-analysis.service.js";
import type { EmbeddingProvider } from "../lib/ai/embedding-provider.js";
import type {
  PhotoFeatures,
  VisionScorer,
} from "../lib/ai/vision-scorer.provider.js";
import type { AnalyzablePhoto, PhotoSource } from "../lib/ai/photo-source.js";
import type {
  ListingRecord,
  ListingRepository,
} from "../repositories/listing.repository.js";
import type { PhotoAnalysisRepository } from "../repositories/photo-analysis.repository.js";
import type { PreferenceMatchService } from "./preference-match.service.js";

const CONFIG: ListingAnalysisConfig = { killSwitch: false, monthlyBudgetPence: 0 };

const FEATURES: PhotoFeatures = {
  style: "modern",
  condition: "good",
  naturalLight: "bright",
  outdoorSpace: "garden",
  highlights: ["bay window"],
};

function listing(): ListingRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    addressNormalized: "7 test road se1",
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
  } as ListingRecord;
}

function photo(hash: string): AnalyzablePhoto {
  return {
    imageHash: hash,
    imageUrl: `r2://b/${hash}`,
    data: Buffer.from(hash),
    mediaType: "image/jpeg",
  };
}

interface Harness {
  service: DefaultListingAnalysisService;
  scorePhoto: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  getPhotos: ReturnType<typeof vi.fn>;
  scoreListing: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  writeEmbedding: ReturnType<typeof vi.fn>;
  findByImageHash: ReturnType<typeof vi.fn>;
  upsertByImageHash: ReturnType<typeof vi.fn>;
  sumCostPenceSince: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  photos?: AnalyzablePhoto[];
  config?: ListingAnalysisConfig;
  listingRecord?: ListingRecord | null;
  costPence?: number;
  monthSpendPence?: number;
} = {}): Harness {
  const scorePhoto = vi.fn().mockResolvedValue({
    tasteScore: 77,
    features: FEATURES,
    metrics: {
      model: "claude-haiku-4-5",
      inputTokens: 0,
      outputTokens: 0,
      costPence: opts.costPence ?? 3,
      durationMs: 0,
    },
  });
  const embed = vi.fn().mockResolvedValue({
    embedding: Array.from({ length: 1024 }, () => 0.01),
    metrics: { model: "voyage-3.5", totalTokens: 0, costPence: 0, durationMs: 0 },
  });
  const getPhotos = vi.fn().mockResolvedValue(opts.photos ?? [photo("h1")]);
  const scoreListing = vi.fn().mockResolvedValue({ scored: true });
  const getById = vi
    .fn()
    .mockResolvedValue(opts.listingRecord === undefined ? listing() : opts.listingRecord);
  const writeEmbedding = vi.fn().mockResolvedValue(1);
  const findByImageHash = vi.fn().mockResolvedValue(null);
  const upsertByImageHash = vi.fn().mockResolvedValue({});
  const sumCostPenceSince = vi.fn().mockResolvedValue(opts.monthSpendPence ?? 0);

  const service = new DefaultListingAnalysisService({
    visionScorer: { scorePhoto, getModel: () => "claude-haiku-4-5" } as unknown as VisionScorer,
    embeddingProvider: { embed, getModel: () => "voyage-3.5", getDimensions: () => 1024 } as unknown as EmbeddingProvider,
    photoSource: { getPhotos } as unknown as PhotoSource,
    preferenceMatchService: { scoreListing } as unknown as PreferenceMatchService,
    config: opts.config ?? CONFIG,
    listingRepository: { getById, writeEmbedding } as unknown as ListingRepository,
    photoAnalysisRepository: {
      findByImageHash,
      upsertByImageHash,
      sumCostPenceSince,
    } as unknown as PhotoAnalysisRepository,
    now: () => new Date("2026-06-15T00:00:00Z"),
  });

  return {
    service,
    scorePhoto,
    embed,
    getPhotos,
    scoreListing,
    getById,
    writeEmbedding,
    findByImageHash,
    upsertByImageHash,
    sumCostPenceSince,
  };
}

describe("DefaultListingAnalysisService.analyzeListing", () => {
  it("scores new photos, persists costPence, embeds, and re-matches", async () => {
    const h = makeHarness({ photos: [photo("h1")], costPence: 4 });
    const result = await h.service.analyzeListing(listing().id);

    expect(result.skipped).toBe(false);
    expect(result.photosAnalyzed).toBe(1);
    expect(result.photosSkipped).toBe(0);
    expect(result.embedded).toBe(true);
    expect(result.match).toEqual({ scored: true });

    // PhotoAnalysis persisted with the vision cost + model.
    const persisted = h.upsertByImageHash.mock.calls[0]![0] as {
      tasteScore: number;
      costPence: number;
      model: string;
    };
    expect(persisted.tasteScore).toBe(77);
    expect(persisted.costPence).toBe(4);
    expect(persisted.model).toBe("claude-haiku-4-5");

    expect(h.writeEmbedding).toHaveBeenCalledTimes(1);
    expect(h.scoreListing).toHaveBeenCalledWith(listing().id);
  });

  it("dedups by imageHash — an already-analysed photo is NOT re-scored", async () => {
    const h = makeHarness({ photos: [photo("dup"), photo("new")] });
    // First photo already analysed, second is new.
    h.findByImageHash
      .mockResolvedValueOnce({ imageHash: "dup", featuresJson: FEATURES })
      .mockResolvedValueOnce(null);

    const result = await h.service.analyzeListing(listing().id);

    expect(result.photosSkipped).toBe(1);
    expect(result.photosAnalyzed).toBe(1);
    // Vision called once (for the new photo only) — no re-bill of the dup.
    expect(h.scorePhoto).toHaveBeenCalledTimes(1);
    expect(h.upsertByImageHash).toHaveBeenCalledTimes(1);
  });

  it("scores every NEW photo (3 photos → 3 scoring calls)", async () => {
    const h = makeHarness({ photos: [photo("n1"), photo("n2"), photo("n3")] });
    const result = await h.service.analyzeListing(listing().id);
    expect(result.photosAnalyzed).toBe(3);
    expect(h.scorePhoto).toHaveBeenCalledTimes(3);
    expect(h.upsertByImageHash).toHaveBeenCalledTimes(3);
  });

  it("tolerates a non-object stored featuresJson on a deduped photo", async () => {
    const h = makeHarness({ photos: [photo("dup")] });
    h.findByImageHash.mockResolvedValueOnce({ imageHash: "dup", featuresJson: null });
    const result = await h.service.analyzeListing(listing().id);
    expect(result.photosSkipped).toBe(1);
    expect(result.embedded).toBe(true);
  });

  it("short-circuits when the kill-switch flag is set (no vision/embed/match)", async () => {
    const h = makeHarness({
      config: { killSwitch: true, monthlyBudgetPence: 0 },
    });
    const result = await h.service.analyzeListing(listing().id);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("kill_switch_flag");
    expect(h.getPhotos).not.toHaveBeenCalled();
    expect(h.scorePhoto).not.toHaveBeenCalled();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.scoreListing).not.toHaveBeenCalled();
  });

  it("short-circuits when the month's spend has reached the budget", async () => {
    const h = makeHarness({
      config: { killSwitch: false, monthlyBudgetPence: 1000 },
      monthSpendPence: 1000,
    });
    const result = await h.service.analyzeListing(listing().id);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("monthly_budget");
    expect(h.sumCostPenceSince).toHaveBeenCalledTimes(1);
    expect(h.scorePhoto).not.toHaveBeenCalled();
  });

  it("proceeds when spend is under the budget", async () => {
    const h = makeHarness({
      config: { killSwitch: false, monthlyBudgetPence: 1000 },
      monthSpendPence: 999,
    });
    const result = await h.service.analyzeListing(listing().id);
    expect(result.skipped).toBe(false);
    expect(h.scorePhoto).toHaveBeenCalledTimes(1);
  });

  it("embeds even when the listing has no photos", async () => {
    const h = makeHarness({ photos: [] });
    const result = await h.service.analyzeListing(listing().id);
    expect(result.photosAnalyzed).toBe(0);
    expect(result.embedded).toBe(true);
    expect(h.writeEmbedding).toHaveBeenCalledTimes(1);
  });

  it("throws a non-retryable error when the listing is missing", async () => {
    const h = makeHarness({ listingRecord: null });
    await expect(h.service.analyzeListing("missing")).rejects.toBeInstanceOf(
      ListingAnalysisError,
    );
    await expect(h.service.analyzeListing("missing")).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe("buildListingEmbeddingText", () => {
  it("includes listing fields + merged photo features", () => {
    const text = buildListingEmbeddingText(listing(), [FEATURES]);
    expect(text).toContain("flat");
    expect(text).toContain("2 bed");
    expect(text).toContain("£500,000");
    expect(text).toContain("Features:");
    expect(text).toContain("bay window");
  });

  it("omits the Features clause when there are no photo features", () => {
    const text = buildListingEmbeddingText(listing(), []);
    expect(text).not.toContain("Features:");
  });
});

describe("getListingAnalysisConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to kill-switch off + no budget", () => {
    const config = getListingAnalysisConfig();
    expect(config.killSwitch).toBe(false);
    expect(config.monthlyBudgetPence).toBe(0);
  });

  it("reads the kill-switch flag (1 or true) and the budget", () => {
    vi.stubEnv("ANALYSIS_KILL_SWITCH", "1");
    vi.stubEnv("ANALYSIS_MONTHLY_BUDGET_PENCE", "5000");
    const config = getListingAnalysisConfig();
    expect(config.killSwitch).toBe(true);
    expect(config.monthlyBudgetPence).toBe(5000);

    vi.stubEnv("ANALYSIS_KILL_SWITCH", "true");
    expect(getListingAnalysisConfig().killSwitch).toBe(true);
  });
});

describe("getListingAnalysisService", () => {
  afterEach(() => _setListingAnalysisServiceForTesting(null));

  it("throws when used before initialisation", () => {
    _setListingAnalysisServiceForTesting(null);
    expect(() => getListingAnalysisService()).toThrow(/not initialised/);
  });

  it("initialises a singleton from deps and returns it thereafter", () => {
    const h = makeHarness();
    const initialised = getListingAnalysisService({
      visionScorer: { scorePhoto: h.scorePhoto } as never,
      embeddingProvider: { embed: h.embed } as never,
      photoSource: { getPhotos: h.getPhotos } as never,
      preferenceMatchService: { scoreListing: h.scoreListing } as never,
    });
    expect(getListingAnalysisService()).toBe(initialised);
  });
});
