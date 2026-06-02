/**
 * Real Resend-SDK inbound hydrator (lives in apps/processor, where `resend` is
 * a dependency). Implements the backend-core `ResendHydrator` interface:
 *   - `resend.emails.receiving.get(email_id)` → text/html/headers + attachment
 *     metadata, and the SPF/DKIM authentication-results from the headers;
 *   - for each attachment, `resend.emails.receiving.attachments.get` →
 *     `{ download_url }` → `fetch(download_url)` → Buffer → R2 (putAttachment).
 *
 * The Anthropic / R2 / queue glue lives in backend-core; this module owns ONLY
 * the Resend fetch + R2 store. The fake counterpart (FakeResendHydrator) is in
 * backend-core and selected by `RESEND_FAKE=1`, so this real path is never hit
 * in E2E / CI.
 */
import { Resend } from "resend";
import {
  getR2Storage,
  buildAttachmentKey,
  type R2Storage,
} from "@homescout/backend-core/lib/storage/r2";
import { MAX_ATTACHMENTS_PER_EMAIL } from "@homescout/backend-core/lib/ai/listing-extraction.adapter";
import {
  normaliseAuthVerdict,
  firstRecipient,
  type HydratedInboundEmail,
  type ResendHydrator,
} from "@homescout/backend-core/lib/inbound/resend-hydrator";
import type { InboundEmailJobPayload } from "@homescout/backend-core/lib/queue/queue-config";
import type { DecodedAttachment } from "@homescout/backend-core/services/inbound-ingestion.service";

/**
 * Read SPF/DKIM verdicts from the Authentication-Results header (lower-cased
 * keys). Resend surfaces them in `headers` on the received-email payload.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Aggregate attachment-byte budget per email (env-overridable). The inbound
 * address is publicly emailable and Svix authenticates Resend (the FORWARDER),
 * not the sender — so an attacker can email arbitrarily many / large
 * attachments. Without a cap the worker buffers them ALL resident (OOM, ×4
 * concurrency) and base64-encodes them into ONE multi-GB Claude request (billed,
 * retried 3×). We cap BOTH the count (MAX_ATTACHMENTS_PER_EMAIL, shared with the
 * adapter) and the cumulative bytes here, BEFORE buffering, and DROP the excess
 * with a log.warn rather than throwing — a spammy email should still ingest its
 * text + the first N in-budget attachments, not fail.
 */
const MAX_ATTACHMENT_TOTAL_BYTES = envInt(
  "MAX_ATTACHMENT_TOTAL_BYTES",
  20 * 1024 * 1024,
);
/** Per-attachment byte cap — a single oversize attachment is skipped outright. */
const MAX_ATTACHMENT_BYTES = envInt(
  "MAX_ATTACHMENT_BYTES",
  10 * 1024 * 1024,
);

function warnAttachmentDropped(
  reason: string,
  detail: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      type: "warn",
      scope: "inbound.attachment.dropped",
      reason,
      ...detail,
    }),
  );
}

function authVerdict(
  headers: Record<string, string> | null | undefined,
  kind: "spf" | "dkim",
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const authResults =
    headers["authentication-results"] ?? headers["Authentication-Results"];
  if (typeof authResults !== "string") {
    return undefined;
  }
  const match = new RegExp(`${kind}=([a-z]+)`, "i").exec(authResults);
  return match?.[1];
}

export class RealResendHydrator implements ResendHydrator {
  private readonly resend: Resend;
  private readonly storage: R2Storage;

  constructor(deps: { resend?: Resend; storage?: R2Storage } = {}) {
    this.resend =
      deps.resend ?? new Resend(process.env.RESEND_API_KEY ?? "");
    this.storage = deps.storage ?? getR2Storage();
  }

  async hydrate(
    metadata: InboundEmailJobPayload,
  ): Promise<HydratedInboundEmail> {
    const { data, error } = await this.resend.emails.receiving.get(
      metadata.email_id,
    );
    if (error || !data) {
      throw new Error(
        `Resend receiving.get failed for ${metadata.email_id}: ${
          error ? JSON.stringify(error) : "no data"
        }`,
      );
    }

    const attachments: DecodedAttachment[] = [];
    let totalBytes = 0;
    for (const att of data.attachments ?? []) {
      // Count cap — stop fetching/buffering once we hold the max; the remaining
      // attachments are never downloaded into memory.
      if (attachments.length >= MAX_ATTACHMENTS_PER_EMAIL) {
        warnAttachmentDropped("count_cap", {
          emailId: metadata.email_id,
          maxAttachments: MAX_ATTACHMENTS_PER_EMAIL,
        });
        break;
      }

      const { data: attData, error: attError } =
        await this.resend.emails.receiving.attachments.get({
          emailId: metadata.email_id,
          id: att.id,
        });
      if (attError || !attData?.download_url) {
        throw new Error(
          `Resend attachment fetch failed for ${att.id}: ${
            attError ? JSON.stringify(attError) : "no download_url"
          }`,
        );
      }
      const response = await fetch(attData.download_url);
      if (!response.ok) {
        throw new Error(
          `Attachment download failed (${response.status}) for ${att.id}`,
        );
      }

      // Cheapest correct guard: skip an oversize download by Content-Length
      // BEFORE pulling the body into memory. (Falls through to the post-download
      // byteLength check when the header is absent/unreliable.)
      const declaredLength = Number.parseInt(
        response.headers.get("content-length") ?? "",
        10,
      );
      if (
        Number.isFinite(declaredLength) &&
        (declaredLength > MAX_ATTACHMENT_BYTES ||
          totalBytes + declaredLength > MAX_ATTACHMENT_TOTAL_BYTES)
      ) {
        warnAttachmentDropped("byte_budget", {
          emailId: metadata.email_id,
          attachmentId: att.id,
          declaredLength,
        });
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      // Post-download backstop (Content-Length can be absent/wrong): drop if this
      // attachment alone exceeds the per-attachment cap or would push the running
      // total over the aggregate budget.
      if (
        buffer.byteLength > MAX_ATTACHMENT_BYTES ||
        totalBytes + buffer.byteLength > MAX_ATTACHMENT_TOTAL_BYTES
      ) {
        warnAttachmentDropped("byte_budget", {
          emailId: metadata.email_id,
          attachmentId: att.id,
          byteSize: buffer.byteLength,
          totalBytes,
        });
        continue;
      }
      totalBytes += buffer.byteLength;

      const fileName = att.filename ?? `${att.id}.bin`;
      const stored = await this.storage.putAttachment({
        body: buffer,
        key: buildAttachmentKey(metadata.email_id, fileName),
        contentType: att.content_type,
      });
      attachments.push({
        fileName,
        mimeType: att.content_type,
        byteSize: buffer.byteLength,
        buffer,
        storedUrl: stored.url,
      });
    }

    return {
      messageId: metadata.email_id,
      receivedAt: data.created_at ? new Date(data.created_at) : new Date(),
      recipientEmail: data.to?.[0] ?? firstRecipient(metadata),
      senderEmail: data.from ?? metadata.from,
      senderName: null,
      subject: data.subject ?? metadata.subject ?? null,
      bodyText: data.text ?? null,
      bodyHtml: data.html ?? null,
      spfVerdict: normaliseAuthVerdict(authVerdict(data.headers, "spf")),
      dkimVerdict: normaliseAuthVerdict(authVerdict(data.headers, "dkim")),
      attachments,
    };
  }
}
