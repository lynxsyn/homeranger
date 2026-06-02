/**
 * PhotoSource — yields the analysable photos for a listing. The
 * ListingAnalysisService depends on this INTERFACE only, so the real R2-backed
 * source (prod) and the deterministic fake (E2E/CI, network-free) are swapped at
 * the worker boundary by `ANALYSIS_FAKE`, exactly like the M4 extraction seam.
 *
 * A photo carries its raw bytes (for the Haiku vision block), media type, an
 * `imageHash` (the dedup key — sha256 of the BYTES, so the same image arriving
 * in two emails is analysed once), and the durable `imageUrl` reference.
 */
export interface AnalyzablePhoto {
  /** sha256 of the image bytes — the PhotoAnalysis dedup key (AC#1). */
  imageHash: string;
  /** Durable reference (e.g. `r2://bucket/key`), persisted on PhotoAnalysis. */
  imageUrl: string | null;
  data: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface PhotoSource {
  getPhotos(listingId: string): Promise<AnalyzablePhoto[]>;
}
