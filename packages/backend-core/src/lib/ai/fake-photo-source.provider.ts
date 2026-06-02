/**
 * Env-gated FAKE PhotoSource for E2E / integration / CI (`ANALYSIS_FAKE=1`).
 * Synthesises ONE deterministic photo per listing so the analysis pipeline
 * populates a real `PhotoAnalysis` row (→ the ListingsPage row-expand renders
 * features) WITHOUT any R2 fetch or real image bytes. The `imageHash` is derived
 * from the listing id so re-running the analysis dedups exactly like prod.
 * Never used in production.
 */
import { createHash } from "node:crypto";
import type { AnalyzablePhoto, PhotoSource } from "./photo-source.js";

export class FakePhotoSource implements PhotoSource {
  async getPhotos(listingId: string): Promise<AnalyzablePhoto[]> {
    const imageHash = createHash("sha256")
      .update(`fake-photo:${listingId}`)
      .digest("hex");
    return [
      {
        imageHash,
        imageUrl: `fake://photo/${listingId}`,
        data: Buffer.from(`fake-image-bytes:${listingId}`),
        mediaType: "image/jpeg",
      },
    ];
  }
}
