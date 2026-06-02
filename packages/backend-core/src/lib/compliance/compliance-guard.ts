/**
 * ComplianceGuard — the load-bearing gate every outbound send passes (M6 AC#1).
 *
 * TRANSPORT-FREE (worker-side rule, like email-event/inbound-ingestion/dedup/
 * listing-analysis services): it throws a typed `ComplianceError` carrying a
 * `retryable` flag (BullMQ retry vs UnrecoverableError) AND a `trpcCode` the
 * router maps to a TRPCError on the request path — so AC#1's "typed TRPCError"
 * contract is honoured at the transport boundary without a worker service ever
 * importing @trpc/server.
 *
 * Gates run IN ORDER, throwing on the FIRST failure (the legal/consent gates
 * come before the operational ones, and the warm-up token CONSUME is LAST so a
 * send blocked by an earlier gate never burns a token):
 *   1. PECR — mailboxType must be corporate_subscriber (individual/unknown ⇒ no
 *      lawful basis to send at all). 2. agent opt-out. 3. global suppression.
 *   4. circuit breaker (bounce/complaint rate over the rolling window).
 *   5. manual kill-switch. 6. warm-up daily cap (token bucket; fail-closed).
 *
 * `reserve`: the worker send path calls with reserve:true (CONSUMES a token,
 * authoritative); the router precheck calls with reserve:false (PEEKS, never
 * mutates) — it still evaluates gates 1-5 so a permanently-blocked agent gets a
 * FORBIDDEN, not a misleading retryable TOO_MANY_REQUESTS.
 *
 * Observability/PII rule: every block logs `{scope:"outreach.blocked.<code>",
 * agentId}` (uuid + code ONLY — never email/body/token) and increments
 * complianceBlockedTotal{reason:<code>}.
 */
import type { MailboxType } from "@prisma/client";
import {
  suppressionEntryRepository,
  type SuppressionEntryRepository,
} from "../../repositories/suppression-entry.repository.js";
import {
  warmupStateRepository,
  type WarmupStateRepository,
} from "../../repositories/warmup-state.repository.js";
import {
  emailEventRepository,
  type EmailEventRepository,
} from "../../repositories/email-event.repository.js";
import {
  outreachRepository,
  type OutreachRepository,
} from "../../repositories/outreach.repository.js";
import {
  consumeToken as defaultConsumeToken,
  type ConsumeTokenInput,
  type ConsumeTokenResult,
} from "../rate-limit/redis-token-bucket.js";
import { complianceBlockedTotal } from "./compliance-metrics.js";

export type ComplianceCode =
  | "PECR_NON_CORPORATE"
  | "OPTED_OUT"
  | "SUPPRESSED"
  | "CIRCUIT_OPEN"
  | "KILL_SWITCH"
  | "WARMUP_CAP_EXCEEDED"
  | "RATE_LIMIT_UNAVAILABLE";

/** tRPC error codes the router maps each block to (AC#1 transport contract). */
export type ComplianceTrpcCode =
  | "FORBIDDEN"
  | "TOO_MANY_REQUESTS"
  | "PRECONDITION_FAILED";

export interface ComplianceErrorOptions {
  retryable: boolean;
  trpcCode: ComplianceTrpcCode;
  retryAfterSeconds?: number;
  message?: string;
}

/** Typed, transport-free guard rejection. `retryable` drives BullMQ retry. */
export class ComplianceError extends Error {
  readonly code: ComplianceCode;
  readonly retryable: boolean;
  readonly trpcCode: ComplianceTrpcCode;
  readonly retryAfterSeconds?: number;

