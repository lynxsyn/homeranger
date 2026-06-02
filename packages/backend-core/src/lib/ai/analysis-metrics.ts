/**
 * Prometheus metrics for the M5 analysis providers (Claude vision, Voyage
 * embeddings, Claude match re-score). A self-contained Registry (homescout has
 * no shared metrics registry) the processor merges into its /metrics scrape
 * alongside the queue + extraction registries. The `getSingleMetric ?? new`
 * guard keeps the module import-safe under HMR / repeated test imports (the
 * established homescout pattern from claude-extraction.provider.ts).
 *
 * `costPence` is ALSO persisted per photo on PhotoAnalysis (durable, queryable
 * for the monthly-spend kill-switch); this counter is the live cumulative view.
 */
import { Counter, Histogram, Registry } from "prom-client";

export const analysisMetricsRegistry = new Registry();

/** Token usage by provider (anthropic|voyage), type (input|output), and model. */
export const aiTokensTotal: Counter<"provider" | "type" | "model"> =
  (analysisMetricsRegistry.getSingleMetric("homescout_ai_tokens_total") as
    | Counter<"provider" | "type" | "model">
    | undefined) ??
  new Counter({
    name: "homescout_ai_tokens_total",
    help: "AI token usage by provider, type and model (M5 analysis)",
    labelNames: ["provider", "type", "model"],
    registers: [analysisMetricsRegistry],
  });

/** Cumulative spend in integer pence by provider + model. */
export const aiCostPenceTotal: Counter<"provider" | "model"> =
  (analysisMetricsRegistry.getSingleMetric("homescout_ai_cost_pence_total") as
    | Counter<"provider" | "model">
    | undefined) ??
  new Counter({
    name: "homescout_ai_cost_pence_total",
    help: "Cumulative AI spend in pence by provider and model (M5 analysis)",
    labelNames: ["provider", "model"],
    registers: [analysisMetricsRegistry],
  });

/** Request duration by provider + outcome (ok|error). */
export const aiRequestDurationSeconds: Histogram<"provider" | "status"> =
  (analysisMetricsRegistry.getSingleMetric(
    "homescout_ai_request_duration_seconds",
  ) as Histogram<"provider" | "status"> | undefined) ??
  new Histogram({
    name: "homescout_ai_request_duration_seconds",
    help: "AI request duration in seconds by provider and outcome (M5 analysis)",
    labelNames: ["provider", "status"],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [analysisMetricsRegistry],
  });

/**
 * Count of analyse:listing jobs DROPPED as non-retryable (poison pill: a missing
 * listing / a 4xx provider error). These are completed-not-retried, so this
 * counter is the only signal they happened — scraped via the processor /metrics.
 */
export const analysisDroppedTotal: Counter<string> =
  (analysisMetricsRegistry.getSingleMetric("homescout_analysis_dropped_total") as
    | Counter<string>
    | undefined) ??
  new Counter({
    name: "homescout_analysis_dropped_total",
    help: "analyze:listing jobs dropped as non-retryable (poison pill)",
    registers: [analysisMetricsRegistry],
  });

/** Count of analyses short-circuited by the monthly-spend kill-switch. */
export const analysisKillSwitchTotal: Counter<"reason"> =
  (analysisMetricsRegistry.getSingleMetric(
    "homescout_analysis_kill_switch_total",
  ) as Counter<"reason"> | undefined) ??
  new Counter({
    name: "homescout_analysis_kill_switch_total",
    help: "Listing analyses short-circuited by the kill-switch, by reason",
    labelNames: ["reason"],
    registers: [analysisMetricsRegistry],
  });

/** Record token + cost + duration for one provider call. */
export function recordAiCall(input: {
  provider: "anthropic" | "voyage";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costPence: number;
  durationMs: number;
  status: "ok" | "error";
}): void {
  if (Number.isFinite(input.inputTokens) && input.inputTokens > 0) {
    aiTokensTotal
      .labels({ provider: input.provider, type: "input", model: input.model })
      .inc(input.inputTokens);
  }
  if (Number.isFinite(input.outputTokens) && input.outputTokens > 0) {
    aiTokensTotal
      .labels({ provider: input.provider, type: "output", model: input.model })
      .inc(input.outputTokens);
  }
  if (Number.isFinite(input.costPence) && input.costPence > 0) {
    aiCostPenceTotal
      .labels({ provider: input.provider, model: input.model })
      .inc(input.costPence);
  }
  aiRequestDurationSeconds
    .labels({ provider: input.provider, status: input.status })
    .observe(input.durationMs / 1000);
}
