/**
 * homescout scheduler — the leader-locked cadence driver (M6 AC#3).
 *
 * A single elected instance (Redis SET NX PX leader lock) registers the
 * warmup:recalc repeatable job via BullMQ's job scheduler; the processor
 * consumes it (ramp the daily cap + reconcile the window). Scaling the
 * Deployment > 1 is safe — only the lease holder registers, and
 * upsertJobScheduler is idempotent on its scheduler id, so a lease handover can
 * never produce a duplicate cadence.
 *
 * Bootstrap mirrors apps/processor/src/worker.ts: fail fast on Redis, serve
 * GET /health LAST (real readiness), graceful SIGTERM/SIGINT shutdown that
 * releases the lock. Node16 resolution → relative imports carry `.js` (none
 * here); cross-package imports use the @homescout/backend-core subpaths.
 */
import http from "node:http";
import os from "node:os";
import {
  closeRedisConnection,
  getRedisConnection,
} from "@homescout/backend-core/lib/queue/redis-connection";
import { getQueueClient } from "@homescout/backend-core/lib/queue/queue-client";
import { QUEUE_NAMES } from "@homescout/backend-core/lib/queue/queue-config";
import {
  acquireOrRenewLeader,
  releaseLeader,
} from "@homescout/backend-core/lib/scheduler/leader-lock";

const LOCK_KEY = "homescout:scheduler:leader";
// TTL must exceed the renew interval so a brief tick delay never drops the lease.
const LOCK_TTL_MS = 90_000;
const RENEW_MS = 30_000;
const WARMUP_SCHEDULER_ID = "warmup:recalc:cadence";
const WARMUP_EVERY_MS = Number(
  process.env.WARMUP_RECALC_EVERY_MS ?? 6 * 60 * 60 * 1000,
);
const FOLLOWUP_SCAN_SCHEDULER_ID = "outreach:followup-scan:cadence";
const FOLLOWUP_SCAN_EVERY_MS = Number(
  process.env.FOLLOWUP_SCAN_EVERY_MS ?? 60 * 60 * 1000, // hourly
);
const instanceId = `${os.hostname()}:${process.pid}`;

const healthPort = Number(process.env.METRICS_PORT ?? 9091);
const healthHost = process.env.METRICS_HOST ?? "0.0.0.0";

const redis = getRedisConnection();
try {
  await redis.ping();
} catch (error) {
  console.error("Failed to connect to Redis at startup:", error);
  process.exit(1);
}

const queueClient = getQueueClient();
let isLeader = false;

async function tick(): Promise<void> {
  try {
    isLeader = await acquireOrRenewLeader(
      redis,
      LOCK_KEY,
      instanceId,
      LOCK_TTL_MS,
    );
    if (isLeader) {
      // Idempotent on the scheduler ids — safe to call every tick.
      await queueClient.upsertScheduledJob(
        QUEUE_NAMES.warmup,
        WARMUP_SCHEDULER_ID,
        { every: WARMUP_EVERY_MS },
        { reason: "scheduled" },
      );
      await queueClient.upsertScheduledJob(
        QUEUE_NAMES.followupScan,
        FOLLOWUP_SCAN_SCHEDULER_ID,
        { every: FOLLOWUP_SCAN_EVERY_MS },
        { reason: "scheduled" },
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "error",
        scope: "scheduler.tick.error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

await tick();
const renewTimer = setInterval(() => void tick(), RENEW_MS);

const healthServer = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", leader: isLeader }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});

try {
  await new Promise<void>((resolve, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(healthPort, healthHost, () => resolve());
  });
} catch (error) {
  console.error("Failed to start health server:", error);
  process.exit(1);
}

console.info(
  JSON.stringify({ type: "info", scope: "scheduler.started", healthPort, instanceId }),
);

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
        console.info(`Received ${signal}, shutting down scheduler gracefully`);
        clearInterval(renewTimer);
        await releaseLeader(redis, LOCK_KEY, instanceId);
        await new Promise<void>((resolve) => healthServer.close(() => resolve()));
        await queueClient.close();
        await closeRedisConnection();
      } catch (error) {
        console.error("Error during scheduler shutdown:", error);
      } finally {
        clearTimeout(forceExit);
        process.exit(0);
      }
    })();
  });
}
