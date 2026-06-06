import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DefaultListingScrapeService,
  ListingScrapeError,
  getListingScrapeService,
  _setListingScrapeServiceForTesting,
} from "./listing-scrape.service.js";
import type { DedupResult, DedupService } from "./dedup.service.js";
import type { ListingRepository } from "../repositories/listing.repository.js";
import type { ListingSourceRecordRepository } from "../repositories/listing-source-record.repository.js";
import type { SearchRepository } from "../repositories/search.repository.js";
import type {
  ListingScrapeProvider,
  ScrapedListing,
} from "../lib/listing-scrape/listing-scrape.provider.js";

/**
 * A fake DedupService whose normaliseAddress builds an upper-cased key from the
 * address (so two distinct addresses key distinctly) and whose `find` resolves
 * a duplicate from a caller-supplied map keyed on the canonical key.
 */
function makeDedup(matches: Record<string, string> = {}): DedupService {
  const key = (addressRaw: string | null, postcode: string | null): string | null => {
    const street = (addressRaw ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    const pc = postcode ? postcode.toUpperCase().replace(/\s+/g, "") : "";
    const joined = [street, pc].filter(Boolean).join(" ").trim();
    return joined.length > 0 ? joined : null;
  };
  return {
    normaliseAddress: key,
    async find(candidate): Promise<DedupResult> {
      const addressNormalized = key(candidate.addressRaw, candidate.postcode);
      const hit = addressNormalized ? matches[addressNormalized] : undefined;
      return {
        listingId: hit ?? null,
        matchedBy: hit ? "exact" : null,
        addressNormalized,
      };
    },
  };
}

interface Harness {
  service: DefaultListingScrapeService;
  scrape: ReturnType<typeof vi.fn>;
  upsertByAddress: ReturnType<typeof vi.fn>;
  updateById: ReturnType<typeof vi.fn>;
  upsertSource: ReturnType<typeof vi.fn>;
  enqueueAnalyze: ReturnType<typeof vi.fn>;
  listActive: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  scraped?: ScrapedListing[];
  scrapeImpl?: () => Promise<ScrapedListing[]>;
  matches?: Record<string, string>;
  activeSearches?: Array<{ outcodes: string[] }>;
  listActiveImpl?: () => Promise<unknown>;
}): Harness {
  const scrape = opts.scrapeImpl
    ? vi.fn(opts.scrapeImpl)
    : vi.fn().mockResolvedValue(opts.scraped ?? []);
  // upsert/update echo a synthetic listing id derived from the call count.
  let n = 0;
  const upsertByAddress = vi.fn(async () => ({ id: `new-${++n}` }));
  const updateById = vi.fn(async (id: string) => ({ id }));
  const upsertSource = vi.fn(async () => ({ id: "src" }));
  const enqueueAnalyze = vi.fn(async () => undefined);
  const listActive = opts.listActiveImpl
    ? vi.fn(opts.listActiveImpl)
    : vi.fn().mockResolvedValue(opts.activeSearches ?? []);

  const service = new DefaultListingScrapeService({
    provider: { scrape } as unknown as ListingScrapeProvider,
    listingRepository: {
      upsertByAddress,
      updateById,
    } as unknown as ListingRepository,
    listingSourceRecordRepository: {
      upsert: upsertSource,
    } as unknown as ListingSourceRecordRepository,
    dedupService: makeDedup(opts.matches),
    searchRepository: { listActive } as unknown as SearchRepository,
    enqueueAnalyze,
  });
  return {
    service,
    scrape,
    upsertByAddress,
    updateById,
    upsertSource,
    enqueueAnalyze,
    listActive,
  };
}

