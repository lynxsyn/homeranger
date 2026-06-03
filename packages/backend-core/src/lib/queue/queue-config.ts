/**
 * Queue + job-type config for the homeranger BullMQ layer.
 *
 * Doxus derives QueueName / JobType from PRISMA enums; homeranger's schema has
 * NO such enum (the data model never added one), so the job types are a TS
 * union of const string literals — the shape the M4 spec asks for
 * (`outreach:inbound | resend:event | analyze:listing`). This file is the
 * single source of truth for the queue names, the job-type union, the typed
 * payloads, and the per-queue retry policy.
 *
 * One BullMQ queue per job type (three total). The logical job-type strings
 * carry a colon (`outreach:inbound`) which BullMQ ALSO uses as its Redis key
 * delimiter — the colon is fine in a QUEUE NAME (BullMQ namespaces it) but is
 * rejected in a custom jobId, so the jobId is sanitised at the enqueue boundary
 * (see sanitizeJobId in queue-client.ts). The colon-bearing idempotency keys
 * the routes mint (`resend:inbound:<email_id>`) stay logical; only the BullMQ
 * jobId is sanitised.
 */

/** The BullMQ queue names — one per job type. */
export const QUEUE_NAMES = {
  inbound: "outreach:inbound",
  event: "resend:event",
  analyze: "analyze:listing",
  recompute: "analyze:recompute",
  // M6 outbound outreach.
  send: "outreach:send",
  followup: "outreach:followup",
  // Cadence job (scheduler-driven): scans awaiting_reply threads past the
  // cadence + fans out one outreach:followup per due thread.
  followupScan: "outreach:followup-scan",
  warmup: "warmup:recalc",
  // M7: discover estate agents in a region (web search/extract → upsert Agents).
  discoverAgents: "discover:agents",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Every job type that can ride the homeranger queues (== the queue names). */
export const JOB_TYPES = [
  QUEUE_NAMES.inbound,
  QUEUE_NAMES.event,
  QUEUE_NAMES.analyze,
  QUEUE_NAMES.recompute,
  QUEUE_NAMES.send,
  QUEUE_NAMES.followup,
  QUEUE_NAMES.followupScan,
  QUEUE_NAMES.warmup,
  QUEUE_NAMES.discoverAgents,
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * `outreach:inbound` payload — Resend's `email.received` webhook is METADATA
 * ONLY (no body text, no attachment bytes), so the route enqueues exactly the
 * webhook metadata and the WORKER hydrates the body + attachment bytes from the
 * Resend Received-Emails / Attachments API. The payload mirrors the
 * `resendInboundEventSchema` data shape (kept here independently so the queue
 * layer carries no route import cycle).
 */
export interface InboundEmailJobPayload {
  email_id: string;
  message_id?: string | null;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string | null;
  created_at?: string;
  attachments: Array<{
    id: string;
    filename: string;
    content_type: string;
    content_disposition?: string;
    content_id?: string | null;
  }>;
}

/**
 * `resend:event` payload — a delivery/bounce/complaint event. The worker
 * normalises `type` → EmailEventType, persists an EmailEvent, and suppresses on
 * hard bounce / complaint. `providerEventId` is the Svix `svix-id` (the stable
 * per-delivery id the unique constraint dedupes on).
 */
export interface ResendEventJobPayload {
  providerEventId: string;
  type: string;
  created_at?: string;
  data: {
    email_id: string;
    from?: string;
    to?: string[];
    subject?: string | null;
    bounce?: {
      message?: string;
      type?: string;
      subType?: string;
    };
  };
}

/** `analyze:listing` payload — score one listing's photos + embed + match. */
export interface AnalyzeListingJobPayload {
  listingId: string;
}

/**
 * `analyze:recompute` payload — the profile-driven top-K re-rank (AC#3).
 * Enqueued ONCE by the preferences backfill trigger when the SearchProfile
 * changes (not per listing), so the cost is bounded to the top-K re-score.
 * Carries no fields (the single SearchProfile is the implicit subject);
 * `reason` is optional log/trace context.
 */
export interface AnalyzeRecomputeJobPayload {
  reason?: string;
}

/**
 * `outreach:send` payload — cold-contact one agent (the guard re-checks).
 *
 * `searchId` (PR3, optional) ties the send to a launched search: when present the
 * worker drafts the email BODY from that search's brief (draftSearchEmail) instead
 * of the generic draft. Absent ⇒ the existing generic first-contact email.
 */
export interface OutreachSendJobPayload {
  agentId: string;
  searchId?: string;
}

/** `outreach:followup` payload — send a follow-up on one awaiting_reply thread. */
export interface OutreachFollowupJobPayload {
  threadId: string;
}

/**
 * `outreach:followup-scan` payload — the scheduler-driven cadence scan. Fieldless
 * (it scans ALL awaiting_reply threads past the cadence); `reason` is optional
 * log/trace context. The processor consumes it, lists due threads, and enqueues
 * one `outreach:followup` per thread.
 */
export interface OutreachFollowupScanJobPayload {
  reason?: string;
}

/**
 * `warmup:recalc` payload — the scheduler-driven daily ramp + breaker-rate
 * reconcile. Fieldless (the single WarmupState row is the implicit subject);
 * `reason` is optional log/trace context.
 */
export interface WarmupRecalcJobPayload {
  reason?: string;
}

/**
 * `discover:agents` payload — discover + upsert estate agents.
 *
 * Two targeting modes (the handler branches on `outcodes`):
 *   - `outcodes` (PR3, optional): discover by an EXPLICIT outcode set, skipping
 *     the region→outcode resolution. A launched search enqueues its own resolved
 *     `search.outcodes` here.
 *   - `regionName` (M7): discover by a curated region name (resolved to outcodes
 *     server-side). Still used by region-driven discovery.
 */
export interface DiscoverAgentsJobPayload {
  regionName?: string;
  outcodes?: string[];
}

export interface JobPayloadByType {
  "outreach:inbound": InboundEmailJobPayload;
  "resend:event": ResendEventJobPayload;
  "analyze:listing": AnalyzeListingJobPayload;
  "analyze:recompute": AnalyzeRecomputeJobPayload;
  "outreach:send": OutreachSendJobPayload;
  "outreach:followup": OutreachFollowupJobPayload;
  "outreach:followup-scan": OutreachFollowupScanJobPayload;
  "warmup:recalc": WarmupRecalcJobPayload;
  "discover:agents": DiscoverAgentsJobPayload;
}

export interface RetryPolicy {
  attempts: number;
  backoff?: {
    type: "exponential" | "fixed";
    delay: number;
  };
}

/**
 * Per-queue retry policy (mirrors Doxus RETRY_POLICIES shape). Inbound
 * extraction gets exponential backoff because the retryable class is upstream
 * rate-limit / transient R2/Anthropic/Resend errors; events are cheap and
 * idempotent so a flat attempt count is fine; analyze is an M5 placeholder.
 */
export const RETRY_POLICIES: Record<QueueName, RetryPolicy> = {
  [QUEUE_NAMES.inbound]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
  [QUEUE_NAMES.event]: { attempts: 5, backoff: { type: "fixed", delay: 2000 } },
  [QUEUE_NAMES.analyze]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
  // Recompute is idempotent (BullMQ dedupes the single jobId) + bounded; a
  // couple of retries cover a transient LLM/embedding blip.
  [QUEUE_NAMES.recompute]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
  // Sends are idempotent at the provider (Idempotency-Key); exponential backoff
  // covers transient Resend/SMTP errors + a deferred warm-up cap (retryable).
  // attempts:3 (not 5) BOUNDS the warm-up-cap drift: each retry re-runs
  // assertCanSend(reserve:true) which re-consumes a token, so a flapping send
  // can burn at most 3 of the day's cap (fails safe — under-sends — and the
  // UTC-day bucket key rolls daily). The provider Idempotency-Key still prevents
  // a double physical send across those retries.
  [QUEUE_NAMES.send]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
  },
  [QUEUE_NAMES.followup]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
  },
  // Cadence scan + recalc are idempotent + scheduler-driven; a couple of retries
  // cover a transient DB/Redis blip.
  [QUEUE_NAMES.followupScan]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
  [QUEUE_NAMES.warmup]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
  // Discovery hits a web search/scrape vendor — transient 429/5xx are common;
  // a few exponential retries cover them.
  [QUEUE_NAMES.discoverAgents]: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
  },
};
