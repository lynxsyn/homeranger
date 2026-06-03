/**
 * DedupService — resolves whether an incoming property already exists as a
 * `Listing`, returning the existing listingId or null. The dedup KEY is
 * `Listing.addressNormalized` (the unique column the listing repository upserts
 * on). Resolution is two-stage:
 *
 *   1. EXACT: normalise the inbound address (UK postcode + free-text address)
 *      into the same canonical form used as `addressNormalized`, then look it
 *      up via listingRepository.getByAddressNormalized. A hit is a certain dup.
 *   2. EMBEDDING FALLBACK (optional): if no exact hit AND the caller supplies a
 *      query embedding, run `listingRepository.vectorTopK` and treat the
 *      nearest hit as a duplicate when its cosine DISTANCE is below a threshold
 *      (`<=>`: 0 = identical, 2 = opposite). This catches the same property
 *      described with slightly different address text across two agent emails.
 *      (M4's extractor produces no embedding yet, so dedup is exact-match-only
 *      in practice; the fallback is wired for M5 + tested with a fake.)
 *
 * DI pattern (email-ingestion.service.ts + homeranger repos): interface + a
 * `Default…Service` taking `deps = {}` with `this.x = deps.x ?? defaultX`,
 * a bottom `let` singleton export + `_set…ForTesting`. NO direct Prisma — every
 * read goes through `listingRepository`. TRPCError-free (worker-side service).
 */
import { normalisePostcode } from "@homeranger/shared";
import {
  listingRepository,
  type ListingRepository,
} from "../repositories/listing.repository.js";

/**
 * Cosine-distance ceiling for the embedding fallback. pgvector `<=>` returns
 * cosine distance in [0, 2]; 0 is identical. A near-duplicate of the SAME
 * property described with different free text typically lands well under 0.15
 * with voyage-3.5; the conservative ceiling means the fallback only merges
 * high-confidence matches and never collapses two genuinely distinct
 * properties. Overridable via `deps.embeddingDistanceThreshold` for tuning.
 */
export const DEFAULT_EMBEDDING_DISTANCE_THRESHOLD = 0.12;

export interface DedupCandidate {
  /** The raw, human-entered address text Claude extracted from the email. */
  addressRaw: string | null;
  /** The raw postcode Claude extracted (may be embedded in addressRaw too). */
  postcode: string | null;
  /**
   * Optional query embedding for the fallback stage. When omitted, dedup is
   * exact-match-only and returns null on a miss.
   */
  embedding?: number[];
}

export interface DedupResult {
  /** The existing listing id when a duplicate was found, else null. */
  listingId: string | null;
  /** Which stage matched — useful for the worker's structured logs / metrics. */
  matchedBy: "exact" | "embedding" | null;
  /** The canonical key computed from the candidate (also the upsert key). */
  addressNormalized: string | null;
}

export interface DedupService {
  find(candidate: DedupCandidate): Promise<DedupResult>;
  /**
   * The canonical-form builder, exposed so the ingestion service computes the
   * SAME `addressNormalized` it then upserts on (single source of truth).
   * Returns null when the address is too sparse to key on.
   */
  normaliseAddress(
    addressRaw: string | null,
    postcode: string | null,
  ): string | null;
}

interface DedupServiceDependencies {
  listingRepository?: ListingRepository;
  embeddingDistanceThreshold?: number;
}

/**
 * Build the canonical dedup key:
 *   - lower-noise the free-text address (collapse whitespace, strip punctuation
 *     that varies between agents, upper-case);
 *   - append the normalised postcode (canonical `SW1A 1AA` form) when present,
 *     because postcode is the strongest UK address discriminator.
 * Deterministic — matches what the ingestion service persists.
 */
function buildAddressKey(
  addressRaw: string | null,
  postcode: string | null,
): string | null {
  const canonicalPostcode = postcode ? normalisePostcode(postcode) : null;

  // Strip any postcode the agent embedded in the free-text line so it is not
  // double-counted, then normalise the remaining street/town text.
  const streetPart = (addressRaw ?? "")
    .replace(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/gi, " ") // drop inline postcode
    .toUpperCase()
    .replace(/[.,/#!$%^&*;:{}=_`~()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (streetPart.length === 0 && !canonicalPostcode) {
    return null;
  }

  return (
    [streetPart, canonicalPostcode].filter(Boolean).join(" ").trim() || null
  );
}

export class DefaultDedupService implements DedupService {
  private readonly listingRepository: ListingRepository;
  private readonly embeddingDistanceThreshold: number;

  constructor(deps: DedupServiceDependencies = {}) {
    this.listingRepository = deps.listingRepository ?? listingRepository;
    this.embeddingDistanceThreshold =
      deps.embeddingDistanceThreshold ?? DEFAULT_EMBEDDING_DISTANCE_THRESHOLD;
  }

  normaliseAddress(
    addressRaw: string | null,
    postcode: string | null,
  ): string | null {
    return buildAddressKey(addressRaw, postcode);
  }

  async find(candidate: DedupCandidate): Promise<DedupResult> {
    const addressNormalized = buildAddressKey(
      candidate.addressRaw,
      candidate.postcode,
    );

    // Stage 1 — exact match on the dedup key.
    if (addressNormalized) {
      const exact =
        await this.listingRepository.getByAddressNormalized(addressNormalized);
      if (exact) {
        return { listingId: exact.id, matchedBy: "exact", addressNormalized };
      }
    }

    // Stage 2 — embedding fallback (only when an embedding was supplied).
    if (candidate.embedding && candidate.embedding.length > 0) {
      const [nearest] = await this.listingRepository.vectorTopK(
        candidate.embedding,
        1,
      );
      if (nearest && nearest.distance <= this.embeddingDistanceThreshold) {
        return {
          listingId: nearest.id,
          matchedBy: "embedding",
          addressNormalized,
        };
      }
    }

    return { listingId: null, matchedBy: null, addressNormalized };
  }
}

const defaultDedupService = new DefaultDedupService();

export let dedupService: DedupService = defaultDedupService;

export function _setDedupServiceForTesting(service: DedupService | null): void {
  dedupService = service ?? defaultDedupService;
}