function listing(over: Partial<ScrapedListing> = {}): ScrapedListing {
  return {
    externalId: "uklandandfarms-abc",
    sourceUrl: "https://uklandandfarms.example/listing/abc",
    addressRaw: "1 Oak Lane, Conwy",
    postcode: "LL30 1AA",
    pricePence: 65_000_000,
    imageUrl: "https://www.uklandandfarms.co.uk/images/abc.jpg",
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("ListingScrapeService.runScrape", () => {
  it("upserts a NEW listing (no dedup match) + source record + enqueues analyze", async () => {
    const h = makeHarness({ scraped: [listing()] });
    const result = await h.service.runScrape({
      site: "uklandandfarms",
      outcodes: ["LL30"],
    });

    // New listing → upsertByAddress (NOT updateById), keyed on the canonical key.
    expect(h.upsertByAddress).toHaveBeenCalledTimes(1);
    expect(h.updateById).not.toHaveBeenCalled();
    expect(h.upsertByAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        addressNormalized: "1 OAK LANE, CONWY LL301AA",
        postcode: "LL30 1AA",
        outcode: "LL30",
        pricePence: 65_000_000,
        listingStatus: "live",
        isPreMarket: false,
        listingUrl: "https://uklandandfarms.example/listing/abc",
        imageUrl: "https://www.uklandandfarms.co.uk/images/abc.jpg",
        primarySource: "uklandandfarms",
        agentEmail: null,
        agencyName: null,
      }),
    );
    // Source record upserted with (sourceType, externalId) idempotency anchor.
    expect(h.upsertSource).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: "new-1",
        sourceType: "uklandandfarms",
        externalId: "uklandandfarms-abc",
        sourceUrl: "https://uklandandfarms.example/listing/abc",
      }),
    );
    // analyze:listing enqueued for the new listing id.
    expect(h.enqueueAnalyze).toHaveBeenCalledWith("new-1");
    expect(result).toEqual({
      site: "uklandandfarms",
      scraped: 1,
      upserted: 1,
      skipped: 0,
    });
  });

  it("MERGES into an existing listing (dedup match) via updateById", async () => {
    const h = makeHarness({
      scraped: [listing()],
      matches: { "1 OAK LANE, CONWY LL301AA": "existing-9" },
    });
    const result = await h.service.runScrape({
      site: "uklandandfarms",
      outcodes: ["LL30"],
    });

    expect(h.updateById).toHaveBeenCalledTimes(1);
    expect(h.updateById).toHaveBeenCalledWith(
      "existing-9",
      expect.objectContaining({ primarySource: "uklandandfarms" }),
    );
    expect(h.upsertByAddress).not.toHaveBeenCalled();
    expect(h.upsertSource).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: "existing-9" }),
    );
    expect(h.enqueueAnalyze).toHaveBeenCalledWith("existing-9");
    expect(result.upserted).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("skips a candidate with no keyable address", async () => {
    const h = makeHarness({
      scraped: [listing({ addressRaw: "   ", postcode: undefined })],
    });
    const result = await h.service.runScrape({
      site: "uklandandfarms",
      outcodes: ["LL30"],
    });
    expect(h.upsertByAddress).not.toHaveBeenCalled();
    expect(h.upsertSource).not.toHaveBeenCalled();
    expect(h.enqueueAnalyze).not.toHaveBeenCalled();
    expect(result).toEqual({
      site: "uklandandfarms",
      scraped: 1,
      upserted: 0,
      skipped: 1,
    });
  });

  it("dedups duplicate addresses within a batch (counted once)", async () => {
    const h = makeHarness({
      scraped: [
        listing({ externalId: "a" }),
        listing({ externalId: "b" }), // same address → intra-batch dupe
      ],
    });
    const result = await h.service.runScrape({
      site: "uklandandfarms",
      outcodes: ["LL30"],
    });
    expect(h.upsertByAddress).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      site: "uklandandfarms",
      scraped: 2,
      upserted: 1,
      skipped: 1,
    });
  });

  it("maps a transient provider error to retryable=true", async () => {
    const boom = Object.assign(new Error("Firecrawl 503"), { retryable: true });
    const h = makeHarness({
      scrapeImpl: async () => {
        throw boom;
      },
    });
    await expect(
      h.service.runScrape({ site: "uklandandfarms", outcodes: ["LL30"] }),
    ).rejects.toMatchObject({ name: "ListingScrapeError", retryable: true });
  });

  it("maps a config provider error to retryable=false", async () => {
    const boom = Object.assign(new Error("listing scrape site not enabled"), {
      retryable: false,
    });
    const h = makeHarness({
      scrapeImpl: async () => {
        throw boom;
      },
    });
    await expect(
      h.service.runScrape({ site: "auctionhouse", outcodes: ["LL30"] }),
    ).rejects.toMatchObject({ name: "ListingScrapeError", retryable: false });
  });

  it("defaults an unknown provider error to retryable=true", async () => {
    const h = makeHarness({
      scrapeImpl: async () => {
        throw new Error("plain error, no retryable flag");
      },
    });
    await expect(
      h.service.runScrape({ site: "uklandandfarms", outcodes: ["LL30"] }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("maps a repo write failure to retryable=true", async () => {
    const h = makeHarness({ scraped: [listing()] });
    h.upsertByAddress.mockRejectedValueOnce(new Error("db down"));
    await expect(
      h.service.runScrape({ site: "uklandandfarms", outcodes: ["LL30"] }),
    ).rejects.toMatchObject({ name: "ListingScrapeError", retryable: true });
  });

  it("throws non-retryable when the analyze enqueuer is not injected", async () => {
    const service = new DefaultListingScrapeService({
      provider: {
        scrape: vi.fn().mockResolvedValue([listing()]),
      } as unknown as ListingScrapeProvider,
    });
    await expect(
      service.runScrape({ site: "uklandandfarms", outcodes: ["LL30"] }),
    ).rejects.toMatchObject({ name: "ListingScrapeError", retryable: false });
  });
});

describe("ListingScrapeService.runScheduledScrape", () => {
  const ORIGINAL = process.env.LISTING_SCRAPE_SITES;
  beforeEach(() => {
    delete process.env.LISTING_SCRAPE_SITES;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.LISTING_SCRAPE_SITES;
    } else {
      process.env.LISTING_SCRAPE_SITES = ORIGINAL;
    }
  });

  it("resolves the union of active operator searches' outcodes + loops enabled sites", async () => {
    process.env.LISTING_SCRAPE_SITES = "uklandandfarms,auctionhouse";
    const h = makeHarness({
      scraped: [listing()],
      activeSearches: [
        { outcodes: ["ll30", "LL31"] },
        { outcodes: ["LL31", " sw1a "] },
      ],
    });
    const results = await h.service.runScheduledScrape();

    // listActive(null) = active OPERATOR searches.
    expect(h.listActive).toHaveBeenCalledWith(null);
    // Both enabled sites scraped, each with the deduped, upper-cased outcode union.
    expect(h.scrape).toHaveBeenCalledTimes(2);
    expect(h.scrape).toHaveBeenCalledWith(
      expect.objectContaining({
        site: "uklandandfarms",
        outcodes: ["LL30", "LL31", "SW1A"],
      }),
    );
    expect(h.scrape).toHaveBeenCalledWith(
      expect.objectContaining({ site: "auctionhouse" }),
    );
    expect(results).toHaveLength(2);
  });

  it("is a no-op when there are no active-search outcodes", async () => {
    process.env.LISTING_SCRAPE_SITES = "uklandandfarms";
    const h = makeHarness({ activeSearches: [] });
    const results = await h.service.runScheduledScrape();
    expect(h.scrape).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("is a no-op when no sites are enabled (LISTING_SCRAPE_SITES unset)", async () => {
    const h = makeHarness({ activeSearches: [{ outcodes: ["LL30"] }] });
    const results = await h.service.runScheduledScrape();
    expect(h.scrape).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("maps a search-repo failure to retryable=true (never throws raw)", async () => {
    process.env.LISTING_SCRAPE_SITES = "uklandandfarms";
    const h = makeHarness({
      listActiveImpl: async () => {
        throw new Error("db blip");
      },
    });
    await expect(h.service.runScheduledScrape()).rejects.toMatchObject({
      name: "ListingScrapeError",
      retryable: true,
    });
  });
});

describe("getListingScrapeService", () => {
  afterEach(() => _setListingScrapeServiceForTesting(null));

  it("throws before initialisation", () => {
    _setListingScrapeServiceForTesting(null);
    expect(() => getListingScrapeService()).toThrow(/not initialised/);
  });

  it("returns the same instance after init", () => {
    const provider = {
      scrape: vi.fn(),
    } as unknown as ListingScrapeProvider;
    const first = getListingScrapeService({ provider });
    expect(getListingScrapeService()).toBe(first);
  });
});

describe("ListingScrapeError", () => {
  it("carries the retryable flag + optional trpcCode", () => {
    const e = new ListingScrapeError("boom", false, "BAD_REQUEST");
    expect(e.name).toBe("ListingScrapeError");
    expect(e.retryable).toBe(false);
    expect(e.trpcCode).toBe("BAD_REQUEST");
  });
});
