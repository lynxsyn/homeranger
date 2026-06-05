/**
 * ListingScrapeService — the orchestration core of the listing-site ingestion
 * path, consumed by the `scrape:listings` worker. It mirrors the M4 inbound
 * pipeline (extraction → dedup → upsert Listing + ListingSourceRecord → enqueue
 * analyze:listing) but the SOURCE is a public listing site, not an agent email.
 *
 * Layering (aide/rules/backend.md): this is a worker-side service — it owns NO
 * Prisma and is TRPCError-FREE. Every write goes through a repository singleton;
 * failures throw a transport-free `ListingScrapeError` carrying a `retryable`
 * flag the worker maps (!retryable → drop, retryable → BullMQ backoff).
 *
 * Variant-B lazy singleton (the provider is a required injected network client),
 * exactly like AgentDiscoveryService. The analyze enqueuer is injected so unit
 * tests can stub it (the concrete enqueueAnalyzeListing lives in lib/queue and
 * is wired by the worker), mirroring InboundIngestionService.
 *
 * Scraping only SOURCES + links out — extraction is MINIMAL (address + postcode
 * + price + source URL) per docs/compliance/listing-sourcing-basis.md.
 */
import type { ListingSource } from "@prisma/client";
import { normalisePostcode, normaliseOutcode } from "@homeranger/shared";
import {
  listingRepository as defaultListingRepository,
  type ListingRepository,
  type UpsertListingByAddressInput,
} from "../repositories/listing.repository.js";
import {
  listingSourceRecordRepository as defaultListingSourceRecordRepository,
  type ListingSourceRecordRepository,
} from "../repositories/listing-source-record.repository.js";
import {
  searchRepository as defaultSearchRepository,
  type SearchRepository,
} from "../repositories/search.repository.js";
import { dedupService as defaultDedupService, type DedupService } from "./dedup.service.js";
import {
  LISTING_SCRAPE_SITES,
  type ListingScrapeProvider,
  type ListingScrapeSite,
  type ScrapeListingsInput,
  type ScrapedListing,
} from "../lib/listing-scrape/listing-scrape.provider.js";

/**
 * A typed, transport-free error. `retryable` drives the worker's retry call;
 * `trpcCode` lets a router (if one ever surfaces this) map it. Mirrors
 * InboundIngestionError / ComplianceError.
 */
export class ListingScrapeError extends Error {
  readonly retryable: boolean;
  readonly trpcCode?: string;
  constructor(message: string, retryable: boolean, trpcCode?: string) {
    super(message);
    this.name = "ListingScrapeError";
    this.retryable = retryable;
    if (trpcCode !== undefined) {
      this.trpcCode = trpcCode;
    }
  }
}

/** Per-site outcome counts. `discovered === upserted + skipped`. */
export interface ScrapeResult {
  /** The site scraped. */
  site: ListingScrapeSite;
  /** Candidates returned by the provider. */
  scraped: number;
  /** Candidates upserted as Listings (new OR merged into an existing row). */
  upserted: number;
  /** Candidates skipped (no usable address / intra-batch dupe). */
  skipped: number;
}

/** The queue surface the service enqueues onto (concrete impl is lib/queue). */
export type AnalyzeEnqueuer = (listingId: string) => Promise<void>;

export interface ListingScrapeService {
  runScrape(input: ScrapeListingsInput): Promise<ScrapeResult>;
  runScheduledScrape(): Promise<ScrapeResult[]>;
}

export interface ListingScrapeDependencies {
  provider: ListingScrapeProvider;
  listingRepository?: ListingRepository;
  listingSourceRecordRepository?: ListingSourceRecordRepository;
  dedupService?: DedupService;
  searchRepository?: SearchRepository;
  /** Injected so unit tests can stub the analyze:listing enqueue. */
  enqueueAnalyze?: AnalyzeEnqueuer;
}

/** Parse the comma-list of ENABLED sites (default none — dormant until opted in). */
function parseEnabledSites(raw: string | undefined): ListingScrapeSite[] {
  const valid = new Set<ListingScrapeSite>(LISTING_SCRAPE_SITES);
  const enabled: ListingScrapeSite[] = [];
  for (const token of (raw ?? "").split(",")) {
    const t = token.trim() as ListingScrapeSite;
    if (valid.has(t) && !enabled.includes(t)) {
      enabled.push(t);
    }
  }
  return enabled;
}

