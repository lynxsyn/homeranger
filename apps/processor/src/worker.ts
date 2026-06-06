/**
 * homeranger processor — the consume side of the M4 inbound-ingestion pipeline.
 *
 * M4 brings apps/processor up from the empty skeleton into a real BullMQ worker
 * on homeranger-redis (the way M3 brought apps/api up). It registers one
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
 * / OutboxRelay / scheduled-job ownership (homeranger has none in M4). Node16
 * resolution → all relative imports carry `.js`.
 */
import http from "node:http";
import { prisma } from "@homeranger/backend-core/lib/prisma";
import { BullMQQueueClient } from "@homeranger/backend-core/lib/queue/queue-client";
import { QUEUE_NAMES } from "@homeranger/backend-core/lib/queue/queue-config";
import {
  closeRedisConnection,
  getRedisConnection,
} from "@homeranger/backend-core/lib/queue/redis-connection";
import {
  collectQueueMetrics,
  queueMetricsRegistry,
} from "@homeranger/backend-core/lib/queue/queue-metrics";
import { extractionMetricsRegistry } from "@homeranger/backend-core/lib/ai/claude-extraction.provider";
import { analysisMetricsRegistry } from "@homeranger/backend-core/lib/ai/analysis-metrics";
import { ClaudeListingExtractionAdapter } from "@homeranger/backend-core/lib/ai/listing-extraction.adapter";
import { FakeListingExtractionProvider } from "@homeranger/backend-core/lib/ai/fake-extraction.provider";
import { FakeResendHydrator } from "@homeranger/backend-core/lib/inbound/resend-hydrator";
import {
  DefaultInboundIngestionService,
  type ListingExtractionProvider,
} from "@homeranger/backend-core/services/inbound-ingestion.service";
import { emailEventService } from "@homeranger/backend-core/services/email-event.service";
import { enqueueAnalyzeListing } from "@homeranger/backend-core/lib/queue/queue-client";
import type {
  ResendHydrator,
} from "@homeranger/backend-core/lib/inbound/resend-hydrator";
// M5 analysis pipeline wiring (real providers vs ANALYSIS_FAKE seam).
import { DefaultClaudeVisionScorer } from "@homeranger/backend-core/lib/ai/vision-scorer.provider";
import { FakeVisionScorer } from "@homeranger/backend-core/lib/ai/fake-vision-scorer.provider";
import { VoyageEmbeddingProvider } from "@homeranger/backend-core/lib/ai/embedding-provider";
import { FakeEmbeddingProvider } from "@homeranger/backend-core/lib/ai/fake-embedding.provider";
import { DefaultClaudeMatchScorer } from "@homeranger/backend-core/lib/ai/match-scorer.provider";
import { FakeMatchScorer } from "@homeranger/backend-core/lib/ai/fake-match-scorer.provider";
import { DefaultClaudeAgentClassifier } from "@homeranger/backend-core/lib/ai/agent-classifier.provider";
import { FakeAgentClassifier } from "@homeranger/backend-core/lib/ai/fake-agent-classifier.provider";
import { R2PhotoSource } from "@homeranger/backend-core/lib/ai/r2-photo-source.provider";
import { FakePhotoSource } from "@homeranger/backend-core/lib/ai/fake-photo-source.provider";
import type { VisionScorer } from "@homeranger/backend-core/lib/ai/vision-scorer.provider";
import type { EmbeddingProvider } from "@homeranger/backend-core/lib/ai/embedding-provider";
import type { MatchScorer } from "@homeranger/backend-core/lib/ai/match-scorer.provider";
import type { AgentClassifier } from "@homeranger/backend-core/lib/ai/agent-classifier.provider";
import type { PhotoSource } from "@homeranger/backend-core/lib/ai/photo-source";
import { getPreferenceMatchService } from "@homeranger/backend-core/services/preference-match.service";
import { getListingAnalysisService } from "@homeranger/backend-core/services/listing-analysis.service";
import {
  FakeEmailSendProvider,
  type EmailProvider,
} from "@homeranger/backend-core/lib/email/email-provider";
import {
  NodemailerEmailProvider,
  ResendEmailSendProvider,
} from "@homeranger/backend-core/lib/email/mailbox-adapter";
import { getOutreachService } from "@homeranger/backend-core/services/outreach.service";
import { searchRepository } from "@homeranger/backend-core/repositories/search.repository";
import { outreachReplyService } from "@homeranger/backend-core/services/outreach-reply.service";
import { warmupService } from "@homeranger/backend-core/services/warmup.service";
import {
  FakeAgentDiscoveryProvider,
  type AgentDiscoveryProvider,
} from "@homeranger/backend-core/lib/discovery/agent-discovery.provider";
import { FirecrawlAgentDiscoveryProvider } from "@homeranger/backend-core/lib/discovery/firecrawl-agent-discovery.provider";
import { SerperAgentDiscoveryProvider } from "@homeranger/backend-core/lib/discovery/serper-agent-discovery.provider";
import { getAgentDiscoveryService } from "@homeranger/backend-core/services/agent-discovery.service";
import {
  FakeListingScrapeProvider,
  type ListingScrapeProvider,
} from "@homeranger/backend-core/lib/listing-scrape/listing-scrape.provider";
import { FetchListingScrapeProvider } from "@homeranger/backend-core/lib/listing-scrape/fetch-listing-scrape.provider";
import { getListingScrapeService } from "@homeranger/backend-core/services/listing-scrape.service";
import { RealResendHydrator } from "./resend-hydrator.js";
import { makeInboundHandler } from "./inbound-handler.js";
import { makeAnalyzeHandler } from "./analyze-handler.js";
import { makeRecomputeHandler } from "./recompute-handler.js";
import { makeOutreachSendHandler } from "./outreach-send-handler.js";
import { makeOutreachFollowupHandler } from "./outreach-followup-handler.js";
import { makeFollowupScanHandler } from "./followup-scan-handler.js";
import { makeWarmupRecalcHandler } from "./warmup-recalc-handler.js";
import { makeDiscoverAgentsHandler } from "./discover-agents-handler.js";
import { makeScrapeListingsHandler } from "./scrape-listings-handler.js";

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

