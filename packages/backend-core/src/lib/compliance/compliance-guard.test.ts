import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailEventType } from "@prisma/client";
import {
  ComplianceError,
  DefaultComplianceGuard,
  getComplianceGuardConfig,
  type AgentForGuard,
  type ComplianceGuardConfig,
} from "./compliance-guard.js";
import type { ConsumeTokenResult } from "../rate-limit/redis-token-bucket.js";
import type { SuppressionEntryRepository } from "../../repositories/suppression-entry.repository.js";
import type { WarmupStateRepository } from "../../repositories/warmup-state.repository.js";
import type { EmailEventRepository } from "../../repositories/email-event.repository.js";
import type { OutreachRepository } from "../../repositories/outreach.repository.js";
import type { AgentRepository } from "../../repositories/agent.repository.js";

const CONFIG: ComplianceGuardConfig = {
  bounceRate: 0.02,
  complaintRate: 0.001,
  bounceMinSample: 50,
  complaintMinSample: 50,
  windowHours: 24,
  warmupWindowSeconds: 86_400,
  domainCooldownSeconds: 2_592_000, // 30 days
};

function corporateAgent(overrides: Partial<AgentForGuard> = {}): AgentForGuard {
  return {
    id: "agent-1",
    email: "branch@agency.test",
    mailboxType: "corporate_subscriber",
    optedOut: false,
    emailVerifyStatus: "deliverable",
    ...overrides,
  };
}

interface HarnessOpts {
  suppressed?: boolean;
  killSwitch?: boolean;
  dailyCap?: number;
  sends?: number;
  eventCounts?: Partial<Record<EmailEventType, number>>;
  token?: ConsumeTokenResult;
  /** true ⇒ another agent at the same domain was contacted within the window. */
  domainContacted?: boolean;
}

interface Harness {
  guard: DefaultComplianceGuard;
  isSuppressed: ReturnType<typeof vi.fn>;
  getOrCreate: ReturnType<typeof vi.fn>;
  countByTypeSince: ReturnType<typeof vi.fn>;
  countOutboundSince: ReturnType<typeof vi.fn>;
  consumeToken: ReturnType<typeof vi.fn>;
  wasDomainContactedSince: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const isSuppressed = vi.fn().mockResolvedValue(opts.suppressed ?? false);
  const getOrCreate = vi.fn().mockResolvedValue({
    id: "warmup-1",
    dailyCap: opts.dailyCap ?? 20,
    sentToday: 0,
    windowDate: new Date("2026-06-02"),
    killSwitch: opts.killSwitch ?? false,
    rampStartedAt: new Date("2026-06-01"),
    createdAt: new Date("2026-06-01"),
    updatedAt: new Date("2026-06-01"),
  });
  const countByTypeSince = vi.fn(
    async (eventType: EmailEventType) => opts.eventCounts?.[eventType] ?? 0,
  );
  const countOutboundSince = vi.fn().mockResolvedValue(opts.sends ?? 0);
  const consumeToken = vi.fn().mockResolvedValue(
    opts.token ?? {
      allowed: true,
      available: true,
      remaining: 19,
      retryAfterSeconds: 0,
    },
  );
  const wasDomainContactedSince = vi
    .fn()
    .mockResolvedValue(opts.domainContacted ?? false);

  const guard = new DefaultComplianceGuard({
    suppressionEntryRepository: {
      isSuppressed,
    } as unknown as SuppressionEntryRepository,
    warmupStateRepository: {
      getOrCreate,
    } as unknown as WarmupStateRepository,
    emailEventRepository: {
      countByTypeSince,
    } as unknown as EmailEventRepository,
    outreachRepository: {
      countOutboundSince,
    } as unknown as OutreachRepository,
    agentRepository: {
      wasDomainContactedSince,
    } as unknown as AgentRepository,
    consumeToken,
    config: CONFIG,
    now: () => new Date("2026-06-02T12:00:00Z"),
  });

