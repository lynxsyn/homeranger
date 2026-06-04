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
import { isAuthenticatedSender } from "../lib/inbound/email-authentication.js";
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
  /**
   * Compliance-critical opt-out (AC#5 backup). If the inbound reply is a
   * STOP/unsubscribe, write SuppressionEntry(unsubscribe) + Agent.optedOut.
   * MUST be called on the NON-swallowed path (a dropped opt-out would let a
   * later follow-up send to someone who replied STOP). Idempotent + email-keyed
   * (no thread/agent dependency), so a transient failure retries cleanly.
   */
  handleOptOut(payload: InboundEmailPayload): Promise<void>;
  /** Best-effort thread linking (persist inbound message + advance status). */
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

  async handleOptOut(payload: InboundEmailPayload): Promise<void> {
    if (!isUnsubscribeIntent(payload.bodyText)) {
      return;
    }
    if (!isAuthenticatedSender(payload.spfVerdict, payload.dkimVerdict)) {
      // The `From` is spoofable. We STILL honour the opt-out — dropping a real
      // STOP is a PECR/GDPR violation and over-suppression is harmless — but an
      // unauthenticated STOP is a denial-of-outreach sabotage signal, so flag it
      // for operator visibility (no PII: no email/body in the log).
      console.warn(
        JSON.stringify({
          type: "warn",
          scope: "outreach.reply.optout_unauthenticated",
          spf: payload.spfVerdict,
          dkim: payload.dkimVerdict,
        }),
      );
    }
    // Email-keyed + idempotent — works even if the sender is not (yet) a tracked
    // agent. The guard gates on the PERSISTED suppression/opt-out at every send.
    await this.suppressionEntryRepository.suppress({
      email: payload.senderEmail,
      reason: "unsubscribe",
      note: "inbound STOP/unsubscribe reply",
    });
    await this.agentRepository.markOptedOut(payload.senderEmail);
    // No PII in the log — the opt-out is keyed by email but never logged.
    console.info(
      JSON.stringify({ type: "info", scope: "outreach.reply.unsubscribed" }),
    );
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
    if (!isAuthenticatedSender(payload.spfVerdict, payload.dkimVerdict)) {
      // A tracked agent's address arriving on mail that fails BOTH SPF and DKIM
      // is a likely spoof. Do NOT forge thread state (advance to replied / attach
      // a fabricated inbound reply) for a real agent on spoofable mail. The
      // listing already ingested upstream as generic inbound; we just refuse to
      // attribute a "reply" we cannot trust. Logged for operator visibility.
      console.warn(
        JSON.stringify({
          type: "warn",
          scope: "outreach.reply.unauthenticated",
          agentId: agent.id,
          spf: payload.spfVerdict,
          dkim: payload.dkimVerdict,
        }),
      );
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

    // If this reply was a STOP/unsubscribe, close the thread (COSMETIC — the
    // durable suppression + opt-out already happened in handleOptOut on the
    // non-swallowed path; the guard blocks future sends regardless of thread
    // status, so a swallowed close here is harmless).
    if (isUnsubscribeIntent(payload.bodyText)) {
      await this.outreachRepository.closeThreadsByAgent(agent.id);
      console.info(
        JSON.stringify({
          type: "info",
          scope: "outreach.reply.closed",
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
