/**
 * Claude **Haiku** preference match re-scorer (M5 spec AC#3 + #6). After the
 * vector recall (`vectorTopK`) narrows the corpus to the top-K candidates, this
 * provider re-scores ONLY those K against the user's stated preferences,
 * returning a 0–1 relevance score + a one-line rationale the ListingsPage
 * row-expand renders. Bounding the LLM to the top-K (not the full corpus) is the
 * core cost control (AC#5).
 *
 * Same shape as the vision scorer: Anthropic client via the AI Gateway,
 * strict json_schema output, shared error classification + analysis metrics, DI
 * client for unit tests.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropicGatewayClientOptions } from "./ai-gateway.js";
import {
  classifyProviderError,
  createNonRetryableError,
} from "./provider-errors.js";
import { recordAiCall } from "./analysis-metrics.js";

export interface MatchScoreInput {
  /** The user's preferences as text (freeText + structured filters). */
  profileText: string;
  /** A compact description of the listing being re-scored. */
  listingDescription: string;
}

export interface MatchMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costPence: number;
  durationMs: number;
}

export interface MatchScoreResult {
  /** 0–1 relevance of the listing to the preferences. */
  llmScore: number;
  rationale: string;
  metrics: MatchMetrics;
}

export interface MatchScorer {
  scoreMatch(input: MatchScoreInput): Promise<MatchScoreResult>;
  getModel(): string;
}

export interface MatchScorerConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  inputPricePencePerMTok: number;
  outputPricePencePerMTok: number;
}

export function getMatchScorerConfig(): MatchScorerConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Claude match scoring");
  }
  return {
    apiKey,
    model: process.env.MATCH_MODEL ?? "claude-haiku-4-5",
    maxOutputTokens: Number.parseInt(
      process.env.MATCH_MAX_OUTPUT_TOKENS ?? "512",
      10,
    ),
    timeoutMs: Number.parseInt(process.env.MATCH_TIMEOUT_MS ?? "30000", 10),
    inputPricePencePerMTok: Number.parseFloat(
      process.env.MATCH_INPUT_PENCE_PER_MTOK ?? "80",
    ),
    outputPricePencePerMTok: Number.parseFloat(
      process.env.MATCH_OUTPUT_PENCE_PER_MTOK ?? "400",
    ),
  };
}

export function createMatchAnthropicClient(config: MatchScorerConfig): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    ...anthropicGatewayClientOptions(),
  });
}

export const MATCH_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "rationale"],
  properties: {
    score: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "0–1 relevance of the listing to the buyer's stated preferences.",
    },
    rationale: {
      type: "string",
      description: "One concise sentence explaining the score (what matches / what doesn't).",
    },
  },
} as const;

const SYSTEM_INSTRUCTION = [
  "You judge how well a UK property listing matches a buyer's stated preferences.",
  "Return a 0–1 relevance score and a single concise sentence of rationale.",
  "Weigh the buyer's explicit must-haves heavily. Respond with JSON only, conforming exactly to the provided schema.",
].join(" ");

export interface MatchScorerDeps {
  client?: Anthropic;
  config?: MatchScorerConfig;
}

export class DefaultClaudeMatchScorer implements MatchScorer {
  private readonly client: Anthropic;
  private readonly config: MatchScorerConfig;

  constructor(deps: MatchScorerDeps = {}) {
    this.config = deps.config ?? getMatchScorerConfig();
    this.client = deps.client ?? createMatchAnthropicClient(this.config);
  }

  getModel(): string {
    return this.config.model;
  }

  async scoreMatch(input: MatchScoreInput): Promise<MatchScoreResult> {
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
            schema: MATCH_SCORE_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "Buyer preferences:",
                  input.profileText,
                  "",
                  "Listing:",
                  input.listingDescription,
                ].join("\n"),
              },
            ],
          },
        ],
      });

      const durationMs = Date.now() - startTime;
      observedModel =
        typeof response.model === "string" && response.model.trim().length > 0
          ? response.model
          : this.config.model;

      const parsed = parseMatchScore(readMessageText(response));
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
        llmScore: parsed.score,
        rationale: parsed.rationale,
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
      throw classifyProviderError(error, "Claude match scoring failed");
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

let singleton: MatchScorer | undefined;

export function getMatchScorer(deps?: MatchScorerDeps): MatchScorer {
  if (deps) {
    return new DefaultClaudeMatchScorer(deps);
  }
  if (!singleton) {
    singleton = new DefaultClaudeMatchScorer();
  }
  return singleton;
}

function readMessageText(response: Anthropic.Message): string {
  const merged = (response.content ?? [])
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("\n")
    .trim();
  if (merged.length === 0) {
    throw createNonRetryableError("Claude match response had no text content");
  }
  return merged;
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

interface ParsedMatch {
  score: number;
  rationale: string;
}

export function parseMatchScore(content: string): ParsedMatch {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(content)) as Record<string, unknown>;
  } catch (error) {
    throw createNonRetryableError(
      `Failed to parse Claude match response: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }
  const rawScore = parsed.score;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
    throw createNonRetryableError("Claude match response missing a numeric score");
  }
  const score = Math.min(1, Math.max(0, rawScore));
  const rationale =
    typeof parsed.rationale === "string" ? parsed.rationale : "";
  return { score, rationale };
}
