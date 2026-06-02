import { describe, expect, it, vi } from "vitest";
import { DefaultOutreachReplyService } from "./outreach-reply.service.js";
import type {
  InboundEmailPayload,
  IngestInboundEmailResult,
} from "./inbound-ingestion.service.js";
import type { AgentRepository } from "../repositories/agent.repository.js";
import type { OutreachRepository } from "../repositories/outreach.repository.js";

const PAYLOAD: InboundEmailPayload = {
  messageId: "resend-inbound-1",
  receivedAt: new Date("2026-06-02T09:00:00Z"),
  recipientEmail: "inbox@homescout.app",
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
  const findOrCreateOpenThreadByAgent = vi
    .fn()
    .mockResolvedValue({ id: "thread-1", agentId: "agent-1", status: "awaiting_reply" });
  const createInboundMessageOrIgnore = vi
    .fn()
    .mockResolvedValue({ message: { id: "m1" }, created: true });
  const applyThreadEvent = vi.fn().mockResolvedValue("replied");

  const service = new DefaultOutreachReplyService({
    agentRepository: { findByEmail } as unknown as AgentRepository,
    outreachRepository: {
      findOrCreateOpenThreadByAgent,
      createInboundMessageOrIgnore,
      applyThreadEvent,
    } as unknown as OutreachRepository,
  });
  return { service, findOrCreateOpenThreadByAgent, createInboundMessageOrIgnore, applyThreadEvent };
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
});
