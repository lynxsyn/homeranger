/**
 * Claude **Haiku** vision scoring for the M5 analysis pipeline (spec AC#1 + #6).
 *
 * Per listing photo, one Haiku `messages.create` call returns a taste score
 * (0–100, how well the photo matches a tasteful UK-home aesthetic) plus a small
 * structured `features` object (style / condition / light / outdoor space /
 * highlights) the ListingsPage row-expand renders. Mirrors
 * `ClaudeExtractionProvider` exactly:
 *   - `output_config.format = { type: "json_schema", schema }` forces strict JSON;
 *   - the Anthropic client rides the Cloudflare AI Gateway when `CF_AI_GATEWAY_*`
 *     is set (same transparent proxy as extraction — analytics/cache/retries);
 *   - token + cost + duration metrics into the shared analysis registry;
 *   - retryable-vs-terminal classification via the shared `provider-errors`
 *     module (429/5xx retryable; 400/401/403/404 terminal), parse failures
 *     non-retryable;
 *   - DI pattern: interface + Default impl + `deps.client ?? defaultClient`, so
 *     unit tests inject a mocked Anthropic client (no network, no spend).
 *
 * Node16 module resolution → relative imports carry `.js`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropicGatewayClientOptions } from "./ai-gateway.js";
import {
  classifyProviderError,
  createNonRetryableError,
} from "./provider-errors.js";
import { recordAiCall } from "./analysis-metrics.js";

/** A photo to score: raw bytes + its media type, with optional listing context. */
export interface PhotoScoreInput {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** A short text hint (e.g. the listing address/type) to ground the scoring. */
  context?: string;
}

/** Structured visual features detected per photo (persisted as featuresJson). */
export interface PhotoFeatures {
  style: string | null;
  condition: string | null;
  naturalLight: string | null;
  outdoorSpace: string | null;
  highlights: string[];
}

export interface VisionMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costPence: number;
  durationMs: number;
}

export interface PhotoScoreResult {
  /** 0–100 taste score. */
  tasteScore: number;
  features: PhotoFeatures;
  metrics: VisionMetrics;
}

export interface VisionScorer {
  scorePhoto(input: PhotoScoreInput): Promise<PhotoScoreResult>;
  getModel(): string;
}

export interface VisionScorerConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  inputPricePencePerMTok: number;
  outputPricePencePerMTok: number;
}

export function getVisionScorerConfig(): VisionScorerConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Claude vision scoring");
  }
  return {
    apiKey,
    model: process.env.VISION_MODEL ?? "claude-haiku-4-5",
    maxOutputTokens: Number.parseInt(
      process.env.VISION_MAX_OUTPUT_TOKENS ?? "1024",
      10,
    ),
    timeoutMs: Number.parseInt(process.env.VISION_TIMEOUT_MS ?? "60000", 10),
    // Haiku 4.5 list price ≈ $1/MTok in, $5/MTok out → ~80p / ~400p at ~0.8 GBP.
    inputPricePencePerMTok: Number.parseFloat(
      process.env.VISION_INPUT_PENCE_PER_MTOK ?? "80",
    ),
    outputPricePencePerMTok: Number.parseFloat(
      process.env.VISION_OUTPUT_PENCE_PER_MTOK ?? "400",
    ),
  };
}

export function createVisionAnthropicClient(
  config: VisionScorerConfig,
): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    ...anthropicGatewayClientOptions(),
  });
}

/**
 * Strict output schema: an integer taste score 0–100 + a fixed-shape features
 * object. All feature fields are required + nullable (the model emits null when
 * the photo is silent), `highlights` is an array, and `additionalProperties:
 * false` keeps the JSON drop-in for `featuresJson` without remapping.
 */
export const PHOTO_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasteScore", "features"],
  properties: {
    tasteScore: {
      // NB: NO minimum/maximum — the Anthropic structured-output API rejects
      // numeric bounds ("For 'number' type, properties maximum, minimum are not
      // supported"). The 0–100 range lives in the description (to guide the
      // model) and parsePhotoScore clamps + rounds to [0,100] in code.
      type: "integer",
      description:
        "0–100: how tasteful/desirable this UK home photo looks (light, condition, style). 50 = average.",
    },
    features: {
      type: "object",
      additionalProperties: false,
      required: [
        "style",
        "condition",
        "naturalLight",
        "outdoorSpace",
        "highlights",
      ],
      properties: {
        style: {
          type: ["string", "null"],
          description: "Interior/exterior style, e.g. 'modern', 'period', 'minimalist'.",
        },
        condition: {
          type: ["string", "null"],
          description: "Visible condition, e.g. 'excellent', 'good', 'dated', 'needs work'.",
        },
        naturalLight: {
          type: ["string", "null"],
          description: "Light level, e.g. 'bright', 'moderate', 'dim'.",
        },
        outdoorSpace: {
          type: ["string", "null"],
          description: "Outdoor space, e.g. 'garden', 'balcony', 'patio', 'none'.",
        },
        highlights: {
          type: "array",
          items: { type: "string" },
          description: "Up to ~5 notable visual features (e.g. 'bay window', 'wood floors').",
        },
      },
    },
  },
} as const;