export class DefaultListingScrapeService implements ListingScrapeService {
  private readonly provider: ListingScrapeProvider;
  private readonly listingRepository: ListingRepository;
  private readonly listingSourceRecordRepository: ListingSourceRecordRepository;
  private readonly dedupService: DedupService;
  private readonly searchRepository: SearchRepository;
  private readonly enqueueAnalyze: AnalyzeEnqueuer | null;

  constructor(deps: ListingScrapeDependencies) {
    this.provider = deps.provider;
    this.listingRepository = deps.listingRepository ?? defaultListingRepository;
    this.listingSourceRecordRepository =
      deps.listingSourceRecordRepository ?? defaultListingSourceRecordRepository;
    this.dedupService = deps.dedupService ?? defaultDedupService;
    this.searchRepository = deps.searchRepository ?? defaultSearchRepository;
    // No universal default enqueuer in backend-core (the concrete impl lives in
    // lib/queue + is wired by the worker), so it is nullable and the worker MUST
    // inject it. A null at call time is a programming error → non-retryable.
    this.enqueueAnalyze = deps.enqueueAnalyze ?? null;
  }

  async runScrape(input: ScrapeListingsInput): Promise<ScrapeResult> {
    if (!this.enqueueAnalyze) {
      throw new ListingScrapeError("AnalyzeEnqueuer not injected", false);
    }

    // Provider failures: a transient scrape error (429/5xx) is retryable; a
    // config error (missing key / disabled site) is not. The provider sets a
    // `retryable` flag on its thrown Error — honour it; default unknown errors
    // to retryable (transient-safe), mirroring discovery's worker-error mapping.
    let candidates: ScrapedListing[];
    try {
      candidates = await this.provider.scrape(input);
    } catch (error) {
      throw this.wrapProviderError(error);
    }

    let upserted = 0;
    let skipped = 0;
    // `skipped` folds intra-batch duplicates + malformed (no keyable address)
    // candidates, so scraped === upserted + skipped regardless of provider dedup.
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const addressRaw = candidate.addressRaw?.trim() ?? "";
      const postcode = candidate.postcode?.trim() || null;
      // Canonical key — built with the SAME helper DedupService uses, so the key
      // we (potentially) upsert on matches what dedup looked up.
      const addressNormalized = this.dedupService.normaliseAddress(
        addressRaw,
        postcode,
      );
      if (!addressNormalized) {
        skipped += 1; // no keyable address — never persisted
        continue;
      }
      if (seen.has(addressNormalized)) {
        skipped += 1; // intra-batch duplicate
        continue;
      }
      seen.add(addressNormalized);

      const canonicalPostcode = postcode ? normalisePostcode(postcode) : null;
      const outcode = canonicalPostcode
        ? normaliseOutcode(canonicalPostcode)
        : postcode
          ? normaliseOutcode(postcode)
          : null;

      // The mutable Listing fields, shared by the create (upsertByAddress) and
      // the merge (updateById) branches below. Scraped listings link OUT to a
      // live portal page — they are NOT pre-market (an agent off-market tip is).
      const mutableFields: Omit<UpsertListingByAddressInput, "addressNormalized"> =
        {
          postcode: canonicalPostcode,
          outcode,
          pricePence: candidate.pricePence ?? null,
          // Minimal extraction — the source site holds the rest.
          bedrooms: null,
          tenure: null,
          propertyType: null,
          epcRating: null,
          listingStatus: "live",
          isPreMarket: false,
          listingUrl: candidate.sourceUrl,
          imageUrl: candidate.imageUrl ?? null,
          primarySource: input.site satisfies ListingSource,
          // No sending agent for a scraped listing.
          agentEmail: null,
          agencyName: null,
        };

      // Dedup: an existing listing (exact OR embedding) is MERGED by id; a new
      // one is upserted on its canonical key. The embedding fallback returns the
      // existing listing's id whose addressNormalized differs from the
      // candidate's, so upserting on the candidate key would INSERT a duplicate.
      //
      // The two DB writes AND the analyze enqueue share ONE fate inside this
      // try: any failure (a DB blip OR a Redis/BullMQ enqueue error) throws a
      // retryable ListingScrapeError so the whole job retries (the upserts are
      // idempotent on addressNormalized / (sourceType, externalId), so a retry is
      // safe). `upserted` is incremented only once the listing is fully persisted
      // AND queued, so the count never overstates.
      try {
        const dedup = await this.dedupService.find({ addressRaw, postcode });
        const listing =
          dedup.listingId !== null
            ? await this.listingRepository.updateById(dedup.listingId, mutableFields)
            : await this.listingRepository.upsertByAddress({
                addressNormalized,
                ...mutableFields,
              });

        // Provenance: idempotent on (sourceType, externalId) — re-scraping the
        // same listing re-keys to the SAME source record (no duplicate).
        await this.listingSourceRecordRepository.upsert({
          listingId: listing.id,
          sourceType: input.site satisfies ListingSource,
          externalId: candidate.externalId,
          sourceUrl: candidate.sourceUrl,
          rawPayload: {
            addressRaw,
            postcode: canonicalPostcode,
            pricePence: candidate.pricePence ?? null,
          },
        });

        // Hand off to the analysis pipeline (embed + per-search re-score).
        await this.enqueueAnalyze(listing.id);
      } catch (error) {
        // A repo write OR enqueue failure is transient (DB/Redis blip) — retry
        // the whole job; the idempotent upserts make the retry safe.
        throw new ListingScrapeError(
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
      upserted += 1;
    }

    console.info(
      JSON.stringify({
        type: "info",
        scope: "listing-scrape.done",
        site: input.site,
        scraped: candidates.length,
        upserted,
        skipped,
      }),
    );
    return { site: input.site, scraped: candidates.length, upserted, skipped };
  }

  async runScheduledScrape(): Promise<ScrapeResult[]> {
    // Resolve the target patch = the union of every ACTIVE OPERATOR search's
    // outcodes (operator ownerKey is null). The scheduler has no DB, so the
    // PROCESSOR resolves the patch here at run time.
    const outcodes = await this.resolveTargetOutcodes();
    const enabledSites = parseEnabledSites(process.env.LISTING_SCRAPE_SITES);

    if (outcodes.length === 0 || enabledSites.length === 0) {
      console.info(
        JSON.stringify({
          type: "info",
          scope: "listing-scrape.scheduled.noop",
          outcodes: outcodes.length,
          enabledSites: enabledSites.length,
        }),
      );
      return [];
    }

    const results: ScrapeResult[] = [];
    for (const site of enabledSites) {
      results.push(await this.runScrape({ site, outcodes }));
    }
    return results;
  }

  /** Dedup + upper-case the outcodes of every active operator search. */
  private async resolveTargetOutcodes(): Promise<string[]> {
    let searches;
    try {
      searches = await this.searchRepository.listActive(null);
    } catch (error) {
      // Reading the patch is a DB op — a blip is transient (retry the job).
      throw new ListingScrapeError(
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
    const seen = new Set<string>();
    const outcodes: string[] = [];
    for (const search of searches) {
      for (const raw of search.outcodes) {
        const code = raw.trim().toUpperCase();
        if (code.length > 0 && !seen.has(code)) {
          seen.add(code);
          outcodes.push(code);
        }
      }
    }
    return outcodes;
  }

  /**
   * Map a provider error to a ListingScrapeError. A config error (the provider
   * set `retryable: false`) is non-retryable (drop); a transient scrape error is
   * retryable; an unknown error defaults to retryable (transient-safe).
   */
  private wrapProviderError(error: unknown): ListingScrapeError {
    const message = error instanceof Error ? error.message : String(error);
    const flag = (error as { retryable?: unknown } | null)?.retryable;
    const retryable = typeof flag === "boolean" ? flag : true;
    return new ListingScrapeError(message, retryable);
  }
}

let singleton: ListingScrapeService | null = null;

export function getListingScrapeService(
  deps?: ListingScrapeDependencies,
): ListingScrapeService {
  if (deps) {
    singleton = new DefaultListingScrapeService(deps);
    return singleton;
  }
  if (!singleton) {
    throw new Error(
      "ListingScrapeService not initialised — call getListingScrapeService(deps) at worker boot",
    );
  }
  return singleton;
}

export function _setListingScrapeServiceForTesting(
  service: ListingScrapeService | null,
): void {
  singleton = service;
}