// ── Wire the M5 analysis pipeline (real providers vs ANALYSIS_FAKE seam) ─────
// ANALYSIS_FAKE=1 swaps every LLM/embedding/photo dependency for the
// deterministic, network-free fakes (E2E/CI never call Anthropic/Voyage/R2);
// VISION_FAKE / EMBEDDING_FAKE / MATCH_FAKE allow per-provider overrides.
const useFakeAnalysis = process.env.ANALYSIS_FAKE === "1";

const visionScorer: VisionScorer =
  useFakeAnalysis || process.env.VISION_FAKE === "1"
    ? new FakeVisionScorer()
    : new DefaultClaudeVisionScorer();

const embeddingProvider: EmbeddingProvider =
  useFakeAnalysis || process.env.EMBEDDING_FAKE === "1"
    ? new FakeEmbeddingProvider()
    : new VoyageEmbeddingProvider();

const matchScorer: MatchScorer =
  useFakeAnalysis || process.env.MATCH_FAKE === "1"
    ? new FakeMatchScorer()
    : new DefaultClaudeMatchScorer();

const photoSource: PhotoSource = useFakeAnalysis
  ? new FakePhotoSource()
  : new R2PhotoSource();

const preferenceMatchService = getPreferenceMatchService({
  embeddingProvider,
  matchScorer,
});

const listingAnalysisService = getListingAnalysisService({
  visionScorer,
  embeddingProvider,
  photoSource,
  preferenceMatchService,
});

// ── Wire the M6 outreach send path (real Resend / SMTP vs OUTREACH_FAKE seam) ─
// OUTREACH_FAKE=1 swaps the real transport for the deterministic, network-free
// fake (E2E/CI never dispatch a real email). EMAIL_TRANSPORT=smtp selects the
// nodemailer fallback; otherwise Resend. The guard re-checks authoritatively on
// the send path; the OutreachService persists + advances thread status.
const useFakeOutreach = process.env.OUTREACH_FAKE === "1";
const emailProvider: EmailProvider = useFakeOutreach
  ? new FakeEmailSendProvider()
  : process.env.EMAIL_TRANSPORT === "smtp"
    ? new NodemailerEmailProvider()
    : new ResendEmailSendProvider();

// PR3: pass the searchRepository so a search-launched send (job.searchId) drafts
// the body from that search's brief (draftSearchEmail) instead of the generic draft.
const outreachService = getOutreachService({ emailProvider, searchRepository });

// ── Wire M7 agent discovery (Serper | Firecrawl | DISCOVERY_FAKE seam) ───────
// DISCOVERY_FAKE=1 swaps the web search/fetch vendor for the deterministic,
// network-free fake (E2E/CI never scrape or spend). Otherwise DISCOVERY_PROVIDER
// selects the real adapter: "serper" → Serper SERP + in-process HTTP fetch (the
// post-Firecrawl default, dormant without SERPER_API_KEY); anything else →
// Firecrawl (legacy, dormant without FIRECRAWL_API_KEY). Both are construction-
// safe, so the worker boots regardless of which keys are set.
const agentDiscoveryProvider: AgentDiscoveryProvider =
  process.env.DISCOVERY_FAKE === "1"
    ? new FakeAgentDiscoveryProvider()
    : process.env.DISCOVERY_PROVIDER === "serper"
      ? new SerperAgentDiscoveryProvider()
      : new FirecrawlAgentDiscoveryProvider();
