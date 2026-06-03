/**
 * Shared ioredis connection for BullMQ — the ENQUEUE side runs in apps/api
 * (the webhook routes) and the CONSUME side runs in apps/processor. Mirrors
 * doxus-web packages/backend-core/.../redis-connection.ts: a lazily-created
 * singleton carrying the connection options BullMQ REQUIRES
 * (`maxRetriesPerRequest: null`, `enableReadyCheck: false`) — without those two
 * BullMQ throws at Worker construction.
 *
 * homeranger difference vs Doxus: the cluster secret carries only
 * `REDIS_PASSWORD` (not a full URL) and the redis Service is `homeranger-redis`.
 * So we prefer an explicit `REDIS_URL` when set (local dev / CI docker-compose /
 * the processor Deployment env), else build the URL from
 * REDIS_HOST / REDIS_PORT / REDIS_PASSWORD. Both the api and processor
 * Deployments inject the connection details from homeranger-secret.
 */
import { Redis, type RedisOptions } from "ioredis";

let connection: Redis | null = null;

/** Resolve the Redis connection URL from REDIS_URL or the discrete parts. */
export function buildRedisUrl(): string {
  const explicit = process.env.REDIS_URL;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  const host = process.env.REDIS_HOST ?? "127.0.0.1";
  const port = process.env.REDIS_PORT ?? "6379";
  const password = process.env.REDIS_PASSWORD;
  const auth = password ? `:${encodeURIComponent(password)}@` : "";
  return `redis://${auth}${host}:${port}`;
}

/**
 * BullMQ-required connection options. `maxRetriesPerRequest: null` and
 * `enableReadyCheck: false` are MANDATORY for the blocking commands BullMQ
 * issues from a Worker — keep them identical on every connection that backs a
 * Queue or Worker.
 */
export const BULLMQ_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(buildRedisUrl(), BULLMQ_REDIS_OPTIONS);
  }
  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
