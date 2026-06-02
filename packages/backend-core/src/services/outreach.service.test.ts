import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  DefaultOutreachService,
  OutreachError,
  getOutreachConfig,
  getOutreachService,
  _setOutreachServiceForTesting,
} from "./outreach.service.js";
import { ComplianceError } from "../lib/compliance/compliance-guard.js";
import type {
  EmailProvider,
  SendEmailInput,
} from "../lib/email/email-provider.js";
import type { AgentRecord, AgentRepository } from "../repositories/agent.repository.js";
import type { OutreachRepository } from "../repositories/outreach.repository.js";
import type { ComplianceGuard } from "../lib/compliance/compliance-guard.js";

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    email: "branch@agency.test",
    agencyName: "Test Agency",
    mailboxType: "corporate_subscriber",
    optedOut: false,
    coveredOutcodes: ["SW1A"],
    lastContactedAt: null,
    createdAt: new Date("2026-06-01"),
    updatedAt: new Date("2026-06-01"),
    ...overrides,
  } as AgentRecord;
}

function fakeProviderId(idempotencyKey: string): string {
  return `fake-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`;
}

interface Harness {
  service: DefaultOutreachService;
  send: ReturnType<typeof vi.fn>;
  assertCanSend: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  markContacted: ReturnType<typeof vi.fn>;
  findOrCreateOpenThreadByAgent: ReturnType<typeof vi.fn>;
  getThreadById: ReturnType<typeof vi.fn>;
  createOutboundMessage: ReturnType<typeof vi.fn>;
  applyThreadEvent: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { agent?: AgentRecord | null } = {}): Harness {
  const send = vi.fn(async (input: SendEmailInput) => ({
    providerMessageId: fakeProviderId(input.idempotencyKey),
  }));
  const assertCanSend = vi.fn().mockResolvedValue(undefined);
  const getById = vi
    .fn()
    .mockResolvedValue("agent" in opts ? opts.agent : agentRecord());
  const markContacted = vi.fn().mockResolvedValue(undefined);
  const thread = {
    id: "thread-1",
    agentId: "agent-1",
    subject: "Buyer enquiry",
    status: "awaiting_reply" as const,
    lastMessageAt: new Date("2026-06-01"),
    createdAt: new Date("2026-06-01"),
    updatedAt: new Date("2026-06-01"),
  };
  const findOrCreateOpenThreadByAgent = vi.fn().mockResolvedValue(thread);
  const getThreadById = vi.fn().mockResolvedValue(thread);
  const createOutboundMessage = vi
    .fn()
    .mockImplementation(async (input: { providerMessageId: string }) => ({
      id: "msg-1",
      providerMessageId: input.providerMessageId,
    }));
  const applyThreadEvent = vi.fn().mockResolvedValue("awaiting_reply");

  const service = new DefaultOutreachService({
    emailProvider: { send } as unknown as EmailProvider,
    complianceGuard: { assertCanSend } as unknown as ComplianceGuard,
    agentRepository: {
      getById,
      markContacted,
    } as unknown as AgentRepository,
    outreachRepository: {
      findOrCreateOpenThreadByAgent,
      getThreadById,
      createOutboundMessage,
      applyThreadEvent,
    } as unknown as OutreachRepository,
    emailConfig: { from: "Homescout <hi@homescout.test>" },
    config: {
      unsubscribeBaseUrl: "https://app.test/api/outreach/unsubscribe",
      followupCadenceHours: 72,
    },
    signToken: () => "unsub-token",
    now: () => new Date("2026-06-02T12:00:00Z"),
  });

  return {
    service,
    send,
    assertCanSend,
    getById,
    markContacted,
    findOrCreateOpenThreadByAgent,
    getThreadById,
    createOutboundMessage,
    applyThreadEvent,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("OutreachService.sendOutreach", () => {
  it("BLOCKED: a ComplianceError short-circuits before any send or persist", async () => {
    const h = makeHarness();
    h.assertCanSend.mockRejectedValue(
      new ComplianceError("SUPPRESSED", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      }),
    );
    await expect(h.service.sendOutreach({ agentId: "agent-1" })).rejects.toBeInstanceOf(
      ComplianceError,
    );
    expect(h.send).not.toHaveBeenCalled();
    expect(h.createOutboundMessage).not.toHaveBeenCalled();
  });

  it("ALLOWED: drafts, sends with an Idempotency-Key + one-click headers, and persists an outbound message", async () => {
    const h = makeHarness();
    const result = await h.service.sendOutreach({ agentId: "agent-1" });

    expect(h.assertCanSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", mailboxType: "corporate_subscriber" }),
      { reserve: true },
    );
    const sendArg = h.send.mock.calls[0]![0] as SendEmailInput;
    expect(sendArg.idempotencyKey).toBe("outreach:send:agent-1");
    expect(sendArg.to).toBe("branch@agency.test");
    expect(sendArg.from).toBe("Homescout <hi@homescout.test>");
    expect(sendArg.headers?.["List-Unsubscribe"]).toContain("unsub-token");
    expect(sendArg.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );

    expect(h.createOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        toEmail: "branch@agency.test",
        providerMessageId: fakeProviderId("outreach:send:agent-1"),
        sentAt: new Date("2026-06-02T12:00:00Z"),
      }),
    );
    expect(h.applyThreadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1", event: "outbound_sent" }),
    );
    expect(h.markContacted).toHaveBeenCalledWith(
      "agent-1",
      new Date("2026-06-02T12:00:00Z"),
    );
    expect(result).toMatchObject({
      threadId: "thread-1",
      providerMessageId: fakeProviderId("outreach:send:agent-1"),
      status: "awaiting_reply",
    });
  });

  it("RETRY-SAFE: a retry after a crash-between-send-and-persist reuses the SAME idempotency key + provider id (no double-send)", async () => {
    const h = makeHarness();
    // First attempt: send succeeds, persist throws (crash window) → rejects.
    h.createOutboundMessage.mockRejectedValueOnce(new Error("db blip"));
    await expect(h.service.sendOutreach({ agentId: "agent-1" })).rejects.toThrow();
    // Second attempt (BullMQ retry): send again, persist succeeds.
    await h.service.sendOutreach({ agentId: "agent-1" });

    expect(h.send).toHaveBeenCalledTimes(2);
    const key1 = (h.send.mock.calls[0]![0] as SendEmailInput).idempotencyKey;
    const key2 = (h.send.mock.calls[1]![0] as SendEmailInput).idempotencyKey;
    expect(key1).toBe(key2); // stable key → real provider dedupes → no 2nd email
    // Same provider id both times → OutreachMessage @@unique makes persist idempotent.
    const persisted = h.createOutboundMessage.mock.calls.map(
      (c) => (c[0] as { providerMessageId: string }).providerMessageId,
    );
    expect(new Set(persisted).size).toBe(1);
  });

  it("throws a non-retryable OutreachError when the agent does not exist", async () => {
    const h = makeHarness({ agent: null });
    await expect(
      h.service.sendOutreach({ agentId: "missing" }),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      h.service.sendOutreach({ agentId: "missing" }),
    ).rejects.toBeInstanceOf(OutreachError);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("OutreachService.sendFollowup", () => {
  it("sends on the existing thread with a per-thread idempotency key (no new thread)", async () => {
    const h = makeHarness();
    const result = await h.service.sendFollowup({ threadId: "thread-1" });

    expect(h.findOrCreateOpenThreadByAgent).not.toHaveBeenCalled();
    const sendArg = h.send.mock.calls[0]![0] as SendEmailInput;
    expect(sendArg.idempotencyKey).toBe("outreach:followup:thread-1");
    expect(h.createOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
    );
    expect(result.threadId).toBe("thread-1");
  });

  it("throws a non-retryable OutreachError when the thread is missing", async () => {
    const h = makeHarness();
    h.getThreadById.mockResolvedValueOnce(null);
    await expect(
      h.service.sendFollowup({ threadId: "missing" }),
    ).rejects.toMatchObject({ retryable: false });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("re-checks the guard before a follow-up send (blocked → no send)", async () => {
    const h = makeHarness();
    h.assertCanSend.mockRejectedValue(
      new ComplianceError("KILL_SWITCH", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      }),
    );
    await expect(
      h.service.sendFollowup({ threadId: "thread-1" }),
    ).rejects.toBeInstanceOf(ComplianceError);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("getOutreachConfig", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("defaults the follow-up cadence to 72h", () => {
    expect(getOutreachConfig().followupCadenceHours).toBe(72);
  });
});

describe("getOutreachService (lazy singleton)", () => {
  afterEach(() => _setOutreachServiceForTesting(null));

  it("throws when used before initialisation at worker boot", () => {
    _setOutreachServiceForTesting(null);
    expect(() => getOutreachService()).toThrow(/not initialised/);
  });

  it("initialises from deps and returns the same instance thereafter", () => {
    const send = vi.fn(async () => ({ providerMessageId: "x" }));
    const first = getOutreachService({
      emailProvider: { send } as unknown as EmailProvider,
      emailConfig: { from: "Homescout <hi@homescout.test>" },
    });
    expect(getOutreachService()).toBe(first);
  });
});
