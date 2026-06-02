/**
 * Prometheus metrics for the homescout queue layer. The processor's /metrics
 * endpoint scrapes this registry. A self-contained Registry (homescout has no
 * shared metrics registry) with a single gauge `homescout_queue_depth` labelled
 * by queue. The `getSingleMetric ?? new` guard makes the module import-safe
 * under HMR / repeated test imports (Doxus pattern).
 */
import { Gauge, Registry } from "prom-client";
import { JOB_TYPES, type QueueName } from "./queue-config.js";
import type { QueueClient } from "./queue-client.js";

export const queueMetricsRegistry = new Registry();

const queueDepthGauge: Gauge<"queue"> =
  (queueMetricsRegistry.getSingleMetric("homescout_queue_depth") as
    | Gauge<"queue">
    | undefined) ??
  new Gauge({
    name: "homescout_queue_depth",
    help: "Number of waiting + active jobs per homescout queue",
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
