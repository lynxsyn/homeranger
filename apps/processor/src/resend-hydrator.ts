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
    for (const att of data.attachments ?? []) {
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
      const buffer = Buffer.from(await response.arrayBuffer());
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
