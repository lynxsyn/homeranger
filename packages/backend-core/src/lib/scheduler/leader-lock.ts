/**
 * Redis leader lock (M6 AC#3) — ensures a SINGLE scheduler instance enqueues the
 * warmup:recalc cadence even if the Deployment is scaled > 1. SET NX PX acquires
 * a TTL'd lease; the holder renews it on each tick. The TTL MUST exceed the
 * renew interval (so a brief tick delay does not drop the lease), and the lease
 * is OWNERSHIP-CHECKED on renew/release (a non-holder never steals or deletes
 * it). upsertJobScheduler is itself idempotent on its scheduler id, so even a
 * momentary split during a lease handover cannot register a duplicate cadence.
 *
 * Net-new pattern (no prior repo precedent) — kept tiny + unit-tested here.
 */
import type { Redis } from "ioredis";

/**
 * Acquire the lock if free, or renew it if we already hold it. Returns whether
 * this instance is the leader after the call.
 */
export async function acquireOrRenewLeader(
  redis: Redis,
  key: string,
  instanceId: string,
  ttlMs: number,
): Promise<boolean> {
  const acquired = await redis.set(key, instanceId, "PX", ttlMs, "NX");
  if (acquired === "OK") {
    return true;
  }
  // Someone holds it — only "us" may renew (extend the lease).
  const current = await redis.get(key);
  if (current === instanceId) {
    await redis.pexpire(key, ttlMs);
    return true;
  }
  return false;
}

/** Release the lock ONLY if we still own it (never delete another holder's). */
export async function releaseLeader(
  redis: Redis,
  key: string,
  instanceId: string,
): Promise<void> {
  const current = await redis.get(key);
  if (current === instanceId) {
    await redis.del(key);
  }
}