  constructor(code: ComplianceCode, options: ComplianceErrorOptions) {
    super(options.message ?? code);
    this.name = "ComplianceError";
    this.code = code;
    this.retryable = options.retryable;
    this.trpcCode = options.trpcCode;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

/** The minimal agent shape the guard needs (subset of AgentRecord). */
export interface AgentForGuard {
  id: string;
  email: string;
  mailboxType: MailboxType;
  optedOut: boolean;
}

export interface AssertCanSendOptions {
  /** true (worker) consumes a warm-up token; false (router precheck) peeks. */
  reserve?: boolean;
}

export interface ComplianceGuard {
  assertCanSend(
    agent: AgentForGuard,
    options?: AssertCanSendOptions,
  ): Promise<void>;
}

export interface ComplianceGuardConfig {
  /** Trip bounce gate above this fraction (default 0.02 = 2%). */
  bounceRate: number;
  /** Trip complaint gate above this fraction (default 0.001 = 0.1%). */
  complaintRate: number;
  /** Don't evaluate the bounce gate below this many sends in the window. */
  bounceMinSample: number;
  /** Don't evaluate the complaint gate below this many sends in the window. */
  complaintMinSample: number;
  /** Rolling window for the breaker, in hours (default 24). */
  windowHours: number;
  /** Warm-up token-bucket window, in seconds (default 86400 = 1 day). */
  warmupWindowSeconds: number;
}

function numEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getComplianceGuardConfig(): ComplianceGuardConfig {
  return {
    bounceRate: numEnv("BREAKER_BOUNCE_RATE", 0.02),
    complaintRate: numEnv("BREAKER_COMPLAINT_RATE", 0.001),
    bounceMinSample: intEnv("BREAKER_BOUNCE_MIN_SAMPLE", 50),
    complaintMinSample: intEnv("BREAKER_COMPLAINT_MIN_SAMPLE", 200),
    windowHours: numEnv("BREAKER_WINDOW_HOURS", 24),
    warmupWindowSeconds: intEnv("WARMUP_WINDOW_SECONDS", 86_400),
  };
}

export interface ComplianceGuardDependencies {
  suppressionEntryRepository?: SuppressionEntryRepository;
  warmupStateRepository?: WarmupStateRepository;
  emailEventRepository?: EmailEventRepository;
  outreachRepository?: OutreachRepository;
  consumeToken?: (input: ConsumeTokenInput) => Promise<ConsumeTokenResult>;
  config?: ComplianceGuardConfig;
  now?: () => Date;
}

export class DefaultComplianceGuard implements ComplianceGuard {
  private readonly suppressionEntryRepository: SuppressionEntryRepository;
  private readonly warmupStateRepository: WarmupStateRepository;
  private readonly emailEventRepository: EmailEventRepository;
  private readonly outreachRepository: OutreachRepository;
  private readonly consumeToken: (
    input: ConsumeTokenInput,
  ) => Promise<ConsumeTokenResult>;
  private readonly config: ComplianceGuardConfig;
  private readonly now: () => Date;

  constructor(deps: ComplianceGuardDependencies = {}) {
    this.suppressionEntryRepository =
      deps.suppressionEntryRepository ?? suppressionEntryRepository;
    this.warmupStateRepository =
      deps.warmupStateRepository ?? warmupStateRepository;
    this.emailEventRepository =
      deps.emailEventRepository ?? emailEventRepository;
    this.outreachRepository = deps.outreachRepository ?? outreachRepository;
    this.consumeToken = deps.consumeToken ?? defaultConsumeToken;
    this.config = deps.config ?? getComplianceGuardConfig();
    this.now = deps.now ?? (() => new Date());
  }

  async assertCanSend(
    _agent: AgentForGuard,
    _options: AssertCanSendOptions = {},
  ): Promise<void> {
    void complianceBlockedTotal;
    throw new Error("M6 ComplianceGuard.assertCanSend not implemented");
  }
}

const defaultComplianceGuard = new DefaultComplianceGuard();

export let complianceGuard: ComplianceGuard = defaultComplianceGuard;

export function _setComplianceGuardForTesting(
  guard: ComplianceGuard | null,
): void {
  complianceGuard = guard ?? defaultComplianceGuard;
}
