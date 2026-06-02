/**
 * OutreachService — the ONLY path that issues an outbound send (M6 AC#2):
 *   resolve agent → ComplianceGuard.assertCanSend(reserve:true) → draft →
 *   EmailProvider.send (with a deterministic Idempotency-Key) → persist
 *   OutreachThread/OutreachMessage → advance thread status → markContacted.
 *
 * TRANSPORT-FREE worker service (no @trpc/server). It lets ComplianceError
 * propagate so the worker handler maps retryable→BullMQ-retry and
 * non-retryable→UnrecoverableError, and the router precheck maps trpcCode→
 * TRPCError. Its own failures throw a typed `OutreachError { retryable }`
 * (mirrors InboundIngestionError / ListingAnalysisError).
 *
 * DI: Variant B lazy singleton (getOutreachService(deps) at worker boot) — the
 * EmailProvider is a required injected network client with no import-time
 * default; repos/guard/config/clock are optional `?? default` seams.
 */
import type { OutreachThreadStatus } from "@prisma/client";
import {
  complianceGuard as defaultComplianceGuard,
  type AgentForGuard,
  type ComplianceGuard,
} from "../lib/compliance/compliance-guard.js";
import { outreachSentTotal } from "../lib/compliance/compliance-metrics.js";
import {
  agentRepository as defaultAgentRepository,
  type AgentRecord,
  type AgentRepository,
} from "../repositories/agent.repository.js";
import {
  outreachRepository as defaultOutreachRepository,
  type OutreachRepository,
} from "../repositories/outreach.repository.js";
import {
  getOutreachEmailConfig,
  type EmailProvider,
  type OutreachEmailConfig,
} from "../lib/email/email-provider.js";
import { draftOutreach, type OutreachDraft } from "../lib/outreach/draft.js";
import { signUnsubscribeToken } from "../lib/outreach/unsubscribe-token.js";

/** Typed, transport-free service error. `retryable` drives the worker's retry. */
export class OutreachError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "OutreachError";
    this.retryable = retryable;
  }
}

export interface SendOutreachResult {
  threadId: string;
  messageId: string;
  providerMessageId: string;
  status: OutreachThreadStatus;
}

export interface OutreachService {
  /** Cold-contact an agent (initial send). Throws ComplianceError if blocked. */
  sendOutreach(input: { agentId: string }): Promise<SendOutreachResult>;
  /** Send a follow-up on an existing awaiting_reply thread. */
  sendFollowup(input: { threadId: string }): Promise<SendOutreachResult>;
}

export interface OutreachConfig {
  /** Base URL the RFC 8058 one-click unsubscribe link points at. */
  unsubscribeBaseUrl: string;
  /** Hours of silence before a follow-up is due. */
  followupCadenceHours: number;
}

export function getOutreachConfig(): OutreachConfig {
  const unsubscribeBaseUrl =
    process.env.UNSUBSCRIBE_BASE_URL?.trim() ||
    "https://app.aid-engineering.com/api/outreach/unsubscribe";
  const followupCadenceHours = Number.parseInt(
    process.env.OUTREACH_FOLLOWUP_HOURS ?? "72",
    10,
  );
  return {
    unsubscribeBaseUrl,
    followupCadenceHours: Number.isFinite(followupCadenceHours)
      ? followupCadenceHours
      : 72,
  };
}

export interface OutreachDependencies {
  emailProvider: EmailProvider;
  complianceGuard?: ComplianceGuard;
  agentRepository?: AgentRepository;
  outreachRepository?: OutreachRepository;
  emailConfig?: OutreachEmailConfig;
  config?: OutreachConfig;
  draft?: (input: Parameters<typeof draftOutreach>[0]) => OutreachDraft;
  signToken?: (email: string) => string;
  now?: () => Date;
}

export class DefaultOutreachService implements OutreachService {
  private readonly emailProvider: EmailProvider;
  private readonly complianceGuard: ComplianceGuard;
  private readonly agentRepository: AgentRepository;
  private readonly outreachRepository: OutreachRepository;
  private readonly emailConfig: OutreachEmailConfig;
  private readonly config: OutreachConfig;
  private readonly draft: (
    input: Parameters<typeof draftOutreach>[0],
  ) => OutreachDraft;
  private readonly signToken: (email: string) => string;
  private readonly now: () => Date;

