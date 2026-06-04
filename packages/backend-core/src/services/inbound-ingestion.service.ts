/**
 * InboundIngestionService — the orchestration core of the M4 live data path,
 * consumed by the `outreach:inbound` worker. It owns NO Prisma and NO transport:
 * it accepts an already-hydrated inbound payload (the worker fetches the body +
 * attachment bytes from Resend, stores attachments to R2, and verifies the
 * webhook signature upstream) and drives extraction → dedup → upsert → enqueue.
 *
 * DI pattern (email-ingestion.service.ts + homeranger repos):
 *   - an `InboundIngestionService` interface
 *   - a `DefaultInboundIngestionService` whose constructor takes
 *     `deps = {}` and sets `this.x = deps.x ?? defaultX`
 *   - a bottom `let` singleton export + `_set…ForTesting` (the homeranger form;
 *     a `const` singleton cannot be reassigned by the setter)
 *   - NO `prisma.*` — every write goes through a repository singleton, and the
 *     Listing + ListingSourceRecord writes share ONE transaction via
 *     runTransaction
 *   - TRPCError-FREE: this runs in the worker, so it throws plain typed errors
 *     (`InboundIngestionError`) carrying a `retryable` flag the worker uses to
 *     decide whether BullMQ should retry.
 *
 * The Claude extraction (lib/ai/claude-extraction.provider.ts), R2 storage
 * (lib/storage/r2.ts), and the analyze:listing enqueue (lib/queue) live in OTHER
 * modules. This service depends on their INTERFACES only, injected via deps, so
 * it is unit-testable with fakes and never imports bullmq / the Anthropic SDK.
 */
import type { EmailAuthVerdict, ListingSource } from "@prisma/client";
import { normalisePostcode, normaliseOutcode } from "@homeranger/shared";
import { runTransaction } from "../lib/prisma.js";
import { extractReplyText, firstHttpUrl } from "../lib/inbound/reply-text.js";
import {
  consumeToken as defaultConsumeToken,
  type ConsumeTokenInput,
  type ConsumeTokenResult,
} from "../lib/rate-limit/redis-token-bucket.js";
import {
  listingRepository,
  type ListingRepository,
  type UpsertListingByAddressInput,
} from "../repositories/listing.repository.js";
import {
  listingSourceRecordRepository,
  type ListingSourceRecordRepository,
} from "../repositories/listing-source-record.repository.js";
import { dedupService, type DedupService } from "./dedup.service.js";

/**
 * Decoded attachment as it reaches the service — the worker has already pulled
 * the bytes (Resend inbound webhooks carry metadata only; the worker hydrates
 * via the Received-Emails / Attachments API → Buffer → R2). `storedUrl` is the
 * R2 object URL the worker wrote; `buffer` is the in-memory bytes for the
 * extractor's Claude document/image blocks.
 */
export interface DecodedAttachment {
  fileName: string;
  mimeType: string;
  byteSize: number;
  buffer: Buffer;
  storedUrl: string | null;
}

/** The hydrated inbound email the worker hands the service. */
export interface InboundEmailPayload {
  /** Resend `data.email_id` — the stable external id + idempotency anchor. */
  messageId: string;
  receivedAt: Date;
  recipientEmail: string;
  senderEmail: string;
  senderName: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  spfVerdict: EmailAuthVerdict;
  dkimVerdict: EmailAuthVerdict;
  attachments: DecodedAttachment[];
}

/**
 * What the extractor returns — listing fields + listingUrl from the free text +
 * PDF/image. `pricePence` is integer pence (never float). Every field is
 * nullable. Enums are the canonical snake_case tuples. `embedding` is optional
 * (M5 supplies it; M4 leaves it absent so dedup is exact-match-only).
 */
export interface ExtractedListing {
  addressRaw: string | null;
  postcode: string | null;
  outcode: string | null;
  pricePence: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  tenure: ExtractedListingTenure | null;
  propertyType: ExtractedListingPropertyType | null;
  epcRating: ExtractedListingEpc | null;
  listingStatus: ExtractedListingStatus | null;
  listingUrl: string | null;
  confidence: number | null;
  embedding?: number[];
}

