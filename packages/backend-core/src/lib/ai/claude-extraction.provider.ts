import Anthropic from "@anthropic-ai/sdk";
import {
  EPC_RATINGS,
  LISTING_STATUSES,
  PROPERTY_TYPES,
  TENURES,
} from "@homescout/shared";
import { Counter, Histogram, Registry } from "prom-client";
import { anthropicGatewayClientOptions } from "./ai-gateway.js";

/**
 * Claude structured extraction for the M4 inbound-ingestion pipeline.
 *
 * Mirrors the Doxus `ClaudeExtractionProvider`
 * (doxus-web `packages/backend-core/src/workers/extraction/domain/ai/ClaudeExtractionProvider.ts`):
 *   - `client.messages.create` with `output_config.format = { type: "json_schema", schema }`
 *     to force a strictly-shaped JSON response (verified present on the STABLE
 *     `MessageCreateParams.output_config` in @anthropic-ai/sdk 0.94.0 — NOT a
 *     beta-only field).
 *   - prom-client token + request-duration metrics keyed by model/status.
 *   - retryable-vs-terminal error classification by HTTP status (429/529/5xx
 *     retryable; 400/401/403 terminal), with parse failures non-retryable.
 *   - `stripCodeFence` + `JSON.parse` defence in case the model wraps JSON in a
 *     ``` fence despite the schema.
 *
 * Homescout-specific divergences from Doxus:
 *   - Domain is a single `extractListing` call returning UK listing fields +
 *     `listingUrl`, not Doxus's generic field/line-item extractor.
 *   - Attachments are passed as Claude NATIVE content blocks — `type: "document"`
 *     (Base64PDFSource) for PDFs and `type: "image"` (Base64ImageSource) for
 *     images — instead of Doxus's pre-OCR'd text. Callers pre-extract oversized
 *     PDFs to text via `unpdf` and pass that as a text block (see worker).
 *   - No Sentry / `withProviderSpan`: homescout has no observability span layer
 *     yet, so metrics live in a self-contained Registry exported for /metrics.
 *   - DI pattern (backend.md): interface + `DefaultClaudeExtractionProvider` +
 *     `deps.client ?? defaultClient` + singleton, no direct Prisma. The
 *     Anthropic client is injectable so unit tests mock `messages.create`.
 */

// ── Domain types ────────────────────────────────────────────────────────────

export type AttachmentInput =
  | { kind: "pdf"; data: Buffer; fileName?: string }
  | {
      kind: "image";
      data: Buffer;
      mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      fileName?: string;
    }
  /** Pre-extracted text (e.g. oversized PDF flattened via unpdf in the worker). */
  | { kind: "text"; text: string; fileName?: string };

export interface ListingExtractionInput {
  /** Free-text email body (plain text preferred; HTML stripped by caller). */
  bodyText: string;
  /** Email subject — often carries the address / price headline. */
  subject?: string;
  /** Sender domain hint (agent agency) to disambiguate. */
  fromAddress?: string;
  /** Decoded attachments to pass as native Claude blocks. */
  attachments?: AttachmentInput[];
  /** Resend MessageId — used only for metric/log correlation, not the prompt. */
  messageId?: string;
}

/**
 * Extracted listing fields. Every field is nullable: agent emails are messy and
 * the model MUST emit `null` rather than hallucinate. Enums mirror the Prisma /
 * `@homescout/shared` value tuples exactly. `pricePence` is an integer in pence
 * (homescout money convention); the model is told to convert "£450,000" ->
 * 45000000.
 */
export interface ExtractedListing {
  addressRaw: string | null;
  postcode: string | null;
  outcode: string | null;
  pricePence: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  tenure: (typeof TENURES)[number] | null;
  propertyType: (typeof PROPERTY_TYPES)[number] | null;
  epcRating: (typeof EPC_RATINGS)[number] | null;
  listingStatus: (typeof LISTING_STATUSES)[number] | null;
  listingUrl: string | null;
  /** 0..1 model self-confidence that this email describes a real listing. */
  confidence: number | null;
}

export interface ExtractionMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Approx cost in integer pence (homescout money convention). */
  costPence: number;
  durationMs: number;
}

export interface ListingExtractionResult {
  listing: ExtractedListing;
  metrics: ExtractionMetrics;
}

export interface ExtractionError extends Error {
  retryable: boolean;
  status?: number;
  code?: string;
}

export interface ClaudeExtractionProvider {
  extractListing(input: ListingExtractionInput): Promise<ListingExtractionResult>;
  getModel(): string;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface ClaudeExtractionConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Per-million-token prices in pence, for the costPence metric. */
  inputPricePencePerMTok: number;
  outputPricePencePerMTok: number;
}

