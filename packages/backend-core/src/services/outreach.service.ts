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
  scoutRepository as defaultScoutRepository,
  type ScoutRepository,
} from "../repositories/scout.repository.js";
import {
  searchProfileRepository as defaultSearchProfileRepository,
  type SearchProfileRepository,
} from "../repositories/search-profile.repository.js";
import {
  getOutreachEmailConfig,
  currentSenderName,
  type EmailProvider,
  type OutreachEmailConfig,
} from "../lib/email/email-provider.js";
import { draftOutreach, type OutreachDraft } from "../lib/outreach/draft.js";
import { draftScoutEmail } from "../lib/scouts/scout-brief.js";
import { resolveSender } from "@homeranger/shared";
import { signUnsubscribeToken } from "../lib/outreach/unsubscribe-token.js";

/**
 * A scout-tailored draft (subject + body) the send path substitutes for the
 * generic draft when an `outreach:send` job carries a `scoutId`. Body comes from
 * the EXISTING draftScoutEmail(scout); subject names the scout's location.
 */
export interface ScoutDraft {
  subject: string;
  bodyText: string;
}

/** Loads a scout-tailored draft for a scoutId, or null if the scout is gone. */
export type ScoutDraftLoader = (scoutId: string) => Promise<ScoutDraft | null>;

/**
 * Default scout-draft loader: read the scout via the repository and weave its
 * brief into the body via the existing pure `draftScoutEmail`. Subject names the
 * scout's location (falling back to a generic line for a blank location).
 */
