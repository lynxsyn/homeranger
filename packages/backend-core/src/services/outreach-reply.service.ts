/**
 * OutreachReplyService (M6 AC#4) — links an inbound agent reply (the M4 path)
 * back to its OutreachThread. After the InboundIngestionService produces a
 * Listing, this persists an inbound OutreachMessage carrying
 * parsedListingIds:[listingId] and advances the thread status (awaiting_reply →
 * replied) via the guarded reducer. Idempotent: createInboundMessageOrIgnore
 * dedupes on providerMessageId, so a redelivered webhook is a no-op.
 *
 * If the sender is not a tracked Agent, this is a no-op (a generic inbound
 * listing email, not a reply to our outreach). Variant-A module singleton.
 */
import {
  agentRepository as defaultAgentRepository,
  type AgentRepository,
} from "../repositories/agent.repository.js";
import {
  outreachRepository as defaultOutreachRepository,
  type OutreachRepository,
} from "../repositories/outreach.repository.js";
import type {
  InboundEmailPayload,
  IngestInboundEmailResult,
} from "./inbound-ingestion.service.js";

export interface OutreachReplyService {
  linkReply(
    payload: InboundEmailPayload,
    result: IngestInboundEmailResult,
  ): Promise<void>;
}

export interface OutreachReplyDependencies {
  agentRepository?: AgentRepository;
  outreachRepository?: OutreachRepository;
}

export class DefaultOutreachReplyService implements OutreachReplyService {
  private readonly agentRepository: AgentRepository;
  private readonly outreachRepository: OutreachRepository;

  constructor(deps: OutreachReplyDependencies = {}) {
    this.agentRepository = deps.agentRepository ?? defaultAgentRepository;
    this.outreachRepository =
      deps.outreachRepository ?? defaultOutreachRepository;
  }

  async linkReply(
    payload: InboundEmailPayload,
    result: IngestInboundEmailResult,
  ): Promise<void> {
    const agent = await this.agentRepository.findByEmail(payload.senderEmail);
    if (!agent) {
      // Not a reply to our outreach — a generic inbound listing email.
      return;
    }
    const thread = await this.outreachRepository.findOrCreateOpenThreadByAgent({
      agentId: agent.id,
      subject: payload.subject ?? "Re: buyer enquiry",
    });
    await this.outreachRepository.createInboundMessageOrIgnore({
      threadId: thread.id,
      providerMessageId: payload.messageId,
      fromEmail: payload.senderEmail,
      toEmail: payload.recipientEmail,
      subject: payload.subject,
      bodyText: payload.bodyText,
      spfVerdict: payload.spfVerdict,
      dkimVerdict: payload.dkimVerdict,
      parsedListingIds: [result.listingId],
      receivedAt: payload.receivedAt,
    });
    await this.outreachRepository.applyThreadEvent({
      threadId: thread.id,
      event: "inbound_reply",
      at: payload.receivedAt,
    });
    console.info(
      JSON.stringify({
        type: "info",
        scope: "outreach.reply.linked",
        agentId: agent.id,
        threadId: thread.id,
      }),
    );
  }
}

const defaultOutreachReplyService = new DefaultOutreachReplyService();

export let outreachReplyService: OutreachReplyService =
  defaultOutreachReplyService;

export function _setOutreachReplyServiceForTesting(
  service: OutreachReplyService | null,
): void {
  outreachReplyService = service ?? defaultOutreachReplyService;
}