  return {
    guard,
    isSuppressed,
    getOrCreate,
    countByTypeSince,
    countOutboundSince,
    consumeToken,
    wasDomainContactedSince,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("ComplianceGuard.assertCanSend — gates", () => {
  it("gate 1 PECR: blocks an individual mailbox (FORBIDDEN, non-retryable)", async () => {
    const h = makeHarness();
    await expect(
      h.guard.assertCanSend(corporateAgent({ mailboxType: "individual" })),
    ).rejects.toMatchObject({
      code: "PECR_NON_CORPORATE",
      trpcCode: "FORBIDDEN",
      retryable: false,
    });
  });

  it("gate 1 PECR: blocks an unknown mailbox", async () => {
    const h = makeHarness();
    await expect(
      h.guard.assertCanSend(corporateAgent({ mailboxType: "unknown" })),
    ).rejects.toBeInstanceOf(ComplianceError);
  });

  it("gate 2: blocks an opted-out agent", async () => {
    const h = makeHarness();
    await expect(
      h.guard.assertCanSend(corporateAgent({ optedOut: true })),
    ).rejects.toMatchObject({ code: "OPTED_OUT", trpcCode: "FORBIDDEN" });
  });

  it("gate 3: blocks a suppressed email", async () => {
    const h = makeHarness({ suppressed: true });
    await expect(
      h.guard.assertCanSend(corporateAgent()),
    ).rejects.toMatchObject({ code: "SUPPRESSED", retryable: false });
  });

  it("gate 4: blocks a confirmed-undeliverable email (FORBIDDEN, non-retryable)", async () => {
    const h = makeHarness();
    await expect(
      h.guard.assertCanSend(
        corporateAgent({ emailVerifyStatus: "undeliverable" }),
      ),
    ).rejects.toMatchObject({
      code: "EMAIL_UNDELIVERABLE",
      trpcCode: "FORBIDDEN",
      retryable: false,
    });
  });

  it("gate 4: 'unknown' (catch-all / unprobed) is NOT blocked", async () => {
    // We only ever block a CONFIRMED-dead address; unknown stays sendable.
    const h = makeHarness();
    await expect(
      h.guard.assertCanSend(corporateAgent({ emailVerifyStatus: "unknown" })),
    ).resolves.toBeUndefined();
  });

  it("gate 5: blocks when another mailbox at the same agency domain was contacted recently", async () => {
    const h = makeHarness({ domainContacted: true });
    await expect(
      h.guard.assertCanSend(
        corporateAgent({ email: "lettings@fletcherpoole.com" }),
      ),
    ).rejects.toMatchObject({
      code: "DOMAIN_RECENTLY_CONTACTED",
      trpcCode: "FORBIDDEN",
      retryable: false,
    });
  });

  it("gate 5: queries the agent's domain, excludes the agent itself, within the cooldown window", async () => {
    const h = makeHarness();
    await h.guard.assertCanSend(
      corporateAgent({ id: "agent-9", email: "conwy@fletcherpoole.com" }),
    );
    expect(h.wasDomainContactedSince).toHaveBeenCalledTimes(1);
    const [domain, since, excludeId] = h.wasDomainContactedSince.mock.calls[0]!;
    expect(domain).toBe("fletcherpoole.com");
    expect(excludeId).toBe("agent-9");
    // 30-day window before the frozen now (2026-06-02T12:00:00Z).
    expect((since as Date).toISOString()).toBe("2026-05-03T12:00:00.000Z");
  });

  it("gate 5: a clear agency domain passes (no other recent contact)", async () => {
    const h = makeHarness({ domainContacted: false });
    await expect(h.guard.assertCanSend(corporateAgent())).resolves.toBeUndefined();
  });

  it("gate 6: trips the breaker when bounce rate > 2% (>= min sample)", async () => {
    const h = makeHarness({ sends: 60, eventCounts: { bounced: 2 } }); // 3.3%
    await expect(
      h.guard.assertCanSend(corporateAgent()),
    ).rejects.toMatchObject({ code: "CIRCUIT_OPEN", trpcCode: "FORBIDDEN" });
  });

  it("gate 6: trips the breaker when complaint rate > 0.1% (>= min sample)", async () => {
    const h = makeHarness({ sends: 60, eventCounts: { complained: 1 } }); // 1.67%
    await expect(
      h.guard.assertCanSend(corporateAgent()),
    ).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
  });

  it("gate 6: recovers — bounce rate below 2% does NOT trip", async () => {
    const h = makeHarness({ sends: 60, eventCounts: { bounced: 1 } }); // 1.67%
    await expect(h.guard.assertCanSend(corporateAgent())).resolves.toBeUndefined();
  });

  it("gate 6: recovers — complaint rate below 0.1% does NOT trip", async () => {
    // 60 sends, 0 complaints (and 0 bounces) → both rates 0 → breaker closed.
    const h = makeHarness({ sends: 60, eventCounts: { complained: 0 } });
    await expect(h.guard.assertCanSend(corporateAgent())).resolves.toBeUndefined();
  });

  it("gate 6: does NOT trip on a tiny sample (below min-sample), even at 50% bounce", async () => {
    const h = makeHarness({ sends: 2, eventCounts: { bounced: 1 } }); // 50% but n=2
    await expect(h.guard.assertCanSend(corporateAgent())).resolves.toBeUndefined();
  });

  it("gate 7: blocks when the manual kill-switch is set", async () => {
    const h = makeHarness({ killSwitch: true });
    await expect(
      h.guard.assertCanSend(corporateAgent()),
    ).rejects.toMatchObject({ code: "KILL_SWITCH", trpcCode: "FORBIDDEN" });
  });

  it("gate 8: warm-up cap exhausted → deferred with retryAfterSeconds (TOO_MANY_REQUESTS, retryable)", async () => {
    const h = makeHarness({
      token: {
        allowed: false,
        available: true,
        remaining: 0,
        retryAfterSeconds: 3_600,
      },
    });
    await expect(
      h.guard.assertCanSend(corporateAgent()),
    ).rejects.toMatchObject({
      code: "WARMUP_CAP_EXCEEDED",
      trpcCode: "TOO_MANY_REQUESTS",
      retryable: true,
      retryAfterSeconds: 3_600,
    });
  });

  it("gate 8: Redis unavailable (fail-closed) → distinct RATE_LIMIT_UNAVAILABLE, retryable", async () => {
    const h = makeHarness({
      token: {
        allowed: false,
        available: false,
        remaining: 0,
        retryAfterSeconds: 86_400,
      },
    });
    await expect(
      h.guard.assertCanSend(corporateAgent()),
    ).rejects.toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE", retryable: true });
  });

  it("allows a clean corporate send (no throw)", async () => {
    const h = makeHarness();
    await expect(h.guard.assertCanSend(corporateAgent())).resolves.toBeUndefined();
    expect(h.consumeToken).toHaveBeenCalledTimes(1);
  });
});

describe("ComplianceGuard.assertCanSend — ordering & side-effects", () => {
  it("fails on PECR FIRST for a non-corporate + suppressed + over-cap agent (no later gate runs)", async () => {
    const h = makeHarness({
      suppressed: true,
      token: {
        allowed: false,
        available: true,
        remaining: 0,
        retryAfterSeconds: 3_600,
      },
    });
    await expect(
      h.guard.assertCanSend(corporateAgent({ mailboxType: "individual" })),
    ).rejects.toMatchObject({ code: "PECR_NON_CORPORATE" });
    // Short-circuit: neither suppression nor the token bucket is consulted.
    expect(h.isSuppressed).not.toHaveBeenCalled();
    expect(h.consumeToken).not.toHaveBeenCalled();
  });

  it("never consumes a warm-up token when blocked by an earlier gate", async () => {
    const h = makeHarness({ suppressed: true });
    await expect(h.guard.assertCanSend(corporateAgent())).rejects.toBeInstanceOf(
      ComplianceError,
    );
    expect(h.consumeToken).not.toHaveBeenCalled();
  });

  it("reserve:false (router precheck) PEEKS the token bucket, does not consume", async () => {
    const h = makeHarness();
    await h.guard.assertCanSend(corporateAgent(), { reserve: false });
    expect(h.consumeToken).toHaveBeenCalledWith(
      expect.objectContaining({ reserve: false }),
    );
  });

  it("reserve:true (worker) consumes a token", async () => {
    const h = makeHarness();
    await h.guard.assertCanSend(corporateAgent(), { reserve: true });
    expect(h.consumeToken).toHaveBeenCalledWith(
      expect.objectContaining({ reserve: true }),
    );
  });

  it("logs agentId + code on a block — never the email (PII)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = makeHarness({ suppressed: true });
    await expect(
      h.guard.assertCanSend(corporateAgent({ email: "secret@agency.test" })),
    ).rejects.toBeInstanceOf(ComplianceError);
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("outreach.blocked.SUPPRESSED");
    expect(logged).toContain("agent-1");
    expect(logged).not.toContain("secret@agency.test");
  });
});

describe("getComplianceGuardConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 2% bounce / 0.1% complaint with 10/200 min-samples", () => {
    const config = getComplianceGuardConfig();
    expect(config).toMatchObject({
      bounceRate: 0.02,
      complaintRate: 0.001,
      // Lowered 50 -> 10 so a bad batch trips the breaker at low warm-up volume
      // (the 40-send Conwy batch bounced 25% but never reached the old 50 floor).
      bounceMinSample: 10,
      complaintMinSample: 200,
      windowHours: 24,
    });
  });

  it("reads overrides from env", () => {
    vi.stubEnv("BREAKER_BOUNCE_RATE", "0.05");
    vi.stubEnv("BREAKER_BOUNCE_MIN_SAMPLE", "10");
    const config = getComplianceGuardConfig();
    expect(config.bounceRate).toBe(0.05);
    expect(config.bounceMinSample).toBe(10);
  });
});
