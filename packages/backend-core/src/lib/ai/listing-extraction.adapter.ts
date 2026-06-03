/**
 * Adapter from the worker's `DecodedAttachment[]` payload to the Claude
 * extraction provider's native content blocks, implementing the
 * `ListingExtractionProvider` interface the InboundIngestionService depends on.
 *
 * Responsibilities:
 *   - classify each attachment by MIME type into a Claude block kind
 *     (`pdf` document / `image` / pre-extracted `text`);
 *   - for OVERSIZED PDFs (over the Claude inline-document cap) flatten to text
 *     via `unpdf` (pure-JS pdf.js build, no native deps) and pass a text block;
 *   - map the provider's `ExtractedListing` (pricePence integer pence, enums
 *     from @homeranger/shared tuples) onto the service's `ExtractedListing`.
 *
 * Kept SEPARATE from claude-extraction.provider.ts so the provider stays a
 * transport-free Anthropic wrapper and the adapter owns the attachment/unpdf
 * glue. The concrete Anthropic client is injectable through the provider, so
 * this adapter is exercised in unit tests with a fake provider.
 */
import { extractText, getDocumentProxy } from "unpdf";
import {
  getClaudeExtractionProvider,
  type AttachmentInput,
  type ClaudeExtractionProvider,
} from "./claude-extraction.provider.js";
import type {
  DecodedAttachment,
  ExtractedListing,
  ListingExtractionProvider,
} from "../../services/inbound-ingestion.service.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Claude inline-document cap: PDFs whose base64 size approaches the request
 * limit are flattened to text instead of sent as a document block. 28 MB raw
 * (~37 MB base64) is a conservative ceiling under the ~32 MB document cap.
 */
export const MAX_INLINE_PDF_BYTES = 28 * 1024 * 1024;

/**
 * Defense-in-depth attachment caps (env-overridable). The PRIMARY OOM/cost guard
 * is the hydrator (it drops over-budget attachments before buffering bytes); the
 * adapter caps here are an independent backstop so a fake/alternate hydrator
 * cannot blow the Claude request open. The inbound address is publicly
 * emailable + Svix authenticates the FORWARDER (Resend), not the sender, so an
 * attacker can supply arbitrary attachment volume — these bounds keep worker
 * memory and Anthropic spend finite.
 */
/** Max number of attachment BLOCKS fed to Claude per email. */
export const MAX_ATTACHMENTS_PER_EMAIL = envInt(
  "MAX_ATTACHMENTS_PER_EMAIL",
  10,
);
/** Max bytes for a single inline image (Claude's per-image limit is ~5 MB). */
export const MAX_IMAGE_BYTES = envInt("MAX_IMAGE_BYTES", 5 * 1024 * 1024);
/** Max characters of flattened-PDF text fed as a single text block. */
export const MAX_PDF_TEXT_CHARS = envInt("MAX_PDF_TEXT_CHARS", 200_000);

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

async function flattenPdfToText(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  // Bound the output so a malicious oversized PDF cannot expand into a giant
  // text block (and blow up the Claude request / worker memory).
  return merged.length > MAX_PDF_TEXT_CHARS
    ? merged.slice(0, MAX_PDF_TEXT_CHARS)
    : merged;
}

/**
 * Convert one DecodedAttachment to a Claude block. Oversized PDFs are flattened
 * to a (length-bounded) text block via unpdf; oversized images are dropped (so
 * a 50 MB PNG is never base64-encoded/sent); unknown MIME types are dropped
 * (we only feed the model formats it can read).
 */
async function toAttachmentInput(
  attachment: DecodedAttachment,
): Promise<AttachmentInput | null> {
  const mime = attachment.mimeType.toLowerCase();
  if (mime === "application/pdf") {
    if (attachment.byteSize > MAX_INLINE_PDF_BYTES) {
      const text = await flattenPdfToText(attachment.buffer);
      return { kind: "text", text, fileName: attachment.fileName };
    }
    return { kind: "pdf", data: attachment.buffer, fileName: attachment.fileName };
  }
  if (IMAGE_MEDIA_TYPES.has(mime)) {
    if (attachment.byteSize > MAX_IMAGE_BYTES) {
      console.warn(
        JSON.stringify({
          type: "warn",
          scope: "extraction.attachment.dropped.image_oversize",
          fileName: attachment.fileName,
          byteSize: attachment.byteSize,
          maxBytes: MAX_IMAGE_BYTES,
        }),
      );
      return null;
    }
    return {
      kind: "image",
      data: attachment.buffer,
      mediaType: mime as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp",
      fileName: attachment.fileName,
    };
  }
  return null;
}

export class ClaudeListingExtractionAdapter
  implements ListingExtractionProvider
{
  private readonly provider: ClaudeExtractionProvider;

  constructor(provider?: ClaudeExtractionProvider) {
    this.provider = provider ?? getClaudeExtractionProvider();
  }

  async extract(input: {
    bodyText: string | null;
    bodyHtml: string | null;
    subject: string | null;
    fromAddress?: string | null;
    attachments: DecodedAttachment[];
  }): Promise<ExtractedListing> {
    const attachmentInputs: AttachmentInput[] = [];
    for (const attachment of input.attachments) {
      // Defense-in-depth block cap: stop converting once we hold the max number
      // of blocks, so an unbounded attachment array (past whatever the hydrator
      // delivered) can never expand the single Claude request without limit.
      if (attachmentInputs.length >= MAX_ATTACHMENTS_PER_EMAIL) {
        console.warn(
          JSON.stringify({
            type: "warn",
            scope: "extraction.attachment.dropped.count_cap",
            maxAttachments: MAX_ATTACHMENTS_PER_EMAIL,
          }),
        );
        break;
      }
      const block = await toAttachmentInput(attachment);
      if (block) {
        attachmentInputs.push(block);
      }
    }

    const result = await this.provider.extractListing({
      bodyText: input.bodyText ?? "",
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.fromAddress ? { fromAddress: input.fromAddress } : {}),
      attachments: attachmentInputs,
    });

    const listing = result.listing;
    return {
      addressRaw: listing.addressRaw,
      postcode: listing.postcode,
      outcode: listing.outcode,
      pricePence: listing.pricePence,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      tenure: listing.tenure,
      propertyType: listing.propertyType,
      epcRating: listing.epcRating,
      listingStatus: listing.listingStatus,
      listingUrl: listing.listingUrl,
      confidence: listing.confidence,
    };
  }
}
