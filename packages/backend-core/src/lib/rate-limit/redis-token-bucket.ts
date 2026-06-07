/**
 * Fixed-window token bucket on Redis — the warm-up daily-cap arm of the M6
 * ComplianceGuard (gate 8). A single atomic Lua script enforces the cap so two
 * concurrent sends can never both slip past a cap of N.
 *
 * FAIL-CLOSED (load-bearing compliance property): if Redis is unreachable the
 * call returns `{ allowed: false, available: false }` — we must NEVER send when
 * we cannot prove we are under cap. The cost is an availability trade-off: a
 * Redis outage halts ALL outreach by design. Do NOT "fix" a perceived outage by
 * making this fail-open — over-sending (reputation/PECR breach) is the worse
 * failure for a cold-B2B sender. The guard surfaces a distinct
 * `RATE_LIMIT_UNAVAILABLE` block (vs `WARMUP_CAP_EXCEEDED`) so an outage is
 * observable rather than looking like a legitimate cap hit.
 *
 * `reserve` splits the two call sites:
 *   - reserve:true  (worker send path) — CONSUMES a token (INCR), authoritative.
 *   - reserve:false (router precheck)  — PEEKS remaining (GET), never mutates.
 */
import type { Redis } from "ioredis";
import { getRedisConnection } from "../queue/redis-connection.js";

export interface ConsumeTokenInput {
  /** Bucket key — typically `outreach:warmup:<windowDate>`. */
  key: string;
  /** Hard ceiling for the window. */
  cap: number;
  /** Window length in seconds (the EXPIRE TTL on first hit). */
  windowSeconds: number;
  /** true (default) consumes a token; false peeks remaining without mutating. */
  reserve?: boolean;
}

export interface ConsumeTokenResult {
  /** Whether this send is permitted under the cap. */
  allowed: boolean;
  /** false ONLY when the Redis backend was unreachable (fail-closed). */
  available: boolean;
  /** Tokens left in the window (0 when over cap or unavailable). */
  remaining: number;
  /** Seconds until the window resets (the TTL); window length on a denial. */
  retryAfterSeconds: number;
}

/**
 * Atomic fixed-window counter. KEYS[1]=bucket key; ARGV=[cap, windowSeconds,
 * reserve(0|1)]. reserve=1 checks-then-INCRs (setting the EXPIRE on the first
 * hit) and refuses to increment past the cap; reserve=0 only reads. Returns
 * `{ allowed(0|1), count, ttl }`.
 */
const CONSUME_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local reserve = ARGV[3]
if reserve == '1' then
  if current >= cap then
    local ttl = redis.call('TTL', KEYS[1])
    return {0, current, ttl}
  end
  local newval = redis.call('INCR', KEYS[1])
  if newval == 1 then
    redis.call('EXPIRE', KEYS[1], window)
  end
  local ttl = redis.call('TTL', KEYS[1])
  return {1, newval, ttl}
else
  local ttl = redis.call('TTL', KEYS[1])
  if current < cap then
    return {1, current, ttl}
  end
  return {0, current, ttl}
end
`;

export async function consumeToken(
  input: ConsumeTokenInput,
  redis: Redis = getRedisConnection(),
): Promise<ConsumeTokenResult> {
  const reserve = input.reserve ?? true;
  try {
    const raw = (await redis.eval(
      CONSUME_LUA,
      1,
      input.key,
      String(input.cap),
      String(input.windowSeconds),
      reserve ? "1" : "0",
    )) as [number, number, number];
    const allowed = Number(raw[0]) === 1;
    const count = Number(raw[1]);
    const ttl = Number(raw[2]);
    const remaining = Math.max(0, input.cap - count);
    const retryAfterSeconds = allowed
      ? 0
      : ttl > 0
        ? ttl
        : input.windowSeconds;
    return { allowed, available: true, remaining, retryAfterSeconds };
  } catch (error) {
    // FAIL-CLOSED: never send when we cannot prove we are under cap.
    console.error(
      JSON.stringify({
        type: "error",
        scope: "rate-limit.token-bucket.unavailable",
        key: input.key,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      allowed: false,
      available: false,
      remaining: 0,
      retryAfterSeconds: input.windowSeconds,
    };
  }
}