export function getClaudeExtractionConfig(): ClaudeExtractionConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Claude extraction");
  }
  return {
    apiKey,
    model: process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-5",
    maxOutputTokens: Number.parseInt(
      process.env.EXTRACTION_MAX_OUTPUT_TOKENS ?? "2048",
      10,
    ),
    timeoutMs: Number.parseInt(
      process.env.EXTRACTION_TIMEOUT_MS ?? "60000",
      10,
    ),
    // Sonnet 4.5 list price: $3/MTok in, $15/MTok out ≈ 240p / 1200p at ~0.8 GBP.
    inputPricePencePerMTok: Number.parseFloat(
      process.env.EXTRACTION_INPUT_PENCE_PER_MTOK ?? "240",
    ),
    outputPricePencePerMTok: Number.parseFloat(
      process.env.EXTRACTION_OUTPUT_PENCE_PER_MTOK ?? "1200",
    ),
  };
}

/**
 * Build the Anthropic client. When the Cloudflare AI Gateway env is set the
 * call is transparently routed through the gateway (analytics + caching +
 * retries + logging); otherwise it talks to Anthropic directly. Exported (like
 * `createR2Client`) so the gateway wiring is unit-testable without poking the
 * provider's private client.
 */
export function createAnthropicClient(config: ClaudeExtractionConfig): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    ...anthropicGatewayClientOptions(),
  });
}

// ── Metrics ────────────────────────────────────────────────────────────────

/**
 * Self-contained registry (homescout has no shared queue-metrics registry yet,
 * unlike Doxus). `apps/processor` scrapes this for /metrics; when a shared
 * registry lands, swap `extractionMetricsRegistry` for the shared one. The
 * `getSingleMetric ?? new` guard makes the module import-safe under HMR / repeat
 * test imports (Doxus pattern).
 */
export const extractionMetricsRegistry = new Registry();

const anthropicTokensTotal: Counter<"type" | "model"> =
  (extractionMetricsRegistry.getSingleMetric("anthropic_tokens_total") as
    | Counter<"type" | "model">
    | undefined) ??
  new Counter({
    name: "anthropic_tokens_total",
    help: "Anthropic Claude token usage by type and model",
    labelNames: ["type", "model"],
    registers: [extractionMetricsRegistry],
  });

const anthropicRequestDurationSeconds: Histogram<"model" | "status"> =
  (extractionMetricsRegistry.getSingleMetric(
    "anthropic_request_duration_seconds",
  ) as Histogram<"model" | "status"> | undefined) ??
  new Histogram({
    name: "anthropic_request_duration_seconds",
    help: "Anthropic Claude request duration in seconds by model and outcome",
    labelNames: ["model", "status"],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [extractionMetricsRegistry],
  });

// ── JSON schema for the structured output ────────────────────────────────────

/**
 * The `output_config.format.schema`. `additionalProperties: false` + all keys
 * required (nullable via `["string", "null"]`) forces the model to emit every
 * field, using `null` where the email is silent. Enums are the canonical
 * snake_case tuples from `@homescout/shared`, so the result drops straight into
 * a Prisma upsert without remapping.
 */
export const LISTING_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "addressRaw",
    "postcode",
    "outcode",
    "pricePence",
    "bedrooms",
    "bathrooms",
    "tenure",
    "propertyType",
    "epcRating",
    "listingStatus",
    "listingUrl",
    "confidence",
  ],
  properties: {
    addressRaw: {
      type: ["string", "null"],
      description: "Full property address exactly as written in the email.",
    },
    postcode: {
      type: ["string", "null"],
      description: "Full UK postcode, uppercased, single space (e.g. 'SW1A 1AA').",
    },
    outcode: {
      type: ["string", "null"],
      description: "UK outward code only (e.g. 'SW1A'), uppercased.",
    },
    pricePence: {
      type: ["integer", "null"],
      description:
        "Asking/guide price in integer PENCE. Convert '£450,000' -> 45000000. Null if no price.",
    },
    bedrooms: { type: ["integer", "null"] },
    bathrooms: { type: ["integer", "null"] },
    tenure: { type: ["string", "null"], enum: [...TENURES, null] },
    propertyType: {
      type: ["string", "null"],
      enum: [...PROPERTY_TYPES, null],
    },
    epcRating: {
      type: ["string", "null"],
      enum: [...EPC_RATINGS, null],
      description: "EPC band lowercased a-g, or 'unknown'.",
    },
    listingStatus: {
      type: ["string", "null"],
      enum: [...LISTING_STATUSES, null],
      description:
        "Use 'pre_market' for off-market/coming-soon agent tips; 'live' if publicly listed.",
    },
    listingUrl: {
      type: ["string", "null"],
      description: "Rightmove/Zoopla/agency listing URL if present in the email.",
    },
    confidence: {
      type: ["number", "null"],
      description: "0..1 confidence this email describes a real UK property listing.",
    },
  },
} as const;