type ExtractedListingTenure =
  | "freehold"
  | "leasehold"
  | "share_of_freehold"
  | "commonhold"
  | "unknown";
type ExtractedListingPropertyType =
  | "detached"
  | "semi_detached"
  | "terraced"
  | "flat"
  | "maisonette"
  | "bungalow"
  | "cottage"
  | "land"
  | "other"
  | "unknown";
type ExtractedListingEpc = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "unknown";
type ExtractedListingStatus =
  | "pre_market"
  | "live"
  | "under_offer"
  | "sold"
  | "withdrawn";

/** The extractor interface the service depends on (concrete impl is lib/ai). */
export interface ListingExtractionProvider {
  extract(input: {
    bodyText: string | null;
    bodyHtml: string | null;
    subject: string | null;
    fromAddress?: string | null;
    attachments: DecodedAttachment[];
  }): Promise<ExtractedListing>;
}

/** The queue surface the service enqueues onto (concrete impl is lib/queue). */
export interface AnalyzeListingEnqueuer {
  enqueueAnalyzeListing(listingId: string): Promise<void>;
}

export interface IngestInboundEmailResult {
  listingId: string;
  created: boolean;
  matchedBy: "exact" | "embedding" | null;
  sourceRecordId: string;
}

export interface InboundIngestionService {
  ingestInboundEmail(
    payload: InboundEmailPayload,
  ): Promise<IngestInboundEmailResult>;
}

interface InboundIngestionServiceDependencies {
  extractionProvider?: ListingExtractionProvider;
  dedupService?: DedupService;
  analyzeListingEnqueuer?: AnalyzeListingEnqueuer;
  listingRepository?: ListingRepository;
  listingSourceRecordRepository?: ListingSourceRecordRepository;
  /** Budget guardrails — default to the real Redis token bucket + env config. */
  consumeToken?: (input: ConsumeTokenInput) => Promise<ConsumeTokenResult>;
  maxInputChars?: number;
  dailyExtractionCap?: number;
  now?: () => Date;
}

