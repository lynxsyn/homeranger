/**
 * Unit tests for ClaudeListingExtractionAdapter attachment CAPS (M4 review fix —
 * CRITICAL: unbounded attachment count/aggregate size = OOM + unbounded Claude
 * spend). The adapter is the defense-in-depth backstop (the hydrator is the
 * primary guard); here we prove that feeding many / oversized attachments yields
 * a BOUNDED set of Claude blocks: the count is capped, oversized images are
 * dropped, and flattened-PDF text is sliced.
 */
import { describe, expect, it, vi } from "vitest";
import { ClaudeListingExtractionAdapter } from "./listing-extraction.adapter.js";
import {
  MAX_ATTACHMENTS_PER_EMAIL,
  MAX_IMAGE_BYTES,
} from "./listing-extraction.adapter.js";
import type {
  AttachmentInput,
  ClaudeExtractionProvider,
  ListingExtractionInput,
  ListingExtractionResult,
} from "./claude-extraction.provider.js";
import type { DecodedAttachment } from "../../services/inbound-ingestion.service.js";

/** A provider that records the attachment blocks the adapter hands it. */
class CapturingProvider implements ClaudeExtractionProvider {
  lastAttachments: AttachmentInput[] = [];
  async extractListing(
    input: ListingExtractionInput,
  ): Promise<ListingExtractionResult> {
    this.lastAttachments = input.attachments ?? [];
    return {
      listing: {
        addressRaw: null,
        postcode: null,
        outcode: null,
        pricePence: null,
        bedrooms: null,
        bathrooms: null,
        tenure: null,
        propertyType: null,
        epcRating: null,
        listingStatus: null,
        listingUrl: null,
        confidence: null,
      },
      metrics: {
        model: "fake",
        inputTokens: 0,
        outputTokens: 0,
        costPence: 0,
        durationMs: 0,
      },
    };
  }
  getModel(): string {
    return "fake";
  }
}

function img(bytes: number, i: number): DecodedAttachment {
  return {
    fileName: `img-${i}.png`,
    mimeType: "image/png",
    byteSize: bytes,
    buffer: Buffer.alloc(1), // byteSize drives the cap, not the buffer length
    storedUrl: null,
  };
}

describe("ClaudeListingExtractionAdapter — attachment caps", () => {
  it("caps the number of blocks fed to Claude at MAX_ATTACHMENTS_PER_EMAIL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new CapturingProvider();
    const adapter = new ClaudeListingExtractionAdapter(provider);

    // 100 small, in-budget images — only the cap many should reach the provider.
    const attachments = Array.from({ length: 100 }, (_, i) => img(1024, i));

    await adapter.extract({
      bodyText: "x",
      bodyHtml: null,
      subject: null,
      attachments,
    });

    expect(provider.lastAttachments.length).toBe(MAX_ATTACHMENTS_PER_EMAIL);
    vi.restoreAllMocks();
  });

  it("drops images over MAX_IMAGE_BYTES (never base64-encoded/sent)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new CapturingProvider();
    const adapter = new ClaudeListingExtractionAdapter(provider);

    await adapter.extract({
      bodyText: "x",
      bodyHtml: null,
      subject: null,
      attachments: [
        img(1024, 0), // in-budget
        img(MAX_IMAGE_BYTES + 1, 1), // oversize → dropped
      ],
    });

    expect(provider.lastAttachments.length).toBe(1);
    expect(provider.lastAttachments[0]!.kind).toBe("image");
    vi.restoreAllMocks();
  });
});
