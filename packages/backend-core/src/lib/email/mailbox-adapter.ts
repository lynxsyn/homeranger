/**
 * Concrete EmailProvider transports (M6). Resend is the vendor; nodemailer SMTP
 * is the retained swappable fallback (docs/decisions/2026-06-01-email-provider-
 * vendor.md). NO direct Resend SDK call exists outside this file. The worker
 * selects the transport via env at boot (OUTREACH_FAKE → FakeEmailSendProvider;
 * EMAIL_TRANSPORT=smtp → Nodemailer; else Resend).
 *
 * IDEMPOTENCY: ResendEmailSendProvider forwards the SendEmailInput.idempotencyKey
 * as Resend's Idempotency-Key, so a BullMQ retry after a crash-between-send-and-
 * persist returns the ORIGINAL message id (no second physical email). The SMTP
 * fallback has no provider idempotency, so it derives a stable Message-ID from
 * the key — the @@unique(providerMessageId) then dedupes the persist (a rare
 * second SMTP dispatch is possible; Resend is the primary idempotent transport).
 */
import { Resend } from "resend";
import nodemailer, { type Transporter } from "nodemailer";
import type {
  EmailProvider,
  SendEmailInput,
  SendEmailResult,
} from "./email-provider.js";

export class ResendEmailSendProvider implements EmailProvider {
  private readonly client: Resend;

  constructor(apiKey: string | undefined = process.env.RESEND_API_KEY) {
    if (!apiKey) {
      throw new Error("RESEND_API_KEY is required for ResendEmailSendProvider");
    }
    this.client = new Resend(apiKey);
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const { data, error } = await this.client.emails.send(
      {
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.bodyText,
        ...(input.bodyHtml ? { html: input.bodyHtml } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (error || !data) {
      const message = error
        ? `Resend send failed: ${error.name} ${error.message}`
        : "Resend send returned no data";
      // Default to retryable (transient send error); the worker maps the
      // ComplianceError gates to non-retryable drops separately.
      throw Object.assign(new Error(message), { retryable: true });
    }
    return { providerMessageId: data.id };
  }
}

export class NodemailerEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;

  constructor(transporter?: Transporter) {
    if (transporter) {
      this.transporter = transporter;
      return;
    }
    const url = process.env.SMTP_URL;
    if (!url) {
      throw new Error("SMTP_URL is required for NodemailerEmailProvider");
    }
    this.transporter = nodemailer.createTransport(url);
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const stableId = input.idempotencyKey.replace(/[^a-zA-Z0-9._-]/g, "-");
    const info = await this.transporter.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.bodyText,
      ...(input.bodyHtml ? { html: input.bodyHtml } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      messageId: `<${stableId}@homescout>`,
    });
    return { providerMessageId: info.messageId };
  }
}