const SYSTEM_INSTRUCTION = [
  "You extract UK residential property listing fields from estate-agent emails.",
  "The email may be a forwarded property tip, a new-instruction blast, or an off-market heads-up, with optional PDF brochures or photos attached.",
  "Use ONLY the supplied email text and attachments. Never invent a value — emit null when the source is silent.",
  "Return prices in integer pence. Normalise postcodes to uppercase with a single space.",
  "Respond with JSON only, conforming exactly to the provided schema.",
].join(" ");

// ── Provider ─────────────────────────────────────────────────────────────────

export interface ClaudeExtractionDeps {
  client?: Anthropic;
  config?: ClaudeExtractionConfig;
}

export class DefaultClaudeExtractionProvider implements ClaudeExtractionProvider {
  private readonly client: Anthropic;
  private readonly config: ClaudeExtractionConfig;

  constructor(deps: ClaudeExtractionDeps = {}) {
    this.config = deps.config ?? getClaudeExtractionConfig();
    this.client = deps.client ?? createAnthropicClient(this.config);
  }

  getModel(): string {
    return this.config.model;
  }

  async extractListing(
    input: ListingExtractionInput,
  ): Promise<ListingExtractionResult> {
    const startTime = Date.now();
    let observedModel = this.config.model;

    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxOutputTokens,
        system: SYSTEM_INSTRUCTION,
        output_config: {
          format: {
            type: "json_schema",
            schema: LISTING_EXTRACTION_SCHEMA as unknown as Record<
              string,
              unknown
            >,
          },
        },
        messages: [
          {
            role: "user",
            content: buildUserContent(input),
          },
        ],
      });

      const durationMs = Date.now() - startTime;
      observedModel = resolveModel(response.model, this.config.model);

      recordTokenMetrics(observedModel, response.usage);
      anthropicRequestDurationSeconds
        .labels({ model: observedModel, status: "ok" })
        .observe(durationMs / 1000);

      const listing = parseListing(readMessageText(response));

      return {
        listing,
        metrics: {
          model: observedModel,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          costPence: this.computeCostPence(response.usage),
          durationMs,
        },
      };
    } catch (error) {
      anthropicRequestDurationSeconds
        .labels({ model: this.config.model, status: "error" })
        .observe((Date.now() - startTime) / 1000);
      throw classifyProviderError(error, "Claude listing extraction failed");
    }
  }

  private computeCostPence(usage: Anthropic.Usage | null | undefined): number {
    const inTok = usage?.input_tokens ?? 0;
    const outTok = usage?.output_tokens ?? 0;
    const pence =
      (inTok / 1_000_000) * this.config.inputPricePencePerMTok +
      (outTok / 1_000_000) * this.config.outputPricePencePerMTok;
    return Math.round(pence);
  }
}

let singleton: ClaudeExtractionProvider | undefined;

/** Lazy singleton; pass `deps` (a mocked Anthropic client) in unit tests. */
export function getClaudeExtractionProvider(
  deps?: ClaudeExtractionDeps,
): ClaudeExtractionProvider {
  if (deps) {
    return new DefaultClaudeExtractionProvider(deps);
  }
  if (!singleton) {
    singleton = new DefaultClaudeExtractionProvider();
  }
  return singleton;
}

// ── Content assembly ──────────────────────────────────────────────────────────

/**
 * Build the user content array: a text block (subject + from + body) followed by
 * one native block per attachment. PDFs -> `type: "document"` with a
 * Base64PDFSource; images -> `type: "image"` with a Base64ImageSource;
 * pre-extracted text -> a plain text block. Buffers are base64-encoded inline
 * (Resend attachments are small; the worker pre-flattens oversized PDFs via
 * unpdf into a `kind: "text"` block before calling here).
 */