// The agent quality classifier (auto-drop confident non-agency junk at
// discovery). Folded under the ANALYSIS_FAKE umbrella exactly like the match
// scorer; CLASSIFY_FAKE=1 overrides for a per-provider fake. CI/E2E run
// ANALYSIS_FAKE=1 → the deterministic fake → no Anthropic call, no spend.
const agentClassifier: AgentClassifier =
  useFakeAnalysis || process.env.CLASSIFY_FAKE === "1"
    ? new FakeAgentClassifier()
    : new DefaultClaudeAgentClassifier();
const agentDiscoveryService = getAgentDiscoveryService({
  provider: agentDiscoveryProvider,
  classifier: agentClassifier,
});

// ── Wire listing-site scrape (in-process fetch vs LISTING_SCRAPE_FAKE seam) ───
// LISTING_SCRAPE_FAKE=1 swaps the scraper for the deterministic, network-free
// fake (E2E/CI never scrape). The real provider fetches the sites in-process
// (no Firecrawl, no credits) and is dormant until LISTING_SCRAPE_SITES enables a
// site. The same analyze enqueuer used by the inbound pipeline hands scraped
// listings to the M5 analysis path.
const listingScrapeProvider: ListingScrapeProvider =
  process.env.LISTING_SCRAPE_FAKE === "1"
    ? new FakeListingScrapeProvider()
    : new FetchListingScrapeProvider();
const listingScrapeService = getListingScrapeService({
  provider: listingScrapeProvider,
  enqueueAnalyze: async (listingId: string) => {
    await enqueueAnalyzeListing({
      idempotencyKey: `analyze:listing:${listingId}`,
      payload: { listingId },
    });
  },
});

// ── BullMQ consumer: one processor per queue ────────────────────────────────
const queueClient = new BullMQQueueClient();

queueClient.registerProcessor(
  QUEUE_NAMES.inbound,
  makeInboundHandler({
    hydrator,
    inboundIngestionService,
    // M6: link a listing-bearing agent reply back to its OutreachThread.
    outreachReplyService,
  }),
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

queueClient.registerProcessor(
  QUEUE_NAMES.analyze,
  makeAnalyzeHandler({ listingAnalysisService }),
  // Vision + embed + per-listing re-score can exceed the 30s default lock.
  { lockDuration: 180_000 },
);

queueClient.registerProcessor(
  QUEUE_NAMES.recompute,
  makeRecomputeHandler({ preferenceMatchService }),
  // Top-K LLM re-score can exceed the 30s default lock — extend it.
  { lockDuration: 180_000 },
);

// ── M6 outreach consumers ────────────────────────────────────────────────────
queueClient.registerProcessor(
  QUEUE_NAMES.send,
  makeOutreachSendHandler({ outreachService }),
  // The SMTP/Resend round-trip can exceed the 30s default lock — extend it.
  { lockDuration: 60_000 },
);

queueClient.registerProcessor(
  QUEUE_NAMES.followup,
  makeOutreachFollowupHandler({ outreachService }),
  { lockDuration: 60_000 },
);

// Cadence scan (scheduler-driven): list awaiting_reply threads past the
// follow-up cadence + fan out one outreach:followup per due thread.
queueClient.registerProcessor(
  QUEUE_NAMES.followupScan,
  makeFollowupScanHandler(),
);

// warmup:recalc is enqueued on a cadence by the scheduler (leader-lock); the
// processor consumes it here (ramp the daily cap + reconcile the window).
queueClient.registerProcessor(
  QUEUE_NAMES.warmup,
  makeWarmupRecalcHandler({ warmupService }),
);

// M7: discover estate agents in a region (web search/extract → upsert Agents).
// Can exceed the 30s default lock (multi-page search/scrape) — extend it.
queueClient.registerProcessor(
  QUEUE_NAMES.discoverAgents,
  makeDiscoverAgentsHandler({ agentDiscoveryService }),
  { lockDuration: 180_000 },
);

// Listing-site scrape: scrape public listing sites → dedup → upsert Listings →
// enqueue analyze:listing. Multi-page scrape + crawl-delay can far exceed the
// 30s default lock — extend it.
queueClient.registerProcessor(
  QUEUE_NAMES.scrapeListings,
  makeScrapeListingsHandler({ listingScrapeService }),
  { lockDuration: 180_000 },
);

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
      const merged = [
        await queueMetricsRegistry.metrics(),
        await extractionMetricsRegistry.metrics(),
        await analysisMetricsRegistry.metrics(),
      ].join("\n");
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
