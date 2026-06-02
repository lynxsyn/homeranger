/**
 * EmailProvider — the swappable outbound-send seam (M6). Per the email-provider
 * decision (docs/decisions/2026-06-01-email-provider-vendor.md): Resend is the
 * vendor, but NO direct Resend SDK call lives outside this interface's adapter,
 * keeping the choice reversible (Mailjet/SES are drop-ins). nodemailer SMTP is
 * the retained fallback transport. Concrete adapters live in mailbox-adapter.ts;
 * this module owns the interface, the deterministic fake, and the env config.
 *
 * IDEMPOTENCY (load-bearing — see DD4 / the design review CRITICAL): every send
 * carries an `idempotencyKey`. The real adapter forwards it as the provider's
 * `Idempotency-Key` so a BullMQ retry after a crash-between-send-and-persist
 * returns the ORIGINAL message id instead of dispatching a SECOND physical
 * email. The fake derives its id from the key ONLY, so a retry yields the same
 * providerMessageId and the OutreachMessage @@unique(providerMessageId) makes
 * the persist idempotent too.
 */
import { createHash } from "node:crypto";

export interface SendEmailInput {
  to: string;
  from: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  /** Extra headers (e.g. RFC 8058 List-Unsubscribe / List-Unsubscribe-Post). */
  headers?: Record<string, string>;
  /** Deterministic key — forwarded to the provider so retries never double-send. */
  idempotencyKey: string;
}

export interface SendEmailResult {
  /** The provider's message id (Resend send id) — stored as providerMessageId. */
  providerMessageId: string;
}

export interface EmailProvider {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export interface OutreachEmailConfig {
  /** The verified sending address (RESEND_FROM), e.g. "Homescout <hi@…>". */
  from: string;
  /** Optional Reply-To override. */
  replyTo?: string;
}

export function getOutreachEmailConfig(): OutreachEmailConfig {
  const from = process.env.RESEND_FROM?.trim();
  if (!from) {
    throw new Error(
      "RESEND_FROM is required to send outreach (the verified sending address)",
    );
  }
  const replyTo = process.env.RESEND_REPLY_TO?.trim();
  return replyTo ? { from, replyTo } : { from };
}

/**
 * Deterministic, network-free send provider for E2E/CI (OUTREACH_FAKE=1). The
 * id is derived from the idempotencyKey ALONE so a retried send returns the
 * SAME providerMessageId — exactly the property the real provider gets from its
 * Idempotency-Key header. No email is dispatched; zero spend.
 */
export class FakeEmailSendProvider implements EmailProvider {
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const hash = createHash("sha256")
      .update(input.idempotencyKey)
      .digest("hex")
      .slice(0, 32);
    return { providerMessageId: `fake-${hash}` };
  }
}
