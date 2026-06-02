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

  // Suppress unused-until-GREEN warnings; the body lands in the GREEN commit.
  private guardAgent(agent: AgentRecord): AgentForGuard {
    return {
      id: agent.id,
      email: agent.email,
      mailboxType: agent.mailboxType,
      optedOut: agent.optedOut,
    };
  }

  async sendOutreach(_input: { agentId: string }): Promise<SendOutreachResult> {
    void this.emailProvider;
    void this.complianceGuard;
    void this.agentRepository;
    void this.outreachRepository;
    void this.emailConfig;
    void this.config;
    void this.draft;
    void this.signToken;
    void this.now;
    void this.guardAgent;
    void outreachSentTotal;
    void getOutreachEmailConfig;
    throw new Error("M6 OutreachService.sendOutreach not implemented");
  }

  async sendFollowup(_input: { threadId: string }): Promise<SendOutreachResult> {
    throw new Error("M6 OutreachService.sendFollowup not implemented");
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
