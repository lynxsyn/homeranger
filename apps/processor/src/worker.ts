/**
 * homescout processor — the consume side of the M4 inbound-ingestion pipeline.
 *
 * M4 brings apps/processor up from the empty skeleton into a real BullMQ worker
 * on homescout-redis (the way M3 brought apps/api up). It registers one
 * processor per queue and dispatches:
 *   - outreach:inbound → hydrate (Resend Received-Emails/Attachments API → R2)
 *     then InboundIngestionService.ingestInboundEmail (Claude extraction →
 *     dedup → upsert Listing + ListingSourceRecord → enqueue analyze:listing).
 *   - resend:event     → EmailEventService.ingestEvent (persist EmailEvent +
 *     suppress on hard_bounce / spam_complaint).
 *   - analyze:listing  → NO-OP until M5 (logs + acks so the queue drains).
 *
 * It serves a tiny HTTP server on METRICS_PORT (started LAST, after DB + Redis
 * are confirmed healthy, so the k8s readiness probe reflects real readiness):
 *   - GET /health  (liveness/readiness probe — mirrors api's /api/health)
 *   - GET /metrics (prom-client queue depth)
 *
 * Test seams: `RESEND_FAKE=1` swaps the real Resend hydrator for the in-memory
 * fake (E2E/CI never call the real Resend API); `EXTRACTION_FAKE=1` swaps the
 * Claude extractor for the deterministic fake (no LLM spend in E2E/CI).
 *
 * Wiring mirrors doxus-web/apps/processor/src/worker.ts, minus Sentry / Posthog
 * / OutboxRelay / scheduled-job ownership (homescout has none in M4). Node16
 * resolution → all relative imports carry `.js`.
 */
import http from "node:http";
import { prisma } from "@homescout/backend-core/lib/prisma";
import { BullMQQueueClient } from "@homescout/backend-core/lib/queue/queue-client";
import { QUEUE_NAMES } from "@homescout/backend-core/lib/queue/queue-config";
import {
  closeRedisConnection,
  getRedisConnection,
} from "@homescout/backend-core/lib/queue/redis-connection";
import {
  collectQueueMetrics,
  queueMetricsRegistry,
} from "@homescout/backend-core/lib/queue/queue-metrics";
import { extractionMetricsRegistry } from "@homescout/backend-core/lib/ai/claude-extraction.provider";
import { ClaudeListingExtractionAdapter } from "@homescout/backend-core/lib/ai/listing-extraction.adapter";
import { FakeListingExtractionProvider } from "@homescout/backend-core/lib/ai/fake-extraction.provider";
import { FakeResendHydrator } from "@homescout/backend-core/lib/inbound/resend-hydrator";
import {
  DefaultInboundIngestionService,
  type ListingExtractionProvider,
} from "@homescout/backend-core/services/inbound-ingestion.service";
import { emailEventService } from "@homescout/backend-core/services/email-event.service";
import { enqueueAnalyzeListing } from "@homescout/backend-core/lib/queue/queue-client";
import type {
  ResendHydrator,
} from "@homescout/backend-core/lib/inbound/resend-hydrator";
import { RealResendHydrator } from "./resend-hydrator.js";
import { makeInboundHandler } from "./inbound-handler.js";

const metricsPort = Number(process.env.METRICS_PORT ?? 9090);
const metricsHost = process.env.METRICS_HOST ?? "0.0.0.0";

// ── Fail fast on infra at startup (mirrors Doxus worker bootstrap) ──────────
try {
  await prisma.$connect();
} catch (error) {
  console.error("Failed to connect to database at startup:", error);
  process.exit(1);
}

const redis = getRedisConnection();
try {
  await redis.ping();
} catch (error) {
  console.error("Failed to connect to Redis at startup:", error);
  process.exit(1);
}

// ── Wire the inbound-ingestion dependencies (real vs test-seam) ─────────────
const useFakeHydrator = process.env.RESEND_FAKE === "1";
const useFakeExtractor = process.env.EXTRACTION_FAKE === "1";

const hydrator: ResendHydrator = useFakeHydrator
  ? new FakeResendHydrator()
  : new RealResendHydrator();

const extractionProvider: ListingExtractionProvider = useFakeExtractor
  ? new FakeListingExtractionProvider()
  : new ClaudeListingExtractionAdapter();

const inboundIngestionService = new DefaultInboundIngestionService({
  extractionProvider,
  analyzeListingEnqueuer: {
    enqueueAnalyzeListing: async (listingId: string) => {
      await enqueueAnalyzeListing({
        idempotencyKey: `analyze:listing:${listingId}`,
        payload: { listingId },
      });
    },
  },
});

// ── BullMQ consumer: one processor per queue ────────────────────────────────
const queueClient = new BullMQQueueClient();

queueClient.registerProcessor(
  QUEUE_NAMES.inbound,
  makeInboundHandler({ hydrator, inboundIngestionService }),
  // Claude extraction can exceed the 30s default lock — extend it.
  { lockDuration: 180_000 },
);

queueClient.registerProcessor(QUEUE_NAMES.event, async (job) => {
  await emailEventService.ingestEvent({
    providerEventId: job.data.providerEventId,
    type: job.data.type,
    data: job.data.data,
    ...(job.data.created_at
      ? { occurredAt: new Date(job.data.created_at) }
      : {}),
  });
});

queueClient.registerProcessor(QUEUE_NAMES.analyze, async (job) => {
  // NO-OP until M5. Log + ack so the queue drains; M5 replaces this with the
  // scoring pipeline.
  console.info(
    JSON.stringify({
      type: "info",
      scope: "analyze.listing.noop",
      jobId: job.id ?? null,
      listingId: job.data.listingId ?? null,
    }),
  );
});

// ── Probe + metrics HTTP server (started LAST, after DB + Redis are healthy) ─
const metricsServer = http.createServer((request, response) => {
  void handleHttpRequest(request, response);
});

try {
  await new Promise<void>((resolve, reject) => {
    metricsServer.once("error", reject);
    metricsServer.listen(metricsPort, metricsHost, () => resolve());
  });
} catch (error) {
  console.error("Failed to start metrics server:", error);
  process.exit(1);
}

console.info(
  JSON.stringify({ type: "info", scope: "worker.started", metricsPort }),
);

// ── Graceful shutdown (SIGTERM/SIGINT) ──────────────────────────────────────
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 15_000);
    void (async () => {
      try {
        console.info(`Received ${signal}, shutting down worker gracefully`);
        await queueClient.close();
        await closeMetricsServer(metricsServer);
        await closeRedisConnection();
        await prisma.$disconnect();
      } catch (error) {
        console.error("Error during worker shutdown:", error);
      } finally {
        clearTimeout(forceExit);
        process.exit(0);
      }
    })();
  });
}

function closeMetricsServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function handleHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (request.method === "GET" && request.url === "/metrics") {
    try {
      await collectQueueMetrics(queueClient);
      const merged = `${await queueMetricsRegistry.metrics()}\n${await extractionMetricsRegistry.metrics()}`;
      response.writeHead(200, { "content-type": queueMetricsRegistry.contentType });
      response.end(merged);
    } catch (error) {
      console.error("Failed to collect metrics:", error);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("failed to collect metrics");
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}
