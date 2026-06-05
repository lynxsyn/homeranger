/**
 * Claude **Haiku** agent-quality classifier (auto-delete confident non-agency
 * junk). Discovery + the backfill hand it a candidate (agency name, contact
 * email, optional website, optional fetched page text) and it returns a
 * keep/junk verdict + the specific business class + a 0–1 confidence. The
 * service auto-drops only on a CONFIDENT non-agency verdict (`shouldAutoDelete`)
 * — uncertain verdicts are KEPT, so a real agency is never silently deleted on a
 * shaky call.
 *
 * Same shape as the match scorer: Anthropic client via the AI Gateway, strict
 * json_schema output, shared error classification + analysis metrics, DI client
 * for unit tests. parseAgentClassify + shouldAutoDelete + AGENT_CLASSIFY_SCHEMA
 * live IN this file (the parseMatchScore precedent) and stay coverage-COUNTED —
 * only the FAKE is coverage-excluded.
 *
 * FIX-1: `pageText` is threaded into the prompt (name+email+domain alone
 * under-fires on housing associations + PDF directories), and a deterministic
 * housing-association catch reuses the discovery NON_AGENCY_SOURCE_RE against the
 * stored agency name.
 * FIX-2: `agencyName` is `string | null` (Agent.agencyName is nullable) and is
 * coalesced to "" before the prompt.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropicGatewayClientOptions } from "./ai-gateway.js";
import {
  classifyProviderError,
  createNonRetryableError,
} from "./provider-errors.js";
import { recordAiCall } from "./analysis-metrics.js";

export interface AgentClassifyInput {
  /**
   * The discovered/stored agency name. Nullable because `Agent.agencyName` is
   * `String?` (FIX-2) — the provider coalesces null to "" before the prompt.
   */
  agencyName: string | null;
  /** The contact email — the domain is a load-bearing classification signal. */
  email: string;
  /** Optional website URL (DiscoveredAgent.websiteUrl / Agent.website). */
  websiteUrl?: string;
  /**
   * Optional fetched page text/markdown (FIX-1). Name+email+domain alone
   * under-fires on housing associations + PDF directories; real page content
   * lets the LLM confidently classify them.
   */
  pageText?: string;
}

export type AgentKind =
  | "estate_agent"
  | "letting_agent"
  | "new_homes"
  | "commercial"
  | "council"
  | "housing_association"
  | "portal"
  | "directory"
  | "other";

const AGENT_KINDS: readonly AgentKind[] = [
  "estate_agent",
  "letting_agent",
  "new_homes",
  "commercial",
  "council",
  "housing_association",
  "portal",
  "directory",
  "other",
];

export interface AgentClassifyMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costPence: number;
  durationMs: number;
}

export interface AgentClassifyResult {
  /** The keep/junk verdict. */
  isResidentialSalesAgency: boolean;
  /** The specific business class (drives the report + reason). */
  kind: AgentKind;
  /** 0–1 confidence in the verdict, CLAMPED in code (NOT bounded in schema). */
  confidence: number;
  /** Canonical agency name, cleaned of directory-PDF title noise. */
  suggestedName: string;
  metrics: AgentClassifyMetrics;
}

export interface AgentClassifier {
  classify(input: AgentClassifyInput): Promise<AgentClassifyResult>;
  getModel(): string;
}

export interface AgentClassifierConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  inputPricePencePerMTok: number;
  outputPricePencePerMTok: number;
}

export function getAgentClassifierConfig(): AgentClassifierConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for Claude agent classification",
    );
  }
  return {
    apiKey,
    model: process.env.CLASSIFIER_MODEL ?? "claude-haiku-4-5",
    maxOutputTokens: Number.parseInt(
      process.env.CLASSIFIER_MAX_OUTPUT_TOKENS ?? "256",
      10,
    ),
    timeoutMs: Number.parseInt(process.env.CLASSIFIER_TIMEOUT_MS ?? "30000", 10),
    inputPricePencePerMTok: Number.parseFloat(
      process.env.CLASSIFIER_INPUT_PENCE_PER_MTOK ?? "80",
    ),
    outputPricePencePerMTok: Number.parseFloat(
      process.env.CLASSIFIER_OUTPUT_PENCE_PER_MTOK ?? "400",
    ),
  };
}

export function createAgentClassifierAnthropicClient(
  config: AgentClassifierConfig,
): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    ...anthropicGatewayClientOptions(),
  });
}

