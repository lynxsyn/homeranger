/**
 * Prometheus metrics for the homeranger queue layer. The processor's /metrics
 * endpoint scrapes this registry. A self-contained Registry (homeranger has no
 * shared metrics registry) with a single gauge `homeranger_queue_depth` labelled
 * by queue. The `getSingleMetric ?? new` guard makes the module import-safe
 * under HMR / repeated test imports (Doxus pattern).
 */
import { Counter, Gauge, Registry } from "prom-client";
import { JOB_TYPES, type QueueName } from "./queue-config.js";
import type { QueueClient } from "./queue-client.js";

export const queueMetricsRegistry = new Registry();

const queueDepthGauge: Gauge<"queue"> =
  (queueMetricsRegistry.getSingleMetric("homeranger_queue_depth") as
    | Gauge<"queue">
    | undefined) ??
  new Gauge({
    name: "homeranger_queue_depth",
    help: "Number of waiting + active jobs per homeranger queue",
    labelNames: ["queue"],
    registers: [queueMetricsRegistry],
  });

/**
 * Count of inbound emails DROPPED as non-retryable (poison pill: malformed
 * Claude JSON / 4xx / malformed email). These are completed-not-retried, so this
 * counter is the only signal they happened — scraped via the processor /metrics.
 */
export const inboundDroppedTotal: Counter<string> =
  (queueMetricsRegistry.getSingleMetric("homeranger_inbound_dropped_total") as
    | Counter<string>
    | undefined) ??
  new Counter({
    name: "homeranger_inbound_dropped_total",
    help: "Inbound emails dropped as non-retryable (poison pill)",
    registers: [queueMetricsRegistry],
  });

/**
 * Count of inbound emails IGNORED by the recipient gate — addressed only to an
 * infra/role local-part (dmarc@/postmaster@/mailer-daemon@/...), so not a real
 * agent reply or listing-bearing email. Dropped BEFORE hydrate + Claude extract
 * (it completes cleanly, not a poison-pill failure), so this counter is the only
 * signal it happened — scraped via the processor /metrics.
 */
export const inboundIgnoredTotal: Counter<string> =
  (queueMetricsRegistry.getSingleMetric("homeranger_inbound_ignored_total") as
    | Counter<string>
    | undefined) ??
  new Counter({
    name: "homeranger_inbound_ignored_total",
    help: "Inbound emails ignored by the recipient gate (infra-only recipient)",
    registers: [queueMetricsRegistry],
  });

/**
 * Count of jobs that exhausted their retries (terminal failure) per queue. A
 * full DLQ is out of M4 scope (M-future: a dead-letter queue + alerting belongs
 * with the M6 circuit breaker); a clear terminal-failure log+metric is the M4
 * observability floor.
 */
export const jobTerminalFailuresTotal: Counter<"queue"> =
  (queueMetricsRegistry.getSingleMetric(
    "homeranger_job_terminal_failures_total",
  ) as Counter<"queue"> | undefined) ??
  new Counter({
    name: "homeranger_job_terminal_failures_total",
    help: "Jobs that exhausted their retries (terminal failure) per queue",
    labelNames: ["queue"],
    registers: [queueMetricsRegistry],
  });

/**
 * Poll each queue's depth and update the gauge. Called on every /metrics scrape
 * so the value is fresh. Errors on a single queue are swallowed (the gauge keeps
 * its last value) so one unreachable queue does not 500 the whole scrape.
 */
export async function collectQueueMetrics(client: QueueClient): Promise<void> {
  await Promise.all(
    JOB_TYPES.map(async (name: QueueName) => {
      try {
        const depth = await client.getQueueDepth(name);
        queueDepthGauge.labels({ queue: name }).set(depth);
      } catch {
        // Leave the previous value; a transient Redis hiccup must not 500.
      }
    }),
  );
}
