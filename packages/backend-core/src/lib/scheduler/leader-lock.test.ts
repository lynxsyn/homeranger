import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { acquireOrRenewLeader, releaseLeader } from "./leader-lock.js";

/** Minimal in-memory Redis modelling SET NX PX + GET + PEXPIRE + DEL ownership. */
function fakeRedis(): Redis & { _value: () => string | null } {
  let value: string | null = null;
  const redis = {
    async set(_key: string, val: string, _px: string, _ms: number, nx: string) {
      if (nx === "NX" && value !== null) {
        return null;
      }
      value = val;
      return "OK";
    },
    async get() {
      return value;
    },
    async pexpire() {
      return 1;
    },
    async del() {
      value = null;
      return 1;
    },
    _value: () => value,
  };
  return redis as unknown as Redis & { _value: () => string | null };
}

describe("acquireOrRenewLeader", () => {
  it("the first instance becomes leader; a second does NOT", async () => {
    const redis = fakeRedis();
    expect(await acquireOrRenewLeader(redis, "lock", "A", 90_000)).toBe(true);
    expect(await acquireOrRenewLeader(redis, "lock", "B", 90_000)).toBe(false);
  });

  it("the holder renews (extends the lease) and stays leader", async () => {
    const redis = fakeRedis();
    const pexpire = vi.spyOn(redis, "pexpire");
    await acquireOrRenewLeader(redis, "lock", "A", 90_000);
    expect(await acquireOrRenewLeader(redis, "lock", "A", 90_000)).toBe(true);
    expect(pexpire).toHaveBeenCalledWith("lock", 90_000);
  });

  it("re-acquisition after release re-registers exactly one leader", async () => {
    const redis = fakeRedis();
    await acquireOrRenewLeader(redis, "lock", "A", 90_000);
    await releaseLeader(redis, "lock", "A");
    expect(redis._value()).toBeNull();
    // B can now take it; A no longer renews (lease gone).
    expect(await acquireOrRenewLeader(redis, "lock", "B", 90_000)).toBe(true);
    expect(await acquireOrRenewLeader(redis, "lock", "A", 90_000)).toBe(false);
  });

  it("releaseLeader only deletes a lock it still owns", async () => {
    const redis = fakeRedis();
    await acquireOrRenewLeader(redis, "lock", "A", 90_000);
    await releaseLeader(redis, "lock", "B"); // B is not the holder → no-op
    expect(redis._value()).toBe("A");
  });
});