const SYSTEM_INSTRUCTION = [
  "You assess UK residential property photos for a discerning buyer.",
  "Return a taste score 0–100 (light, condition, style, kerb appeal) and a small set of detected visual features.",
  "Judge ONLY what is visible. Use null for a feature the photo does not show. Respond with JSON only, conforming exactly to the provided schema.",
].join(" ");

export interface VisionScorerDeps {
  client?: Anthropic;
  config?: VisionScorerConfig;
}

export class DefaultClaudeVisionScorer implements VisionScorer {
  private readonly client: Anthropic;
  private readonly config: VisionScorerConfig;

  constructor(deps: VisionScorerDeps = {}) {
    this.config = deps.config ?? getVisionScorerConfig();
    this.client = deps.client ?? createVisionAnthropicClient(this.config);
  }

  getModel(): string {
    return this.config.model;
  }

  async scorePhoto(input: PhotoScoreInput): Promise<PhotoScoreResult> {
    const startTime = Date.now();
    let observedModel = this.config.model;
    try {
      const content: Anthropic.ContentBlockParam[] = [
        {
          type: "text",
          text: input.context
            ? `Score this property photo. Context: ${input.context}`
            : "Score this property photo.",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: input.mediaType,
            data: input.data.toString("base64"),
          },
        },
      ];

      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxOutputTokens,
        system: SYSTEM_INSTRUCTION,
        output_config: {
          format: {
            type: "json_schema",
            schema: PHOTO_SCORE_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [{ role: "user", content }],
      });

      const durationMs = Date.now() - startTime;
      observedModel =
        typeof response.model === "string" && response.model.trim().length > 0
          ? response.model
          : this.config.model;

      const parsed = parsePhotoScore(readMessageText(response));
      const costPence = this.computeCostPence(response.usage);

      recordAiCall({
        provider: "anthropic",
        model: observedModel,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        costPence,
        durationMs,
        status: "ok",
      });

      return {
        tasteScore: parsed.tasteScore,
        features: parsed.features,
        metrics: {
          model: observedModel,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          costPence,
          durationMs,
        },
      };
    } catch (error) {
      recordAiCall({
        provider: "anthropic",
        model: this.config.model,
        inputTokens: 0,
        outputTokens: 0,
        costPence: 0,
        durationMs: Date.now() - startTime,
        status: "error",
      });
      throw classifyProviderError(error, "Claude vision scoring failed");
    }
  }

  private computeCostPence(usage: Anthropic.Usage | null | undefined): number {
    const inTok = usage?.input_tokens ?? 0;
    const outTok = usage?.output_tokens ?? 0;
    return Math.round(
      (inTok / 1_000_000) * this.config.inputPricePencePerMTok +
        (outTok / 1_000_000) * this.config.outputPricePencePerMTok,
    );
  }
}

let singleton: VisionScorer | undefined;

export function getVisionScorer(deps?: VisionScorerDeps): VisionScorer {
  if (deps) {
    return new DefaultClaudeVisionScorer(deps);
  }
  if (!singleton) {
    singleton = new DefaultClaudeVisionScorer();
  }
  return singleton;
}

// ── Response parsing ──────────────────────────────────────────────────────────

function readMessageText(response: Anthropic.Message): string {
  const merged = (response.content ?? [])
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("\n")
    .trim();
  if (merged.length === 0) {
    throw createNonRetryableError("Claude vision response had no text content");
  }
  return merged;
}

export function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

interface ParsedPhotoScore {
  tasteScore: number;
  features: PhotoFeatures;
}

export function parsePhotoScore(content: string): ParsedPhotoScore {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(content)) as Record<string, unknown>;
  } catch (error) {
    throw createNonRetryableError(
      `Failed to parse Claude vision response: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }

  const rawScore = parsed.tasteScore;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
    throw createNonRetryableError(
      "Claude vision response missing a numeric tasteScore",
    );
  }
  // Clamp into 0–100 + round (defence against a model that ignores the bounds).
  const tasteScore = Math.min(100, Math.max(0, Math.round(rawScore)));

  const rawFeatures = (
    typeof parsed.features === "object" && parsed.features !== null
      ? parsed.features
      : {}
  ) as Record<string, unknown>;

  return {
    tasteScore,
    features: {
      style: asNullableString(rawFeatures.style),
      condition: asNullableString(rawFeatures.condition),
      naturalLight: asNullableString(rawFeatures.naturalLight),
      outdoorSpace: asNullableString(rawFeatures.outdoorSpace),
      highlights: asStringArray(rawFeatures.highlights),
    },
  };
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}
