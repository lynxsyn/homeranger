/**
 * R2-backed PhotoSource (prod). Reads a listing's source records, collects the
 * image attachment URLs M4 stored in `ListingSourceRecord.rawPayload`
 * (`attachmentUrls: r2://<bucket>/<key>`), fetches each image's bytes from R2,
 * and hashes the BYTES for the dedup key. Non-image attachments (PDFs, unknown
 * types) are skipped — only formats Claude vision can read are returned.
 *
 * Network + crypto I/O (excluded from unit coverage like the M4 hydrator); the
 * fake is what the E2E exercises, and the integration test seeds R2 via the
 * storage primitive directly.
 */
import { createHash } from "node:crypto";
import {
  listingSourceRecordRepository,
  type ListingSourceRecordRepository,
} from "../../repositories/listing-source-record.repository.js";
import { getR2Storage, type R2Storage } from "../storage/r2.js";
import type { AnalyzablePhoto, PhotoSource } from "./photo-source.js";

const IMAGE_EXTENSIONS: Record<string, AnalyzablePhoto["mediaType"]> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** Parse `r2://<bucket>/<key>` → `{ key }`; returns null for any other scheme. */
function parseR2Key(url: string): string | null {
  if (!url.startsWith("r2://")) {
    return null;
  }
  const withoutScheme = url.slice("r2://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash < 0) {
    return null;
  }
  const key = withoutScheme.slice(slash + 1);
  return key.length > 0 ? key : null;
}

function mediaTypeForKey(key: string): AnalyzablePhoto["mediaType"] | null {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS[ext] ?? null;
}

export interface R2PhotoSourceDeps {
  sourceRecordRepository?: ListingSourceRecordRepository;
  r2Storage?: R2Storage;
}

export class R2PhotoSource implements PhotoSource {
  private readonly sourceRecordRepository: ListingSourceRecordRepository;
  private readonly r2Storage: R2Storage;

  constructor(deps: R2PhotoSourceDeps = {}) {
    this.sourceRecordRepository =
      deps.sourceRecordRepository ?? listingSourceRecordRepository;
    this.r2Storage = deps.r2Storage ?? getR2Storage();
  }

  async getPhotos(listingId: string): Promise<AnalyzablePhoto[]> {
    const records = await this.sourceRecordRepository.listByListing(listingId);

    // Collect unique r2:// image URLs across all source records for the listing.
    const urls = new Set<string>();
    for (const record of records) {
      const payload = record.rawPayload as { attachmentUrls?: unknown } | null;
      const attachmentUrls = payload?.attachmentUrls;
      if (!Array.isArray(attachmentUrls)) {
        continue;
      }
      for (const url of attachmentUrls) {
        if (typeof url === "string") {
          urls.add(url);
        }
      }
    }

    const photos: AnalyzablePhoto[] = [];
    for (const url of urls) {
      const key = parseR2Key(url);
      if (!key) {
        continue;
      }
      const mediaType = mediaTypeForKey(key);
      if (!mediaType) {
        continue;
      }
      const data = await this.r2Storage.getAttachmentBuffer(key);
      const imageHash = createHash("sha256").update(data).digest("hex");
      photos.push({ imageHash, imageUrl: url, data, mediaType });
    }
    return photos;
  }
}
