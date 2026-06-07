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
 *   4. email undeliverable (discovery's SMTP probe confirmed the mailbox dead).
 *   5. per-domain cooldown (one agency = one cold approach per window).
 *   6. circuit breaker (bounce/complaint rate over the rolling window).
 *   7. manual kill-switch. 8. warm-up daily cap (token bucket; fail-closed).
 *
 * `reserve`: the worker send path calls with reserve:true (CONSUMES a token,
 * authoritative); the router precheck calls with reserve:false (PEEKS, never
 * mutates) — it still evaluates gates 1-6 so a permanently-blocked agent gets a
 * FORBIDDEN, not a misleading retryable TOO_MANY_REQUESTS.
 *
 * Observability/PII rule: every block logs `{scope:"outreach.blocked.<code>",
 * agentId}` (uuid + code ONLY — never email/body/token) and increments
 * complianceBlockedTotal{reason:<code>}.
 */
import type { EmailVerifyStatus, MailboxType } from "@prisma/client";
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
  agentRepository,
  type AgentRepository,
} from "../../repositories/agent.repository.js";
import { emailDomain } from "../email/email-domain.js";
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
  | "EMAIL_UNDELIVERABLE"
  | "DOMAIN_RECENTLY_CONTACTED"
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
  emailVerifyStatus: EmailVerifyStatus;
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
  /** Per-domain cooldown, in seconds — one agency, one cold approach per window. */
  domainCooldownSeconds: number;
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
    // 30 days by default — an agency contacted once isn't re-approached for a month.
    domainCooldownSeconds: intEnv("DOMAIN_COOLDOWN_DAYS", 30) * 86_400,
  };
}

export interface ComplianceGuardDependencies {
  suppressionEntryRepository?: SuppressionEntryRepository;
  warmupStateRepository?: WarmupStateRepository;
  emailEventRepository?: EmailEventRepository;
  outreachRepository?: OutreachRepository;
  agentRepository?: AgentRepository;
  consumeToken?: (input: ConsumeTokenInput) => Promise<ConsumeTokenResult>;
  config?: ComplianceGuardConfig;
  now?: () => Date;
}