  constructor(deps: OutreachDependencies) {
    this.emailProvider = deps.emailProvider;
    this.complianceGuard = deps.complianceGuard ?? defaultComplianceGuard;
    this.agentRepository = deps.agentRepository ?? defaultAgentRepository;
    this.outreachRepository =
      deps.outreachRepository ?? defaultOutreachRepository;
    this.emailConfig = deps.emailConfig ?? getOutreachEmailConfig();
    this.config = deps.config ?? getOutreachConfig();
    this.draft = deps.draft ?? draftOutreach;
    this.signToken = deps.signToken ?? ((email) => signUnsubscribeToken(email));
    this.now = deps.now ?? (() => new Date());
  }

  private guardAgent(agent: AgentRecord): AgentForGuard {
    return {
      id: agent.id,
      email: agent.email,
      mailboxType: agent.mailboxType,
      optedOut: agent.optedOut,
    };
  }

  async sendOutreach({
    agentId,
  }: {
    agentId: string;
  }): Promise<SendOutreachResult> {
    const agent = await this.agentRepository.getById(agentId);
    if (!agent) {
      throw new OutreachError(`Agent ${agentId} not found`, false);
    }
    // Authoritative guard (consumes a warm-up token). Lets ComplianceError
    // propagate so the worker maps retryable→retry, non-retryable→drop.
    await this.complianceGuard.assertCanSend(this.guardAgent(agent), {
      reserve: true,
    });
    // Stable per-agent key — a BullMQ retry forwards the SAME Idempotency-Key,
    // so the provider returns the original id and the persist is idempotent.
    return this.dispatch(agent, `outreach:send:${agent.id}`);
  }

  async sendFollowup({
    threadId,
  }: {
    threadId: string;
  }): Promise<SendOutreachResult> {
    const thread = await this.outreachRepository.getThreadById(threadId);
    if (!thread) {
      throw new OutreachError(`OutreachThread ${threadId} not found`, false);
    }
    const agent = await this.agentRepository.getById(thread.agentId);
    if (!agent) {
      throw new OutreachError(`Agent ${thread.agentId} not found`, false);
    }
    await this.complianceGuard.assertCanSend(this.guardAgent(agent), {
      reserve: true,
    });
    return this.dispatch(agent, `outreach:followup:${thread.id}`, thread);
  }

  private async dispatch(
    agent: AgentRecord,
    idempotencyKey: string,
    thread?: { id: string },
  ): Promise<SendOutreachResult> {
    const now = this.now();
    const resolvedThread =
      thread ??
      (await this.outreachRepository.findOrCreateOpenThreadByAgent({
        agentId: agent.id,
        subject: "Buyer enquiry — pre-market & upcoming listings",
      }));

    const token = this.signToken(agent.email);
    const unsubscribeUrl = `${this.config.unsubscribeBaseUrl}?email=${encodeURIComponent(
      agent.email,
    )}&token=${token}`;
    const draft = this.draft({
      agencyName: agent.agencyName,
      coveredOutcodes: agent.coveredOutcodes,
      unsubscribeUrl,
    });

    // Send FIRST (with the idempotency key), then persist. A crash between the
    // two is retry-safe: the same key returns the same provider id, and the
    // OutreachMessage @@unique(providerMessageId) makes the persist idempotent.
    const sent = await this.emailProvider.send({
      to: agent.email,
      from: this.emailConfig.from,
      subject: draft.subject,
      bodyText: draft.bodyText,
      bodyHtml: draft.bodyHtml,
      idempotencyKey,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    const message = await this.outreachRepository.createOutboundMessage({
      threadId: resolvedThread.id,
      providerMessageId: sent.providerMessageId,
      fromEmail: this.emailConfig.from,
      toEmail: agent.email,
      subject: draft.subject,
      bodyText: draft.bodyText,
      sentAt: now,
    });
    const status = await this.outreachRepository.applyThreadEvent({
      threadId: resolvedThread.id,
      event: "outbound_sent",
      at: now,
    });
    await this.agentRepository.markContacted(agent.id, now);
    outreachSentTotal.inc();
    console.info(
      JSON.stringify({
        type: "info",
        scope: "outreach.sent",
        agentId: agent.id,
        threadId: resolvedThread.id,
      }),
    );

    return {
      threadId: resolvedThread.id,
      messageId: message.id,
      providerMessageId: sent.providerMessageId,
      status,
    };
  }
}

let singleton: OutreachService | null = null;

export function getOutreachService(
  deps?: OutreachDependencies,
): OutreachService {
  if (deps) {
    singleton = new DefaultOutreachService(deps);
    return singleton;
  }
  if (!singleton) {
    throw new Error(
      "OutreachService not initialised — call getOutreachService(deps) at worker boot",
    );
  }
  return singleton;
}

export function _setOutreachServiceForTesting(
  service: OutreachService | null,
): void {
  singleton = service;
}
