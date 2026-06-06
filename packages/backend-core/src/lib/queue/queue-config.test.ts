import { describe, expect, it } from "vitest";
import {
  outreachFollowupLimiter,
  outreachSendLimiter,
  resendTotalSendsPerSecond,
  RESEND_HARD_CAP_PER_SECOND,
} from "./queue-config.js";

/**
 * The Resend-backed send queues (outreach:send + outreach:followup) share ONE
 * account-wide 5 requests/second budget. A batch approve used to fire all its
 * sends at once (worker concurrency, no limiter) and burst past that cap →
 * rate_limit_exceeded → terminal loss of real sends. These pure helpers resolve
 * the per-queue BullMQ limiters that split the budget so the COMBINED rate stays
 * within the cap even if both queues run flat out. They are unit-covered
 * (queue-config.ts is NOT coverage-excluded, unlike worker.ts/queue-client.ts).
 */
describe("resendTotalSendsPerSecond", () => {
  it("defaults to 4 — headroom under Resend's 5/s cap — when unset", () => {
    expect(resendTotalSendsPerSecond({})).toBe(4);
  });

  it("honours a valid RESEND_MAX_SENDS_PER_SECOND override", () => {
    expect(resendTotalSendsPerSecond({ RESEND_MAX_SENDS_PER_SECOND: "3" })).toBe(
      3,
    );
  });

  it("never exceeds the Resend hard cap (clamps a too-high override)", () => {
    expect(
      resendTotalSendsPerSecond({ RESEND_MAX_SENDS_PER_SECOND: "50" }),
    ).toBe(RESEND_HARD_CAP_PER_SECOND);
    expect(RESEND_HARD_CAP_PER_SECOND).toBe(5);
  });

  it("accepts an override exactly at the hard cap", () => {
    expect(resendTotalSendsPerSecond({ RESEND_MAX_SENDS_PER_SECOND: "5" })).toBe(
      5,
    );
  });

  it("floors a too-low override to 2 (so each split queue keeps >=1/s)", () => {
    expect(resendTotalSendsPerSecond({ RESEND_MAX_SENDS_PER_SECOND: "1" })).toBe(
      2,
    );
    expect(
      resendTotalSendsPerSecond({ RESEND_MAX_SENDS_PER_SECOND: "2.5" }),
    ).toBe(2);
  });

  it("falls back to the default on garbage / non-positive values", () => {
    expect(
      resendTotalSendsPerSecond({ RESEND_MAX_SENDS_PER_SECOND: "nope" }),
    ).toBe(4);
    expect(resendTotalSendsPerSecond({ RESEND_MAX_SENDS_PER_SECOND: "0" })).toBe(
      4,
    );
    expect(
      resendTotalSendsPerSecond({ RESEND_MAX_SENDS_PER_SECOND: "-2" }),
    ).toBe(4);
  });
});

describe("outreach send/followup limiters", () => {
  it("split the budget: send gets total-1, followup gets the fixed 1/s slice", () => {
    expect(outreachSendLimiter({})).toEqual({ max: 3, duration: 1000 });
    expect(outreachFollowupLimiter()).toEqual({ max: 1, duration: 1000 });
    expect(outreachSendLimiter({ RESEND_MAX_SENDS_PER_SECOND: "2" })).toEqual({
      max: 1,
      duration: 1000,
    });
  });

  it("INVARIANT: send + followup never exceed the Resend hard cap", () => {
    for (const override of [undefined, "2", "4", "5", "50", "1", "nope"]) {
      const env =
        override === undefined ? {} : { RESEND_MAX_SENDS_PER_SECOND: override };
      const combined = outreachSendLimiter(env).max + outreachFollowupLimiter().max;
      expect(combined).toBeLessThanOrEqual(RESEND_HARD_CAP_PER_SECOND);
      expect(outreachSendLimiter(env).max).toBeGreaterThanOrEqual(1);
    }
  });
});
