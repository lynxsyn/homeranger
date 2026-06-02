import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { consumeToken } from "./redis-token-bucket.js";

/**
 * Unit tests for the token-bucket JS wrapper: result mapping + the FAIL-CLOSED
 * Redis-outage path + the reserve→Lua-arg contract. The Lua cap-enforcement
 * itself (INCR vs cap) is exercised against real Redis in the integration
 * suite; here we inject a fake `eval` returning the `[allowed, count, ttl]`
 * tuple the script yields.
 */
function fakeRedis(evalImpl: (...args: unknown[]) => Promise<unknown>): Redis {
  return { eval: vi.fn(evalImpl) } as unknown as Redis;
}

describe("consumeToken", () => {
  it("allows and reports remaining when under cap (reserve consumes)", async () => {
    const redis = fakeRedis(async () => [1, 3, 86_400]);
    const result = await consumeToken(
      { key: "outreach:warmup:2026-06-02", cap: 20, windowSeconds: 86_400 },
      redis,
    );
    expect(result).toEqual({
      allowed: true,
      available: true,
      remaining: 17,
      retryAfterSeconds: 0,
    });
    // reserve defaults to true → the Lua reserve arg is "1".
    expect((redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      expect.any(String),
      1,
      "outreach:warmup:2026-06-02",
      "20",
      "86400",
      "1",
    ]);
  });

  it("denies with retryAfterSeconds = TTL when at/over cap", async () => {
    const redis = fakeRedis(async () => [0, 20, 3_600]);
    const result = await consumeToken(
      { key: "k", cap: 20, windowSeconds: 86_400 },
      redis,
    );
    expect(result).toMatchObject({
      allowed: false,
      available: true,
      remaining: 0,
      retryAfterSeconds: 3_600,
    });
  });

  it("PEEKS without mutating when reserve:false (Lua arg '0')", async () => {
    const redis = fakeRedis(async () => [1, 5, 80_000]);
    const result = await consumeToken(
      { key: "k", cap: 20, windowSeconds: 86_400, reserve: false },
      redis,
    );
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(15);
    expect((redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[5]).toBe(
      "0",
    );
  });

  it("FAILS CLOSED when Redis throws (never send when cap is unprovable)", async () => {
    const redis = fakeRedis(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await consumeToken(
      { key: "k", cap: 20, windowSeconds: 86_400 },
      redis,
    );
    expect(result).toEqual({
      allowed: false,
      available: false,
      remaining: 0,
      retryAfterSeconds: 86_400,
    });
  });

  it("falls back to windowSeconds for retryAfter when TTL is unset (-1/-2)", async () => {
    const redis = fakeRedis(async () => [0, 20, -1]);
    const result = await consumeToken(
      { key: "k", cap: 20, windowSeconds: 86_400 },
      redis,
    );
    expect(result.retryAfterSeconds).toBe(86_400);
  });
});