export class DefaultComplianceGuard implements ComplianceGuard {
  private readonly suppressionEntryRepository: SuppressionEntryRepository;
  private readonly warmupStateRepository: WarmupStateRepository;
  private readonly emailEventRepository: EmailEventRepository;
  private readonly outreachRepository: OutreachRepository;
  private readonly agentRepository: AgentRepository;
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
    this.agentRepository = deps.agentRepository ?? agentRepository;
    this.consumeToken = deps.consumeToken ?? defaultConsumeToken;
    this.config = deps.config ?? getComplianceGuardConfig();
    this.now = deps.now ?? (() => new Date());
  }

  async assertCanSend(
    agent: AgentForGuard,
    options: AssertCanSendOptions = {},
  ): Promise<void> {
    const reserve = options.reserve ?? true;

    // Gate 1 — PECR corporate-subscriber carve-out. No lawful basis to send to
    // an individual/unknown mailbox, so this short-circuits before anything else.
    if (agent.mailboxType !== "corporate_subscriber") {
      this.block(agent.id, "PECR_NON_CORPORATE", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      });
    }

    // Gate 2 — agent opt-out.
    if (agent.optedOut) {
      this.block(agent.id, "OPTED_OUT", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      });
    }

    // Gate 3 — global suppression list (hard bounce / complaint / unsubscribe).
    if (await this.suppressionEntryRepository.isSuppressed(agent.email)) {
      this.block(agent.id, "SUPPRESSED", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      });
    }

    // Gate 4 — email undeliverable. Discovery's SMTP probe (MX + RCPT, no
    // message sent) confirmed this mailbox is dead (a 550-class permanent
    // reject). Block so we never re-bounce it — protecting the sender reputation
    // that a ~30% bounce rate on scraped info@/contact@ addresses was eroding.
    // `deliverable` and `unknown` (catch-all / temp / probe blocked) BOTH pass —
    // we only ever block a CONFIRMED-dead address. Non-retryable, like suppression.
    if (agent.emailVerifyStatus === "undeliverable") {
      this.block(agent.id, "EMAIL_UNDELIVERABLE", {
        retryable: false,
        trpcCode: "FORBIDDEN",
        message: "email address is undeliverable (hard bounce)",
      });
    }

    // Gate 5 — per-domain cooldown. One agency (email domain) gets at most one
    // cold approach per window, even across the several mailboxes discovery may
    // surface for it. Peek-only (no token), so a domain-blocked send fails fast
    // without burning warm-up budget. Excludes the agent itself — re-contacting
    // the SAME mailbox is the follow-up cadence's job, not this gate. Free-mail
    // never reaches here (PECR gate 1 already blocked it as `individual`).
    const domain = emailDomain(agent.email);
    if (domain) {
      const domainSince = new Date(
        this.now().getTime() - this.config.domainCooldownSeconds * 1000,
      );
      if (
        await this.agentRepository.wasDomainContactedSince(
          domain,
          domainSince,
          agent.id,
        )
      ) {
        this.block(agent.id, "DOMAIN_RECENTLY_CONTACTED", {
          retryable: false,
          trpcCode: "FORBIDDEN",
          message: "another contact at this agency was emailed recently",
        });
      }
    }

    // Gate 6 — reputation circuit breaker (bounce/complaint rate over window).
    await this.assertBreakerClosed(agent.id);

    // Gate 7 — manual kill-switch (also reads the daily cap for gate 8).
    const warmup = await this.warmupStateRepository.getOrCreate();
    if (warmup.killSwitch) {
      this.block(agent.id, "KILL_SWITCH", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      });
    }

    // Gate 8 — warm-up daily cap (token bucket). LAST, so a send blocked above
    // never burns a token. reserve:true consumes (worker); false peeks (router).
    const token = await this.consumeToken({
      key: `outreach:warmup:${this.windowKey()}`,
      cap: warmup.dailyCap,
      windowSeconds: this.config.warmupWindowSeconds,
      reserve,
    });
    if (!token.available) {
      // Fail-closed: Redis unreachable — distinct from a legitimate cap hit so
      // an outage is observable (alert on RATE_LIMIT_UNAVAILABLE, not cap).
      this.block(agent.id, "RATE_LIMIT_UNAVAILABLE", {
        retryable: true,
        trpcCode: "TOO_MANY_REQUESTS",
        retryAfterSeconds: token.retryAfterSeconds,
      });
    }
    if (!token.allowed) {
      this.block(agent.id, "WARMUP_CAP_EXCEEDED", {
        retryable: true,
        trpcCode: "TOO_MANY_REQUESTS",
        retryAfterSeconds: token.retryAfterSeconds,
      });
    }
  }

  /** Throw a typed block — logging agentId + code ONLY (never email/PII). */
  private block(
    agentId: string,
    code: ComplianceCode,
    options: ComplianceErrorOptions,
  ): never {
    complianceBlockedTotal.labels({ reason: code }).inc();
    console.warn(
      JSON.stringify({
        type: "warn",
        scope: `outreach.blocked.${code}`,
        agentId,
        ...(options.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: options.retryAfterSeconds }
          : {}),
      }),
    );
    throw new ComplianceError(code, options);
  }

  /**
   * Gate 6. rate = events ÷ attempted sends over the trailing window. Each gate
   * is evaluated ONLY at/above its min-sample floor — below it the warm-up cap +
   * kill-switch are the safety net, not a hair-trigger statistical breaker (a
   * single bounce at n=2 is meaningless). Never divides by zero.
   */
  private async assertBreakerClosed(agentId: string): Promise<void> {
    const since = new Date(
      this.now().getTime() - this.config.windowHours * 3_600_000,
    );
    const sends = await this.outreachRepository.countOutboundSince(since);

    if (sends >= this.config.bounceMinSample) {
      const bounced = await this.emailEventRepository.countByTypeSince(
        "bounced",
        since,
      );
      if (bounced / sends > this.config.bounceRate) {
        this.block(agentId, "CIRCUIT_OPEN", {
          retryable: false,
          trpcCode: "FORBIDDEN",
          message: "bounce-rate circuit breaker open",
        });
      }
    }

    if (sends >= this.config.complaintMinSample) {
      const complained = await this.emailEventRepository.countByTypeSince(
        "complained",
        since,
      );
      if (complained / sends > this.config.complaintRate) {
        this.block(agentId, "CIRCUIT_OPEN", {
          retryable: false,
          trpcCode: "FORBIDDEN",
          message: "complaint-rate circuit breaker open",
        });
      }
    }
  }

  /** UTC date (YYYY-MM-DD) — the daily warm-up bucket key. */
  private windowKey(): string {
    const d = this.now();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${d.getUTCFullYear()}-${month}-${day}`;
  }
}

const defaultComplianceGuard = new DefaultComplianceGuard();

export let complianceGuard: ComplianceGuard = defaultComplianceGuard;

export function _setComplianceGuardForTesting(
  guard: ComplianceGuard | null,
): void {
  complianceGuard = guard ?? defaultComplianceGuard;
}
