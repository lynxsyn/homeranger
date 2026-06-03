import { describe, expect, it, vi } from "vitest";
import {
  DefaultOutreachReplyService,
  isUnsubscribeIntent,
} from "./outreach-reply.service.js";
import type {
  InboundEmailPayload,
  IngestInboundEmailResult,
} from "./inbound-ingestion.service.js";
import type { AgentRepository } from "../repositories/agent.repository.js";
import type { OutreachRepository } from "../repositories/outreach.repository.js";
import type { SuppressionEntryRepository } from "../repositories/suppression-entry.repository.js";

const PAYLOAD: InboundEmailPayload = {
  messageId: "resend-inbound-1",
  receivedAt: new Date("2026-06-02T09:00:00Z"),
  recipientEmail: "inbox@homeranger.app",
  senderEmail: "branch@agency.test",
  senderName: "Branch",
  subject: "Re: buyer enquiry",
  bodyText: "We have a pre-market listing",
  bodyHtml: null,
  spfVerdict: "pass",
  dkimVerdict: "pass",
  attachments: [],
};

const RESULT: IngestInboundEmailResult = {
  listingId: "listing-9",
  created: true,
  matchedBy: null,
  sourceRecordId: "sr-9",
};

function makeHarness(agentFound: boolean) {
  const findByEmail = vi
    .fn()
    .mockResolvedValue(agentFound ? { id: "agent-1", email: PAYLOAD.senderEmail } : null);
  const markOptedOut = vi.fn().mockResolvedValue(undefined);
  const findOrCreateOpenThreadByAgent = vi
    .fn()
    .mockResolvedValue({ id: "thread-1", agentId: "agent-1", status: "awaiting_reply" });
  const createInboundMessageOrIgnore = vi
    .fn()
    .mockResolvedValue({ message: { id: "m1" }, created: true });
  const applyThreadEvent = vi.fn().mockResolvedValue("replied");
  const closeThreadsByAgent = vi.fn().mockResolvedValue(1);
  const suppress = vi.fn().mockResolvedValue({});

  const service = new DefaultOutreachReplyService({
    agentRepository: { findByEmail, markOptedOut } as unknown as AgentRepository,
    outreachRepository: {
      findOrCreateOpenThreadByAgent,
      createInboundMessageOrIgnore,
      applyThreadEvent,
      closeThreadsByAgent,
    } as unknown as OutreachRepository,
    suppressionEntryRepository: {
      suppress,
    } as unknown as SuppressionEntryRepository,
  });
  return {
    service,
    findOrCreateOpenThreadByAgent,
    createInboundMessageOrIgnore,
    applyThreadEvent,
    markOptedOut,
    closeThreadsByAgent,
    suppress,
  };
}

describe("OutreachReplyService.linkReply", () => {
  it("links a known agent's reply: inbound message with parsedListingIds + status → replied", async () => {
    const h = makeHarness(true);
    await h.service.linkReply(PAYLOAD, RESULT);
    expect(h.createInboundMessageOrIgnore).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        providerMessageId: "resend-inbound-1",
        parsedListingIds: ["listing-9"],
        spfVerdict: "pass",
      }),
    );
    expect(h.applyThreadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1", event: "inbound_reply" }),
    );
  });

  it("is a no-op when the sender is not a tracked agent", async () => {
    const h = makeHarness(false);
    await h.service.linkReply(PAYLOAD, RESULT);
    expect(h.findOrCreateOpenThreadByAgent).not.toHaveBeenCalled();
    expect(h.createInboundMessageOrIgnore).not.toHaveBeenCalled();
  });

  it("linkReply does NOT suppress (suppression is handleOptOut's job)", async () => {
    const h = makeHarness(true);
    await h.service.linkReply(PAYLOAD, RESULT);
    expect(h.suppress).not.toHaveBeenCalled();
    expect(h.markOptedOut).not.toHaveBeenCalled();
  });

  it("linkReply closes the thread (cosmetic) when the reply is a STOP", async () => {
    const h = makeHarness(true);
    await h.service.linkReply(
      { ...PAYLOAD, bodyText: "Please unsubscribe me, thanks" },
      RESULT,
    );
    expect(h.closeThreadsByAgent).toHaveBeenCalledWith("agent-1");
    // The durable suppression is NOT linkReply's responsibility.
    expect(h.suppress).not.toHaveBeenCalled();
  });
});

describe("OutreachReplyService.handleOptOut (durable, non-swallowed)", () => {
  it("a STOP reply suppresses + opts out the sender (email-keyed, no thread dep)", async () => {
    const h = makeHarness(true);
    await h.service.handleOptOut({
      ...PAYLOAD,
      bodyText: "STOP",
    });
    expect(h.suppress).toHaveBeenCalledWith(
      expect.objectContaining({
        email: PAYLOAD.senderEmail,
        reason: "unsubscribe",
      }),
    );
    expect(h.markOptedOut).toHaveBeenCalledWith(PAYLOAD.senderEmail);
  });

  it("a normal reply is a no-op", async () => {
    const h = makeHarness(true);
    await h.service.handleOptOut(PAYLOAD);
    expect(h.suppress).not.toHaveBeenCalled();
    expect(h.markOptedOut).not.toHaveBeenCalled();
  });
});

describe("isUnsubscribeIntent", () => {
  it("matches clear opt-out signals", () => {
    expect(isUnsubscribeIntent("STOP")).toBe(true);
    expect(isUnsubscribeIntent("please unsubscribe me")).toBe(true);
    expect(isUnsubscribeIntent("I want to opt out")).toBe(true);
    expect(isUnsubscribeIntent("opt-out please")).toBe(true);
    expect(isUnsubscribeIntent("remove me from your list")).toBe(true);
  });

  it("does NOT match benign text or null", () => {
    expect(isUnsubscribeIntent("Do stop by anytime!")).toBe(false);
    expect(isUnsubscribeIntent("We have a listing for you")).toBe(false);
    expect(isUnsubscribeIntent(null)).toBe(false);
  });
});