/** Positive integer env var with a fallback (mirrors compliance-guard's intEnv). */
function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** A typed, transport-free error. `retryable` drives the worker's retry call. */
export class InboundIngestionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "InboundIngestionError";
    this.retryable = retryable;
  }
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export class DefaultInboundIngestionService implements InboundIngestionService {
  private readonly extractionProvider: ListingExtractionProvider | null;
  private readonly dedupService: DedupService;
  private readonly analyzeListingEnqueuer: AnalyzeListingEnqueuer | null;
  private readonly listingRepository: ListingRepository;
  private readonly listingSourceRecordRepository: ListingSourceRecordRepository;
  private readonly consumeToken: (
    input: ConsumeTokenInput,
  ) => Promise<ConsumeTokenResult>;
  private readonly maxInputChars: number;
  private readonly dailyExtractionCap: number;
  private readonly now: () => Date;

  constructor(deps: InboundIngestionServiceDependencies = {}) {
    // extractionProvider + analyzeListingEnqueuer have NO universal default
    // singleton in backend-core (the concrete impls live in lib/ai + lib/queue
    // and are wired by the worker), so they are nullable and the worker MUST
    // inject them. A null at call time is a programming error → non-retryable.
    this.extractionProvider = deps.extractionProvider ?? null;
    this.dedupService = deps.dedupService ?? dedupService;
    this.analyzeListingEnqueuer = deps.analyzeListingEnqueuer ?? null;
    this.listingRepository = deps.listingRepository ?? listingRepository;
    this.listingSourceRecordRepository =
      deps.listingSourceRecordRepository ?? listingSourceRecordRepository;
    this.consumeToken = deps.consumeToken ?? defaultConsumeToken;
    this.maxInputChars =
      deps.maxInputChars ?? intEnv("EXTRACTION_MAX_INPUT_CHARS", 20_000);
    this.dailyExtractionCap =
      deps.dailyExtractionCap ?? intEnv("EXTRACTION_DAILY_CAP", 1_000);
    this.now = deps.now ?? (() => new Date());
  }

  /** UTC date (YYYY-MM-DD) — the daily extraction-budget bucket key. */
  private windowKey(): string {
    const d = this.now();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${d.getUTCFullYear()}-${month}-${day}`;
  }

  async ingestInboundEmail(
    payload: InboundEmailPayload,
  ): Promise<IngestInboundEmailResult> {
    if (!this.extractionProvider) {
      throw new InboundIngestionError(
        "ListingExtractionProvider not injected",
        false,
      );
    }
    if (!this.analyzeListingEnqueuer) {
      throw new InboundIngestionError(
        "AnalyzeListingEnqueuer not injected",
        false,
      );
    }

    // Strip the quoted original outreach so the extractor sees only what the
    // agent actually wrote (incl. any listing link) — not the buyer-enquiry
    // quote. A cold (non-reply) listing email has no quote → unchanged. Capped
    // to bound a single runaway email's INPUT tokens (max_output is already set).
    const replyText = extractReplyText(payload.bodyText).slice(
      0,
      this.maxInputChars,
    );

    // Budget guardrail: a fixed-window DAILY cap on paid extraction calls so a
    // flood of inbound email can never blow the Anthropic budget. Fail-closed: a
    // genuine cap hit DROPS (non-retryable — the cap will not clear on a same-day
    // retry); a bucket OUTAGE retries (the paid call never happened).
    //
    // DELIBERATE TRADEOFF — do NOT "fix" without reading this: the token is
    // consumed BEFORE the extract call and is NOT keyed per messageId, so a
    // transient Claude 5xx that retries (BullMQ attempts:3) re-consumes, up to
    // 3 tokens for one email. Worst case 3×N vs the 1000/day default — fine for
    // a single-tenant tool. The sharp edge: an email hitting a transient error
    // exactly as the cap fills can be dropped (listing lost) despite never
    // extracting. We accept that over a per-message idempotency key (extra Redis
    // round-trip + key sprawl) because the cap is generous and the drop is
    // logged (inbound.dropped.non_retryable) for operator visibility.
    const budget = await this.consumeToken({
      key: `extraction:daily:${this.windowKey()}`,
      cap: this.dailyExtractionCap,
      windowSeconds: 86_400,
      reserve: true,
    });
    if (!budget.available) {
      throw new InboundIngestionError(
        "extraction budget bucket unavailable",
        true,
      );
    }
    if (!budget.allowed) {
      throw new InboundIngestionError(
        "extraction daily cap exceeded — dropping to protect the API budget",
        false,
      );
    }

    const extracted = await this.extractionProvider.extract({
      bodyText: replyText,
      bodyHtml: payload.bodyHtml,
      subject: payload.subject,
      fromAddress: payload.senderEmail,
      attachments: payload.attachments,
    });

    // Resolve the clickable source link ONCE — the LLM's listingUrl, else the
    // first http(s) link in the agent's reply — so the Listing and its
    // provenance source-record always agree on the URL.
    const resolvedListingUrl = extracted.listingUrl ?? firstHttpUrl(replyText);

    const dedup = await this.dedupService.find({
      addressRaw: extracted.addressRaw,
      postcode: extracted.postcode,
      embedding: extracted.embedding,
    });

    // The canonical key is the dedup result's addressNormalized when present;
    // when the extractor produced no keyable address we fall back to a
    // message-scoped synthetic key so the upsert still has a unique anchor and
    // a re-delivery of the SAME email re-keys identically (idempotent).
    const addressNormalized =
      dedup.addressNormalized ?? `agent_email:${payload.messageId}`;

    const canonicalPostcode = extracted.postcode
      ? normalisePostcode(extracted.postcode)
      : null;
    const outcode = extracted.outcode
      ? normaliseOutcode(extracted.outcode)
      : extracted.postcode
        ? normaliseOutcode(extracted.postcode)
        : null;

    // The mutable Listing fields, shared by the create (upsertByAddress) and the
    // merge (updateById) branches below.
    const mutableFields: Omit<UpsertListingByAddressInput, "addressNormalized"> = {
      postcode: canonicalPostcode,
      outcode,
      pricePence: extracted.pricePence,
      bedrooms: extracted.bedrooms,
      tenure: extracted.tenure,
      propertyType: extracted.propertyType,
      epcRating: extracted.epcRating,
      // Email-only listings are pre-market by definition (not on a portal).
      listingStatus: "pre_market",
      isPreMarket: true,
      listingUrl: resolvedListingUrl,
      primarySource: "agent_email" satisfies ListingSource,
      // Sending-agent capture (Searches PR2): the per-agency follow-up groups by
      // these. The sender email is the keying identity; the display name (when
      // present) is the friendly agency label the listings Agent column shows.
      agentEmail: normaliseEmail(payload.senderEmail),
      agencyName: payload.senderName ?? null,
    };

    // Listing upsert + provenance source-record share ONE transaction so a
    // partial write never leaves a Listing without its agent_email source.
    const { listing, sourceRecord } = await runTransaction(async (tx) => {
      // Drive the write target from the dedup RESULT, not the candidate key.
      // When dedup found an existing listing (exact OR embedding) we MERGE into
      // that row by id — the embedding fallback returns the existing listing's
      // id whose addressNormalized differs from the candidate's, so upserting on
      // the candidate key would INSERT a duplicate. Only when no match was found
      // (dedup.listingId === null) do we upsert by the (possibly synthetic) key.
      const upserted =
        dedup.listingId !== null
          ? await this.listingRepository.updateById(
              dedup.listingId,
              mutableFields,
              tx,
            )
          : await this.listingRepository.upsertByAddress(
              { addressNormalized, ...mutableFields },
              tx,
            );

      // Provenance: idempotent on (sourceType, externalId=email_id) — a
      // redelivered inbound webhook re-keys to the SAME source record (no dup).
      const source = await this.listingSourceRecordRepository.upsert(
        {
          listingId: upserted.id,
          sourceType: "agent_email" satisfies ListingSource,
          externalId: payload.messageId,
          sourceUrl: resolvedListingUrl,
          rawPayload: {
            senderEmail: normaliseEmail(payload.senderEmail),
            subject: payload.subject,
            spfVerdict: payload.spfVerdict,
            dkimVerdict: payload.dkimVerdict,
            attachmentUrls: payload.attachments
              .map((a) => a.storedUrl)
              .filter((u): u is string => u !== null),
          },
        },
        tx,
      );

      return { listing: upserted, sourceRecord: source };
    });

    // Best-effort embedding write (the dedup fallback + M5 scoring read it).
    if (extracted.embedding && extracted.embedding.length > 0) {
      await this.listingRepository.writeEmbedding(
        listing.id,
        extracted.embedding,
      );
    }

    // Hand off to the M5 analysis pipeline. Until M5 lands the consumer is a
    // registered no-op, so this enqueue is a safe forward-reference.
    await this.analyzeListingEnqueuer.enqueueAnalyzeListing(listing.id);

    return {
      listingId: listing.id,
      // `created` is inferred from dedup: a brand-new listing had no prior id.
      created: dedup.listingId === null,
      matchedBy: dedup.matchedBy,
      sourceRecordId: sourceRecord.id,
    };
  }
}

const defaultInboundIngestionService = new DefaultInboundIngestionService();

export let inboundIngestionService: InboundIngestionService =
  defaultInboundIngestionService;

export function _setInboundIngestionServiceForTesting(
  service: InboundIngestionService | null,
): void {
  inboundIngestionService = service ?? defaultInboundIngestionService;
}
