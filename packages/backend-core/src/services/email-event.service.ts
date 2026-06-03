/**
 * EmailEventService — the consume-side handler for the `resend:event` queue.
 * It normalises a Resend delivery/bounce/complaint event into the homeranger
 * `EmailEventType` enum, persists an idempotent `EmailEvent` row, and on a hard
 * bounce / spam complaint inserts a `SuppressionEntry` (feeds the M6 circuit
 * breaker). Idempotent end-to-end: the EmailEvent unique on `providerEventId`
 * means a redelivered webhook is a no-op, and suppression only mutates on the
 * FIRST delivery of a given event.
 *
 * DI pattern (email-ingestion.service.ts + homeranger repos): interface +
 * `Default…Service` with `deps.x ?? defaultX`, `let` singleton + setter. NO
 * direct Prisma — repositories only. TRPCError-free (worker-side service).
 */
import type { EmailEventType, Prisma } from "@prisma/client";
import {
  emailEventRepository,
  type EmailEventRepository,
} from "../repositories/email-event.repository.js";
import {
  suppressionEntryRepository,
  type SuppressionEntryRepository,
} from "../repositories/suppression-entry.repository.js";

/** The Resend event payload the worker hands the service (queue payload shape). */
export interface ResendEventInput {
  /** Stable per-delivery id (the Svix `svix-id`) — EmailEvent.providerEventId. */
  providerEventId: string;
  /** Resend event type, e.g. `email.bounced`. */
  type: string;
  data: {
    email_id: string;
    from?: string;
    to?: string[];
    subject?: string | null;
    bounce?: {
      message?: string;
      /** "Permanent" (hard) | "Transient" (soft) | "Undetermined". */
      type?: string;
      subType?: string;
    };
  };
  /** When the event occurred (the webhook `created_at`), defaults to now. */
  occurredAt?: Date;
}

export interface IngestEventResult {
  providerEventId: string;
  emailEventId: string | null;
  /** false when this providerEventId was already stored (redelivery no-op). */
  created: boolean;
  /** Whether this event added/refreshed a SuppressionEntry. */
  suppressed: boolean;
  /** null when the Resend type has no EmailEventType (e.g. email.sent). */
  eventType: EmailEventType | null;
}

export interface EmailEventService {
  ingestEvent(input: ResendEventInput): Promise<IngestEventResult>;
}

interface EmailEventServiceDependencies {
  emailEventRepository?: EmailEventRepository;
  suppressionEntryRepository?: SuppressionEntryRepository;
}

/**
 * Resend event type → homeranger EmailEventType. `email.sent` has no homeranger
 * EmailEventType (we never persist a bare "sent") → null = ignore.
 */
const RESEND_TYPE_TO_EVENT_TYPE: Record<string, EmailEventType | null> = {
  "email.sent": null,
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.delivery_delayed": "deferred",
  "email.failed": "failed",
};

export function normaliseResendEventType(
  type: string,
): EmailEventType | null | undefined {
  return RESEND_TYPE_TO_EVENT_TYPE[type];
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** First recipient (Resend events carry the recipient(s) on `data.to`). */
function recipientOf(input: ResendEventInput): string {
  return input.data.to?.[0] ?? "";
}

export class DefaultEmailEventService implements EmailEventService {
  private readonly emailEventRepository: EmailEventRepository;
  private readonly suppressionEntryRepository: SuppressionEntryRepository;

  constructor(deps: EmailEventServiceDependencies = {}) {
    this.emailEventRepository = deps.emailEventRepository ?? emailEventRepository;
    this.suppressionEntryRepository =
      deps.suppressionEntryRepository ?? suppressionEntryRepository;
  }

  async ingestEvent(input: ResendEventInput): Promise<IngestEventResult> {
    const eventType = RESEND_TYPE_TO_EVENT_TYPE[input.type];

    // Unknown / non-persisted types (e.g. email.sent) → no-op.
    if (eventType === null || eventType === undefined) {
      return {
        providerEventId: input.providerEventId,
        emailEventId: null,
        created: false,
        suppressed: false,
        eventType: null,
      };
    }

    const email = normaliseEmail(recipientOf(input));
    const { event, created } = await this.emailEventRepository.recordOrIgnore({
      providerEventId: input.providerEventId,
      messageId: input.data.email_id,
      email,
      eventType,
      payload: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue,
      occurredAt: input.occurredAt ?? new Date(),
    });

    // A reputation-damaging event (hard bounce / complaint) that SHOULD suppress
    // but carries no recipient address cannot be suppressed — Resend payloads
    // carry the recipient on `data.to`, but malformed/edge payloads (BCC-only,
    // schema drift) can omit it. Persist the EmailEvent (above) but make the
    // skipped suppression OBSERVABLE rather than silent. Do NOT invent a
    // recipient.
    const wouldSuppress =
      created &&
      ((eventType === "bounced" && input.data.bounce?.type === "Permanent") ||
        eventType === "complained");
    if (wouldSuppress && email.length === 0) {
      console.warn(
        JSON.stringify({
          type: "warn",
          scope: "email.event.suppression.skipped.no_recipient",
          providerEventId: input.providerEventId,
          eventType,
        }),
      );
    }

    // Only mutate suppression on the FIRST delivery (created) of the two
    // reputation-damaging types. A hard bounce is `bounce.type === "Permanent"`;
    // a soft ("Transient") bounce must NOT suppress.
    let suppressed = false;
    if (created && email.length > 0) {
      if (eventType === "bounced" && input.data.bounce?.type === "Permanent") {
        await this.suppressionEntryRepository.suppress({
          email,
          reason: "hard_bounce",
          note: input.data.bounce?.message ?? "Resend hard bounce",
        });
        suppressed = true;
      } else if (eventType === "complained") {
        await this.suppressionEntryRepository.suppress({
          email,
          reason: "spam_complaint",
          note: "Resend spam complaint",
        });
        suppressed = true;
      }
    }

    return {
      providerEventId: input.providerEventId,
      emailEventId: event.id,
      created,
      suppressed,
      eventType,
    };
  }
}

const defaultEmailEventService = new DefaultEmailEventService();

export let emailEventService: EmailEventService = defaultEmailEventService;

export function _setEmailEventServiceForTesting(
  service: EmailEventService | null,
): void {
  emailEventService = service ?? defaultEmailEventService;
}
