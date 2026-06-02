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
import {
  suppressionEntryRepository as defaultSuppressionEntryRepository,
  type SuppressionEntryRepository,
} from "../repositories/suppression-entry.repository.js";
import type {
  InboundEmailPayload,
  IngestInboundEmailResult,
} from "./inbound-ingestion.service.js";

/**
 * Conservative inbound opt-out detector (M6 AC#5 backup to the one-click link).
 * Matches a clear unsubscribe intent — a bare "stop", or "unsubscribe" /
 * "opt out" / "remove me" anywhere — while avoiding false positives like
 * "stop by anytime".
 */
export function isUnsubscribeIntent(bodyText: string | null): boolean {
  if (!bodyText) {
    return false;
  }
  const text = bodyText.trim().toLowerCase();
  if (text === "stop") {
    return true;
  }
  return (
    /\bunsubscribe\b/.test(text) ||
    /\bopt[- ]?out\b/.test(text) ||
    /\bremove me\b/.test(text)
  );
}

export interface OutreachReplyService {
  linkReply(
    payload: InboundEmailPayload,
    result: IngestInboundEmailResult,
  ): Promise<void>;
}

export interface OutreachReplyDependencies {
  agentRepository?: AgentRepository;
  outreachRepository?: OutreachRepository;
  suppressionEntryRepository?: SuppressionEntryRepository;
}

export class DefaultOutreachReplyService implements OutreachReplyService {
  private readonly agentRepository: AgentRepository;
  private readonly outreachRepository: OutreachRepository;
  private readonly suppressionEntryRepository: SuppressionEntryRepository;

  constructor(deps: OutreachReplyDependencies = {}) {
    this.agentRepository = deps.agentRepository ?? defaultAgentRepository;
    this.outreachRepository =
      deps.outreachRepository ?? defaultOutreachRepository;
    this.suppressionEntryRepository =
      deps.suppressionEntryRepository ?? defaultSuppressionEntryRepository;
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

    // Backup opt-out path (AC#5): an inbound "STOP"/unsubscribe reply suppresses
    // the sender + opts the agent out + closes their threads — same permanent
    // effect as the one-click link. Idempotent.
    if (isUnsubscribeIntent(payload.bodyText)) {
      await this.suppressionEntryRepository.suppress({
        email: payload.senderEmail,
        reason: "unsubscribe",
        note: "inbound STOP/unsubscribe reply",
      });
      await this.agentRepository.markOptedOut(payload.senderEmail);
      await this.outreachRepository.closeThreadsByAgent(agent.id);
      console.info(
        JSON.stringify({
          type: "info",
          scope: "outreach.reply.unsubscribed",
          agentId: agent.id,
          threadId: thread.id,
        }),
      );
      return;
    }

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