export const AGENT_CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isResidentialSalesAgency", "kind", "confidence", "suggestedName"],
  properties: {
    isResidentialSalesAgency: {
      type: "boolean",
      description:
        "True for a genuine residential property agency a buyer could cold-approach — an estate agent, a letting/managing agent (INCLUDING a letting-ONLY firm that does no sales), or a new-homes agency. False ONLY for councils, housing associations, property portals/aggregators, and directory/PDF pages.",
    },
    kind: {
      type: "string",
      enum: [
        "estate_agent",
        "letting_agent",
        "new_homes",
        "commercial",
        "council",
        "housing_association",
        "portal",
        "directory",
        "other",
      ],
      description: "The specific business class.",
    },
    confidence: {
      // NB: NO minimum/maximum — the Anthropic structured-output API rejects
      // numeric bounds ("For 'number' type, properties maximum, minimum are not
      // supported"). The 0–1 range lives in the description (to guide the model)
      // and parseAgentClassify clamps to [0,1] in code (defence against drift).
      // See PR #87.
      type: "number",
      description:
        "0–1 confidence in the isResidentialSalesAgency verdict. 1 = certain; below the auto-delete threshold means uncertain (the agent is kept).",
    },
    suggestedName: {
      type: "string",
      description:
        "The canonical agency/business name, cleaned of directory-PDF title noise. Empty string if unknown.",
    },
  },
} as const;

const SYSTEM_INSTRUCTION = [
  "You classify whether a discovered UK business is a genuine residential sales/letting estate agency vs non-agency junk (council, housing association, property portal/aggregator, directory/PDF page).",
  "Return isResidentialSalesAgency, the specific kind, a 0–1 confidence, and the cleaned suggestedName.",
  "Respond with JSON only, conforming exactly to the provided schema.",
].join(" ");

/** The auto-delete confidence floor. Tunable; default 0.85. */
const AUTO_DELETE_THRESHOLD = 0.85;

/**
 * Genuine-agency kinds that are NEVER auto-deleted, regardless of the
 * `isResidentialSalesAgency` boolean. The boolean is misleading for a
 * letting-ONLY agency: a pure letting agent does no SALES, so the model returns
 * `isResidentialSalesAgency: false` even though it is a real, cold-approachable
 * estate-agency business (the aslets.co.uk false positive). The operator asked
 * to auto-delete NON-agencies — a letting agent IS an agency. New-homes and
 * commercial agents are agencies too; keeping them is the safe, non-destructive
 * default (they simply won't match a residential-sales search).
 */
const AGENCY_KINDS: ReadonlySet<AgentKind> = new Set<AgentKind>([
  "estate_agent",
  "letting_agent",
  "new_homes",
  "commercial",
]);

/**
 * The auto-delete gate: fires ONLY on a CONFIDENT NON-agency verdict, and NEVER
 * on a genuine agency kind. Three conditions, all required:
 *   1. the model judged it not a residential SALES agency, AND
 *   2. it is confident (`confidence >= threshold`) — uncertain verdicts are KEPT,
 *      never silently delete a real agency on a shaky call, AND
 *   3. its `kind` is NOT a genuine agency (estate/letting/new-homes/commercial) —
 *      so a letting-only agency (sales-boolean false but a real agency) is KEPT.
 * Confident non-agency kinds (council/housing_association/portal/directory and an
 * unclassifiable "other") still drop. Pure, unit-tested.
 */
export function shouldAutoDelete(
  verdict: { isResidentialSalesAgency: boolean; kind: AgentKind; confidence: number },
  threshold = AUTO_DELETE_THRESHOLD,
): boolean {
  return (
    verdict.isResidentialSalesAgency === false &&
    verdict.confidence >= threshold &&
    !AGENCY_KINDS.has(verdict.kind)
  );
}

export interface AgentClassifierDeps {
  client?: Anthropic;
  config?: AgentClassifierConfig;
}

export class DefaultClaudeAgentClassifier implements AgentClassifier {
  private readonly client: Anthropic;
  private readonly config: AgentClassifierConfig;

  constructor(deps: AgentClassifierDeps = {}) {
    this.config = deps.config ?? getAgentClassifierConfig();
    this.client = deps.client ?? createAgentClassifierAnthropicClient(this.config);
  }

  getModel(): string {
    return this.config.model;
  }

