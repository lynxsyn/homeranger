/**
 * Resend inbound hydration seam.
 *
 * Resend's `email.received` webhook is METADATA ONLY — no body text/html, no
 * attachment bytes. The worker must HYDRATE the message before extraction:
 *   - `resend.emails.receiving.get(email_id)` → text/html/headers (incl. the
 *     SPF/DKIM authentication-results) + the attachment metadata list;
 *   - `resend.emails.receiving.attachments.get({ emailId, id })` →
 *     `{ download_url }` → `fetch(download_url)` → Buffer for each attachment.
 *
 * The concrete Resend-SDK hydrator lives in apps/processor (where `resend` is a
 * dependency). This module defines the INTERFACE + the env-gated FAKE so:
 *   - the inbound-ingestion service / worker depend only on the interface;
 *   - E2E + integration + CI never touch the real Resend API. When
 *     `RESEND_FAKE=1` the worker uses `FakeResendHydrator`, which derives a
 *     deterministic body from the webhook metadata (so a Svix-signed
 *     `email.received` POST drives a real Listing upsert end-to-end without
 *     network egress).
 */
import type { EmailAuthVerdict } from "@prisma/client";
import type { DecodedAttachment } from "../../services/inbound-ingestion.service.js";
import type { InboundEmailJobPayload } from "../queue/queue-config.js";

/** The hydrated message a hydrator returns from the webhook metadata. */
export interface HydratedInboundEmail {
  messageId: string;
  receivedAt: Date;
  recipientEmail: string;
  senderEmail: string;
  senderName: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  spfVerdict: EmailAuthVerdict;
  dkimVerdict: EmailAuthVerdict;
  attachments: DecodedAttachment[];
}

export interface ResendHydrator {
  hydrate(metadata: InboundEmailJobPayload): Promise<HydratedInboundEmail>;
}

const EMAIL_AUTH_VERDICTS: readonly EmailAuthVerdict[] = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "unknown",
];

/** Map a free-form auth verdict string to the EmailAuthVerdict enum. */
export function normaliseAuthVerdict(value: string | undefined): EmailAuthVerdict {
  const lowered = (value ?? "").trim().toLowerCase();
  return (EMAIL_AUTH_VERDICTS as readonly string[]).includes(lowered)
    ? (lowered as EmailAuthVerdict)
    : "unknown";
}

/** First sender/recipient helpers (Resend `from` is a string, `to` an array). */
export function firstRecipient(metadata: InboundEmailJobPayload): string {
  return metadata.to[0] ?? "";
}

/**
 * Env-gated fake hydrator. Returns a deterministic body derived from the
 * webhook metadata's subject (so the fake extractor downstream can produce a
 * stable Listing). NO attachments (the fake never fetches bytes). Verdicts
 * default to `pass` so the source record records a plausible value.
 *
 * Used in E2E / integration / CI via `RESEND_FAKE=1`; never in production.
 */
export class FakeResendHydrator implements ResendHydrator {
  async hydrate(
    metadata: InboundEmailJobPayload,
  ): Promise<HydratedInboundEmail> {
    const subject = metadata.subject ?? "";
    const bodyText =
      `Inbound agent email (test seam).\nSubject: ${subject}\n` +
      `From: ${metadata.from}`;
    return {
      messageId: metadata.email_id,
      receivedAt: metadata.created_at
        ? new Date(metadata.created_at)
        : new Date(),
      recipientEmail: firstRecipient(metadata),
      senderEmail: metadata.from,
      senderName: null,
      subject: metadata.subject ?? null,
      bodyText,
      bodyHtml: null,
      spfVerdict: "pass",
      dkimVerdict: "pass",
      attachments: [],
    };
  }
}
