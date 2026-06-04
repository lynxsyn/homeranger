import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  DefaultOutreachService,
  OutreachError,
  getOutreachConfig,
  getOutreachService,
  makeDefaultSearchDraftLoader,
  _setOutreachServiceForTesting,
} from "./outreach.service.js";
import type {
  SearchRecord,
  SearchRepository,
} from "../repositories/search.repository.js";
import type { SearchProfileRepository } from "../repositories/search-profile.repository.js";
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
    emailConfig: { from: "HomeRanger <hi@homeranger.test>" },
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
    expect(sendArg.from).toBe("HomeRanger <hi@homeranger.test>");
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
        // The rendered HTML is persisted too (not just bodyText) so a draft can
        // be inspected from the DB without reading the mailbox.
        bodyHtml: expect.stringContaining("<p>"),
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

  it("SEARCH BRANCH: a searchId substitutes the search-tailored subject + body (with the unsubscribe footer)", async () => {
    const h = makeHarness();
    const searchDraft = vi.fn().mockResolvedValue({
      subject: "A private buyer looking in Conwy County",
      bodyText: "Hello,\n\nI'm a private buyer searching in Conwy County.",
    });
    const service = new DefaultOutreachService({
      emailProvider: { send: h.send } as unknown as EmailProvider,
      complianceGuard: {
        assertCanSend: h.assertCanSend,
      } as unknown as ComplianceGuard,
      agentRepository: {
        getById: h.getById,
        markContacted: h.markContacted,
      } as unknown as AgentRepository,
      outreachRepository: {
        findOrCreateOpenThreadByAgent: h.findOrCreateOpenThreadByAgent,
        getThreadById: h.getThreadById,
        createOutboundMessage: h.createOutboundMessage,
        applyThreadEvent: h.applyThreadEvent,
      } as unknown as OutreachRepository,
      emailConfig: { from: "HomeRanger <hi@homeranger.test>" },
      config: {
        unsubscribeBaseUrl: "https://app.test/api/outreach/unsubscribe",
        followupCadenceHours: 72,
      },
      searchDraft,
      signToken: () => "unsub-token",
      now: () => new Date("2026-06-02T12:00:00Z"),
    });

    await service.sendOutreach({ agentId: "agent-1", searchId: "search-7" });

    // The loader was consulted with the searchId.
    expect(searchDraft).toHaveBeenCalledWith("search-7");
    const sendArg = h.send.mock.calls[0]![0] as SendEmailInput;
    expect(sendArg.subject).toBe("A private buyer looking in Conwy County");
    // The search brief body is present...
    expect(sendArg.bodyText).toContain("I'm a private buyer searching in Conwy County");
    // ...and the one-click unsubscribe footer is re-appended.
    expect(sendArg.bodyText).toContain("unsubscribe here:");
    expect(sendArg.bodyText).toContain("unsub-token");
    // ...with no em dash in the footer separator (AI tell).
    expect(sendArg.bodyText).not.toContain("—");
    expect(sendArg.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    // The persisted message carries the search subject too.
    expect(h.createOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "A private buyer looking in Conwy County",
      }),
    );
  });

  it("SEARCH FALLBACK: a searchId whose search is gone falls back to the generic draft (still guarded + sent)", async () => {
    const h = makeHarness();
    const searchDraft = vi.fn().mockResolvedValue(null);
    const service = new DefaultOutreachService({
      emailProvider: { send: h.send } as unknown as EmailProvider,
      complianceGuard: {
        assertCanSend: h.assertCanSend,
      } as unknown as ComplianceGuard,
      agentRepository: {
        getById: h.getById,
        markContacted: h.markContacted,
      } as unknown as AgentRepository,
      outreachRepository: {
        findOrCreateOpenThreadByAgent: h.findOrCreateOpenThreadByAgent,
        getThreadById: h.getThreadById,
        createOutboundMessage: h.createOutboundMessage,
        applyThreadEvent: h.applyThreadEvent,
      } as unknown as OutreachRepository,
      emailConfig: { from: "HomeRanger <hi@homeranger.test>" },
      config: {
        unsubscribeBaseUrl: "https://app.test/api/outreach/unsubscribe",
        followupCadenceHours: 72,
      },
      searchDraft,
      signToken: () => "unsub-token",
      now: () => new Date("2026-06-02T12:00:00Z"),
    });

    await service.sendOutreach({ agentId: "agent-1", searchId: "ghost" });
    expect(searchDraft).toHaveBeenCalledWith("ghost");
    const sendArg = h.send.mock.calls[0]![0] as SendEmailInput;
    // Generic subject (the draftOutreach default), not the search line.
    expect(sendArg.subject).toBe(
      "Buyer enquiry: pre-market and upcoming listings",
    );
  });

  it("search draft is loaded AFTER the guard (a blocked send never touches the search)", async () => {
    const h = makeHarness();
    h.assertCanSend.mockRejectedValue(
      new ComplianceError("KILL_SWITCH", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      }),
    );
    const searchDraft = vi.fn().mockResolvedValue({
      subject: "x",
      bodyText: "y",
    });
    const service = new DefaultOutreachService({
      emailProvider: { send: h.send } as unknown as EmailProvider,
      complianceGuard: {
        assertCanSend: h.assertCanSend,
      } as unknown as ComplianceGuard,
      agentRepository: {
        getById: h.getById,
        markContacted: h.markContacted,
      } as unknown as AgentRepository,
      outreachRepository: {} as unknown as OutreachRepository,
      emailConfig: { from: "HomeRanger <hi@homeranger.test>" },
      config: {
        unsubscribeBaseUrl: "https://app.test/api/outreach/unsubscribe",
        followupCadenceHours: 72,
      },
      searchDraft,
      signToken: () => "unsub-token",
      now: () => new Date("2026-06-02T12:00:00Z"),
    });

    await expect(
      service.sendOutreach({ agentId: "agent-1", searchId: "search-7" }),
    ).rejects.toBeInstanceOf(ComplianceError);
    expect(searchDraft).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("OutreachService.sendFollowup", () => {
  it("sends on the existing thread with a per-thread idempotency key (no new thread)", async () => {
    const h = makeHarness();
    const result = await h.service.sendFollowup({ threadId: "thread-1" });

    expect(h.findOrCreateOpenThreadByAgent).not.toHaveBeenCalled();
    const sendArg = h.send.mock.calls[0]![0] as SendEmailInput;
    // Per (thread, UTC-day) so repeat follow-ups on different days each send.
    expect(sendArg.idempotencyKey).toBe("outreach:followup:thread-1:2026-06-02");
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

describe("makeDefaultSearchDraftLoader", () => {
  function searchRecord(overrides: Partial<SearchRecord> = {}): SearchRecord {
    return {
      id: "search-7",
      name: "Conwy coast",
      location: "Conwy County",
      outcodes: ["LL30"],
      types: ["Cottage"],
      condition: [],
      land: [],
      saleMethods: ["Private treaty"],
      minBedrooms: 3,
      maxPricePence: null,
      keywords: "",
      status: "active",
      createdAt: new Date("2026-06-01"),
      updatedAt: new Date("2026-06-01"),
      ...overrides,
    } as SearchRecord;
  }

  // A fake profile repo so the loader never touches the DB. `overrides` shape
  // the buyer identity woven into the sign-off + urgency.
  function profileRepo(
    overrides: Partial<{
      firstName: string;
      lastName: string;
      phone: string;
      urgency: string;
    }> = {},
  ): SearchProfileRepository {
    return {
      getOrCreate: vi.fn().mockResolvedValue({
        firstName: "",
        lastName: "",
        phone: "",
        urgency: "active",
        ...overrides,
      }),
    } as unknown as SearchProfileRepository;
  }

  it("builds a location-named subject + a draftSearchEmail body", async () => {
    const getById = vi.fn().mockResolvedValue(searchRecord());
    const load = makeDefaultSearchDraftLoader(
      { getById } as unknown as SearchRepository,
      profileRepo(),
    );
    const draft = await load("search-7");
    // The outreach loop reads the operator namespace (null owner key).
    expect(getById).toHaveBeenCalledWith("search-7", null);
    expect(draft?.subject).toBe("A private buyer looking in Conwy County");
    expect(draft?.bodyText).toContain(
      "I'm a private buyer searching in Conwy County",
    );
  });

  it("signs + paces the body from the buyer profile", async () => {
    const load = makeDefaultSearchDraftLoader(
      { getById: vi.fn().mockResolvedValue(searchRecord()) } as unknown as SearchRepository,
      profileRepo({
        firstName: "Jane",
        lastName: "Whitfield",
        phone: "07700 900123",
        urgency: "ready",
      }),
    );
    const draft = await load("search-7");
    expect(draft?.bodyText).toContain(
      "Many thanks,\nJane Whitfield\n07700 900123",
    );
    expect(draft?.bodyText).toContain("I'm in a strong position to proceed");
  });

  it("falls back to a generic subject for a blank location", async () => {
    const load = makeDefaultSearchDraftLoader(
      {
        getById: vi.fn().mockResolvedValue(searchRecord({ location: "" })),
      } as unknown as SearchRepository,
      profileRepo(),
    );
    const draft = await load("search-7");
    expect(draft?.subject).toBe("A private buyer looking in your area");
  });

  it("returns null when the search is gone", async () => {
    const load = makeDefaultSearchDraftLoader(
      {
        getById: vi.fn().mockResolvedValue(null),
      } as unknown as SearchRepository,
      profileRepo(),
    );
    expect(await load("ghost")).toBeNull();
  });
});

describe("getOutreachConfig", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("defaults the follow-up cadence to 72h", () => {
    expect(getOutreachConfig().followupCadenceHours).toBe(72);
  });
  it("defaults the unsubscribe base URL to the apex (homeranger.app, no app. subdomain)", () => {
    // The app moved onto the apex; the one-click unsubscribe path is
    // Access-bypassed there so mail clients reach it without the login wall.
    vi.stubEnv("UNSUBSCRIBE_BASE_URL", "");
    expect(getOutreachConfig().unsubscribeBaseUrl).toBe(
      "https://homeranger.app/api/outreach/unsubscribe",
    );
  });
  it("honours UNSUBSCRIBE_BASE_URL when set, overriding the apex default", () => {
    vi.stubEnv(
      "UNSUBSCRIBE_BASE_URL",
      "https://staging.example/api/outreach/unsubscribe",
    );
    expect(getOutreachConfig().unsubscribeBaseUrl).toBe(
      "https://staging.example/api/outreach/unsubscribe",
    );
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
      emailConfig: { from: "HomeRanger <hi@homeranger.test>" },
    });
    expect(getOutreachService()).toBe(first);
  });
});