  async classify(input: AgentClassifyInput): Promise<AgentClassifyResult> {
    const startTime = Date.now();
    let observedModel = this.config.model;
    // FIX-2: coalesce a null agency name to "" before it reaches the prompt.
    const agencyName = input.agencyName ?? "";
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxOutputTokens,
        system: SYSTEM_INSTRUCTION,
        output_config: {
          format: {
            type: "json_schema",
            schema: AGENT_CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildPrompt({
                  agencyName,
                  email: input.email,
                  websiteUrl: input.websiteUrl,
                  pageText: input.pageText,
                }),
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

      const parsed = parseAgentClassify(readMessageText(response));
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
        isResidentialSalesAgency: parsed.isResidentialSalesAgency,
        kind: parsed.kind,
        confidence: parsed.confidence,
        suggestedName: parsed.suggestedName,
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
      throw classifyProviderError(error, "Claude agent classification failed");
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

let singleton: AgentClassifier | undefined;

export function getAgentClassifier(deps?: AgentClassifierDeps): AgentClassifier {
  if (deps) {
    return new DefaultClaudeAgentClassifier(deps);
  }
  if (!singleton) {
    singleton = new DefaultClaudeAgentClassifier();
  }
  return singleton;
}

/** Test-only seam to swap the singleton (mirrors the other provider seams). */
export function _setForTesting(classifier: AgentClassifier | undefined): void {
  singleton = classifier;
}

/**
 * Build the classifier prompt. FIX-1: page text is threaded in when present so
 * the LLM has real content to confidently classify a housing association or a
 * PDF directory (name+email+domain alone under-fires).
 */
function buildPrompt(input: {
  agencyName: string;
  email: string;
  websiteUrl?: string;
  pageText?: string;
}): string {
  const lines = [
    "Business name:",
    input.agencyName,
    "",
    "Contact email:",
    input.email,
  ];
  if (input.websiteUrl && input.websiteUrl.trim().length > 0) {
    lines.push("", "Website:", input.websiteUrl);
  }
  if (input.pageText && input.pageText.trim().length > 0) {
    lines.push("", "Page content:", input.pageText);
  }
  return lines.join("\n");
}

function readMessageText(response: Anthropic.Message): string {
  const merged = (response.content ?? [])
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("\n")
    .trim();
  if (merged.length === 0) {
    throw createNonRetryableError(
      "Claude agent classification response had no text content",
    );
  }
  return merged;
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

export interface ParsedAgentClassify {
  isResidentialSalesAgency: boolean;
  kind: AgentKind;
  confidence: number;
  suggestedName: string;
}

function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && AGENT_KINDS.includes(value as AgentKind);
}

/**
 * Parse + validate the Claude classification response. ONLY unparseable JSON
 * throws (a non-retryable error). Any FIELD-level drift resolves KEEP-SAFE
 * (`isResidentialSalesAgency:true, confidence:0`) — a malformed/missing verdict
 * OR a non-numeric confidence can never auto-delete a real agency, and one bad
 * classification never aborts the whole discovery batch (a network/HTTP error in
 * classify() still throws retryable, so the job still retries on a real outage).
 * A valid confidence is CLAMPED to [0,1] (defence against drift).
 */
export function parseAgentClassify(content: string): ParsedAgentClassify {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(content)) as Record<string, unknown>;
  } catch (error) {
    throw createNonRetryableError(
      `Failed to parse Claude agent classification response: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }

  const rawVerdict = parsed.isResidentialSalesAgency;
  const rawConfidence = parsed.confidence;
  // KEEP-safe: a malformed/missing verdict OR a non-numeric confidence is parse
  // drift — keep the agent (deletion bias toward KEEP), confidence 0 so
  // shouldAutoDelete is false. Symmetric with the verdict check so a bad
  // confidence never aborts the batch.
  if (
    typeof rawVerdict !== "boolean" ||
    typeof rawConfidence !== "number" ||
    !Number.isFinite(rawConfidence)
  ) {
    return {
      isResidentialSalesAgency: true,
      kind: "other",
      confidence: 0,
      suggestedName:
        typeof parsed.suggestedName === "string" ? parsed.suggestedName : "",
    };
  }
  const confidence = Math.min(1, Math.max(0, rawConfidence));

  const kind = isAgentKind(parsed.kind) ? parsed.kind : "other";
  const suggestedName =
    typeof parsed.suggestedName === "string" ? parsed.suggestedName : "";

  return {
    isResidentialSalesAgency: rawVerdict,
    kind,
    confidence,
    suggestedName,
  };
}