export function buildUserContent(
  input: ListingExtractionInput,
): Anthropic.ContentBlockParam[] {
  const header = [
    input.subject ? `Subject: ${input.subject}` : null,
    input.fromAddress ? `From: ${input.fromAddress}` : null,
    "",
    "Email body:",
    input.bodyText,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const blocks: Anthropic.ContentBlockParam[] = [{ type: "text", text: header }];

  for (const attachment of input.attachments ?? []) {
    if (attachment.kind === "pdf") {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: attachment.data.toString("base64"),
        },
        ...(attachment.fileName ? { title: attachment.fileName } : {}),
      });
    } else if (attachment.kind === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mediaType,
          data: attachment.data.toString("base64"),
        },
      });
    } else {
      blocks.push({
        type: "text",
        text: attachment.fileName
          ? `Attachment ${attachment.fileName}:\n${attachment.text}`
          : attachment.text,
      });
    }
  }

  return blocks;
}

// ── Response parsing ──────────────────────────────────────────────────────────

function readMessageText(response: Anthropic.Message): string {
  const merged = (response.content ?? [])
    .map((block) =>
      block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("\n")
    .trim();

  if (merged.length === 0) {
    throw createNonRetryableError("Claude response did not include text content");
  }
  return merged;
}

function parseListing(content: string): ExtractedListing {
  let parsed: Partial<ExtractedListing>;
  try {
    parsed = JSON.parse(stripCodeFence(content)) as Partial<ExtractedListing>;
  } catch (error) {
    throw createNonRetryableError(
      `Failed to parse Claude extraction response: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }

  return {
    addressRaw: asNullableString(parsed.addressRaw),
    postcode: asNullableString(parsed.postcode),
    outcode: asNullableString(parsed.outcode),
    pricePence: asNullableInt(parsed.pricePence),
    bedrooms: asNullableInt(parsed.bedrooms),
    bathrooms: asNullableInt(parsed.bathrooms),
    tenure: asEnum(parsed.tenure, TENURES),
    propertyType: asEnum(parsed.propertyType, PROPERTY_TYPES),
    epcRating: asEnum(parsed.epcRating, EPC_RATINGS),
    listingStatus: asEnum(parsed.listingStatus, LISTING_STATUSES),
    listingUrl: asNullableString(parsed.listingUrl),
    confidence: asNullableNumber(parsed.confidence),
  };
}

export function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
}

function asEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}

// ── Metric helpers ────────────────────────────────────────────────────────────

function recordTokenMetrics(
  model: string,
  usage: Anthropic.Usage | null | undefined,
): void {
  if (!usage) {
    return;
  }
  if (Number.isFinite(usage.input_tokens)) {
    anthropicTokensTotal.labels({ type: "input", model }).inc(usage.input_tokens);
  }
  if (Number.isFinite(usage.output_tokens)) {
    anthropicTokensTotal
      .labels({ type: "output", model })
      .inc(usage.output_tokens);
  }
}

function resolveModel(responseModel: unknown, fallback: string): string {
  return typeof responseModel === "string" && responseModel.trim().length > 0
    ? responseModel
    : fallback;
}

// ── Error classification (mirrors Doxus) ──────────────────────────────────────

function classifyProviderError(
  error: unknown,
  fallbackMessage: string,
): ExtractionError {
  if (isExtractionError(error)) {
    return error;
  }

  const status = getStatus(error);
  const code = getCode(error);
  const retryable = isRetryableStatus(status);

  const providerError = (
    error instanceof Error ? error : new Error(fallbackMessage)
  ) as ExtractionError;
  providerError.retryable = retryable;
  if (status !== undefined) {
    providerError.status = status;
  }
  if (code !== undefined) {
    providerError.code = code;
  }
  return providerError;
}

function createNonRetryableError(message: string): ExtractionError {
  const error = new Error(message) as ExtractionError;
  error.retryable = false;
  return error;
}

function isExtractionError(error: unknown): error is ExtractionError {
  return (
    error instanceof Error &&
    "retryable" in error &&
    typeof (error as ExtractionError).retryable === "boolean"
  );
}

function getStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if (
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
  ) {
    return (error as { statusCode: number }).statusCode;
  }
  return undefined;
}

function getCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) {
    return true; // network / unknown transport error — retry
  }
  // Transient: rate limit (429), request timeout (408), Anthropic "overloaded"
  // (529) and any other 5xx — retry these.
  if (status === 429 || status === 408 || status >= 500) {
    return true;
  }
  // Every OTHER 4xx is a terminal client error that never succeeds on retry:
  // 400 bad request, 401/403 auth, 404 (e.g. a misconfigured AI Gateway id →
  // the gateway URL 404s), 405/410, etc. Retrying just burns the BullMQ attempt
  // budget + backoff on a permanent failure, so fail fast.
  if (status >= 400) {
    return false;
  }
  return true; // non-error / unexpected — retry defensively
}