export function makeDefaultScoutDraftLoader(
  scoutRepository: ScoutRepository,
  searchProfileRepository: SearchProfileRepository = defaultSearchProfileRepository,
): ScoutDraftLoader {
  return async (scoutId: string): Promise<ScoutDraft | null> => {
    // The outreach loop is operator-driven (operator namespace = null owner).
    const scout = await scoutRepository.getById(scoutId, null);
    if (!scout) {
      return null;
    }
    // Resolve the buyer's identity (Settings "Your details") so the sent email
    // is signed + paced personally; the RESEND_FROM display name is the
    // fallback sign-off name when the profile has no name yet.
    const profile = await searchProfileRepository.getOrCreate();
    const sender = resolveSender(profile, currentSenderName());
    const location = scout.location.trim();
    return {
      subject: location
        ? `A private buyer looking in ${location}`
        : "A private buyer looking in your area",
      bodyText: draftScoutEmail(scout, sender),
    };
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Render a scout-tailored draft into the {subject, bodyText, bodyHtml} the
 * provider sends, re-appending the SAME RFC 8058 one-click unsubscribe footer
 * draftOutreach uses so a scout send stays one-click-unsubscribable. bodyHtml is
 * a paragraph-per-line port of the plain text (the body is trusted, structured
 * scout-brief output — escaped defensively).
 */
function renderScoutDraft(
  scoutDraft: ScoutDraft,
  unsubscribeUrl: string,
): OutreachDraft {
  const bodyText = [
    scoutDraft.bodyText,
    "",
    "—",
    `To stop receiving these emails, unsubscribe here: ${unsubscribeUrl}`,
  ].join("\n");
  const htmlBody = scoutDraft.bodyText
    .split("\n")
    .map((line) => (line === "" ? "<br/>" : `<p>${escapeHtml(line)}</p>`))
    .join("");
  const bodyHtml = `${htmlBody}<hr/><p style="font-size:12px;color:#888">To stop receiving these emails, <a href="${escapeHtml(
    unsubscribeUrl,
  )}">unsubscribe here</a>.</p>`;
  return { subject: scoutDraft.subject, bodyText, bodyHtml };
}

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
  /**
   * Cold-contact an agent (initial send). Throws ComplianceError if blocked.
   * `scoutId` (PR3, optional): when present the email body is drafted from that
   * scout's brief (draftScoutEmail) instead of the generic first-contact draft.
   */
  sendOutreach(input: {
    agentId: string;
    scoutId?: string;
  }): Promise<SendOutreachResult>;
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
    "https://app.homeranger.app/api/outreach/unsubscribe";
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
  scoutRepository?: ScoutRepository;
  emailConfig?: OutreachEmailConfig;
  config?: OutreachConfig;
  draft?: (input: Parameters<typeof draftOutreach>[0]) => OutreachDraft;
  /** Loads a scout-tailored draft for an `outreach:send` carrying a scoutId. */
  scoutDraft?: ScoutDraftLoader;
  signToken?: (email: string) => string;
  now?: () => Date;
}

export class DefaultOutreachService implements OutreachService {
  private readonly emailProvider: EmailProvider;
  private readonly complianceGuard: ComplianceGuard;
  private readonly agentRepository: AgentRepository;
  private readonly outreachRepository: OutreachRepository;
  private readonly emailConfigOverride?: OutreachEmailConfig;
  private readonly config: OutreachConfig;
  private readonly draft: (
    input: Parameters<typeof draftOutreach>[0],
  ) => OutreachDraft;
  private readonly scoutDraft: ScoutDraftLoader;
  private readonly signToken: (email: string) => string;
  private readonly now: () => Date;

  constructor(deps: OutreachDependencies) {
    this.emailProvider = deps.emailProvider;
    this.complianceGuard = deps.complianceGuard ?? defaultComplianceGuard;
    this.agentRepository = deps.agentRepository ?? defaultAgentRepository;
    this.outreachRepository =
      deps.outreachRepository ?? defaultOutreachRepository;
    // Resolved LAZILY per-send (resolveEmailConfig), NOT at construction — so a
    // missing RESEND_FROM fails an individual send (retryable job error), it does
    // NOT crash the worker boot and take down the inbound/analyze/recompute queues.
    this.emailConfigOverride = deps.emailConfig;
    this.config = deps.config ?? getOutreachConfig();
    this.draft = deps.draft ?? draftOutreach;
    // Default loader reads the scout via the (default or injected) repository and
    // weaves its brief into the body via the pure draftScoutEmail.
    this.scoutDraft =
      deps.scoutDraft ??
      makeDefaultScoutDraftLoader(
        deps.scoutRepository ?? defaultScoutRepository,
      );
    this.signToken = deps.signToken ?? ((email) => signUnsubscribeToken(email));
    this.now = deps.now ?? (() => new Date());
  }

  /** Resolve the sending config lazily so a missing RESEND_FROM only fails a
   *  send (not worker boot). Injected config (tests) bypasses the env read. */
  private resolveEmailConfig(): OutreachEmailConfig {
    return this.emailConfigOverride ?? getOutreachEmailConfig();
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
    scoutId,
  }: {
    agentId: string;
    scoutId?: string;
  }): Promise<SendOutreachResult> {
    const agent = await this.agentRepository.getById(agentId);
    if (!agent) {
      throw new OutreachError(`Agent ${agentId} not found`, false);
    }
    // Authoritative guard (consumes a warm-up token). Lets ComplianceError
    // propagate so the worker maps retryable→retry, non-retryable→drop. The guard
    // runs BEFORE any scout-draft load, so a blocked send never touches the scout.
    await this.complianceGuard.assertCanSend(this.guardAgent(agent), {
      reserve: true,
    });
    // When the job carries a scoutId, weave that scout's brief into the body
    // (the subject/body the operator reviewed). A missing scout falls back to the
    // generic draft — the send is still guarded + compliant, just not tailored.
    const scoutDraft = scoutId ? await this.scoutDraft(scoutId) : null;
    // Stable key forwarded as the provider Idempotency-Key — a BullMQ retry
    // re-sends the SAME key (provider returns the original id, persist is
    // idempotent). Scope it to (scout, agent) for a scout send so it can't
    // collide with a generic send to the same agent and deliver the wrong body.
    const dispatchKey = scoutId
      ? `outreach:send:scout:${scoutId}:${agent.id}`
      : `outreach:send:${agent.id}`;
    return this.dispatch(agent, dispatchKey, undefined, scoutDraft);
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
    // Per (thread, UTC-day) — a retry within the day reuses the key (Resend
    // dedupes, no double email); a later cadence window sends a fresh follow-up.
    const dayKey = this.now().toISOString().slice(0, 10);
    return this.dispatch(
      agent,
      `outreach:followup:${thread.id}:${dayKey}`,
      thread,
    );
  }

  private async dispatch(
    agent: AgentRecord,
    idempotencyKey: string,
    thread?: { id: string },
    scoutDraft?: ScoutDraft | null,
  ): Promise<SendOutreachResult> {
    const now = this.now();
    const emailConfig = this.resolveEmailConfig();
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
    // Generic first-contact draft (carries the RFC 8058 one-click footer).
    const genericDraft = this.draft({
      agencyName: agent.agencyName,
      coveredOutcodes: agent.coveredOutcodes,
      unsubscribeUrl,
    });
    // A scout-launched send substitutes the operator-reviewed scout subject/body,
    // re-appending the SAME unsubscribe footer so the one-click contract holds.
    const draft = scoutDraft
      ? renderScoutDraft(scoutDraft, unsubscribeUrl)
      : genericDraft;

    // Send FIRST (with the idempotency key), then persist. A crash between the
    // two is retry-safe: the same key returns the same provider id, and the
    // OutreachMessage @@unique(providerMessageId) makes the persist idempotent.
    const sent = await this.emailProvider.send({
      to: agent.email,
      from: emailConfig.from,
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
      fromEmail: emailConfig.from,
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
