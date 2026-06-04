/**
 * listingsRouter unit tests (M3 spec test plan, Unit rows).
 *
 * Pure unit: a fake ListingRepository is injected via the exported
 * `_setListingRepositoryForTesting`, and procedures are invoked through a
 * caller built with `appRouter.createCaller({ user: { email } })`. No DB.
 *
 * Asserts:
 *   - list maps the shared wire filter (status→listingStatus) + sort + cursor
 *     + limit onto the repository and returns `{ items, nextCursor }`.
 *   - getById returns the row; null → TRPCError NOT_FOUND.
 *   - expand returns the M5 placeholder; null → TRPCError NOT_FOUND.
 *   - protectedProcedure rejects an anonymous caller (ctx.user = null) with
 *     UNAUTHORIZED.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../index.js";
import {
  ListingRepository,
  _setListingRepositoryForTesting,
  type ListingRecord,
  type ListListingsInput,
} from "../../repositories/listing.repository.js";
import {
  PhotoAnalysisRepository,
  _setPhotoAnalysisRepositoryForTesting,
} from "../../repositories/photo-analysis.repository.js";
import {
  ListingScoreRepository,
  _setListingScoreRepositoryForTesting,
} from "../../repositories/listing-score.repository.js";
import {
  SavedListingRepository,
  _setSavedListingRepositoryForTesting,
} from "../../repositories/saved-listing.repository.js";
import {
  DismissedListingRepository,
  _setDismissedListingRepositoryForTesting,
} from "../../repositories/dismissed-listing.repository.js";
import {
  SearchRepository,
  _setSearchRepositoryForTesting,
} from "../../repositories/search.repository.js";

function makeRow(overrides: Partial<ListingRecord> = {}): ListingRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "00000000-0000-7000-8000-000000000001",
    addressNormalized: "1 test street",
    postcode: null,
    outcode: "SE1",
    pricePence: 42_500_000,
    bedrooms: 2,
    bathrooms: 1,
    tenure: null,
    propertyType: null,
    epcRating: null,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://example.test/1",
    primarySource: "agent_email",
    agentEmail: "agent@acme.test",
    agencyName: "Acme Estates",
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Caller authenticated as the dev operator. */
const authedCaller = appRouter.createCaller({
  user: { id: "00000000-0000-0000-0000-0000000000de", email: "dev@homeranger.local" },
});
/** A non-operator signed-in user → their own saved-listings namespace. */
const PARTNER_ID = "33333333-3333-4333-8333-333333333333";
const partnerCaller = appRouter.createCaller({
  user: { id: PARTNER_ID, email: "partner@homeranger.test" },
});

afterEach(() => {
  _setListingRepositoryForTesting(null);
  _setPhotoAnalysisRepositoryForTesting(null);
  _setListingScoreRepositoryForTesting(null);
  _setSavedListingRepositoryForTesting(null);
  _setDismissedListingRepositoryForTesting(null);
  _setSearchRepositoryForTesting(null);
  vi.restoreAllMocks();
});

/** Inject a fake SearchRepository so the searchId-lens ownership check resolves. */
function injectSearchRepo(found: boolean): SearchRepository {
  const fake = new SearchRepository();
  vi.spyOn(fake, "getById").mockResolvedValue(
    found ? ({ id: "owned" } as never) : null,
  );
  _setSearchRepositoryForTesting(fake);
  return fake;
}

/**
 * Inject a fake ListingScoreRepository whose `getCombinedScoresByListingIds`
 * resolves to `scores` — the router merges these onto each `list` row's
 * `combinedScore` (absent id → `null`). Every `list` test needs this so the
 * resolver does not fall through to the real Prisma-backed repo.
 */
function injectScoreRepo(scores: Map<string, number> = new Map()) {
  const fake = new ListingScoreRepository();
  const spy = vi
    .spyOn(fake, "getCombinedScoresByListingIds")
    .mockResolvedValue(scores);
  _setListingScoreRepositoryForTesting(fake);
  return spy;
}

describe("listingsRouter.list", () => {
  it("maps filter (status→listingStatus) + sort + cursor + limit to the repo and merges combinedScore", async () => {
    const row = makeRow();
    const fake = new ListingRepository();
    const listSpy = vi
      .spyOn(fake, "list")
      .mockResolvedValue({ items: [row], nextCursor: "CURSOR2" });
    _setListingRepositoryForTesting(fake);
    const scoreSpy = injectScoreRepo(new Map([[row.id, 0.62]]));

    const result = await authedCaller.listings.list({
      filter: {
        outcodes: ["se1"],
        maxPricePence: 60_000_000,
        minBedrooms: 2,
        status: "live",
      },
      sortBy: "price",
      sortDir: "asc",
      cursor: "CURSOR1",
      limit: 25,
    });

    // Each row carries its match score + derived agency label; the page
    // envelope is preserved. bathrooms + agentEmail pass through from the record.
    expect(result).toEqual({
      items: [
        { ...row, combinedScore: 0.62, agency: "Acme Estates" },
      ],
      nextCursor: "CURSOR2",
    });
    // agency = agencyName ?? agentEmail; bathrooms surfaced from the record.
    expect(result.items[0]!.agency).toBe("Acme Estates");
    expect(result.items[0]!.bathrooms).toBe(1);
    expect(scoreSpy).toHaveBeenCalledWith([row.id]);
    expect(listSpy).toHaveBeenCalledTimes(1);
    const arg = listSpy.mock.calls[0]![0] as ListListingsInput;
    expect(arg.filter).toEqual({
      outcodes: ["SE1"], // outcodeSchema upper-cases on parse
      maxPricePence: 60_000_000,
      minBedrooms: 2,
      listingStatus: "live", // renamed from `status`
    });
    expect(arg.sort).toEqual({ sortBy: "price", sortDir: "asc" });
    expect(arg.cursor).toBe("CURSOR1");
    expect(arg.limit).toBe(25);
  });

  it("attaches combinedScore per row — null when the listing has no score", async () => {
    const scored = makeRow({ id: "00000000-0000-7000-8000-00000000aaaa" });
    const unscored = makeRow({ id: "00000000-0000-7000-8000-00000000bbbb" });
    const fake = new ListingRepository();
    vi.spyOn(fake, "list").mockResolvedValue({
      items: [scored, unscored],
      nextCursor: null,
    });
    _setListingRepositoryForTesting(fake);
    injectScoreRepo(new Map([[scored.id, 0.9]]));

    const result = await authedCaller.listings.list({});
    expect(result.items.map((i) => i.combinedScore)).toEqual([0.9, null]);
  });

  it("derives agency = agencyName ?? agentEmail ?? null and surfaces bathrooms", async () => {
    const withName = makeRow({
      id: "00000000-0000-7000-8000-00000000c001",
      agencyName: "Acme Estates",
      agentEmail: "agent@acme.test",
      bathrooms: 2,
    });
    const emailOnly = makeRow({
      id: "00000000-0000-7000-8000-00000000c002",
      agencyName: null,
      agentEmail: "solo@agent.test",
      bathrooms: null,
    });
    const neither = makeRow({
      id: "00000000-0000-7000-8000-00000000c003",
      agencyName: null,
      agentEmail: null,
    });
    const fake = new ListingRepository();
    vi.spyOn(fake, "list").mockResolvedValue({
      items: [withName, emailOnly, neither],
      nextCursor: null,
    });
    _setListingRepositoryForTesting(fake);
    injectScoreRepo();

    const result = await authedCaller.listings.list({});
    expect(result.items.map((i) => i.agency)).toEqual([
      "Acme Estates", // agencyName wins
      "solo@agent.test", // falls back to agentEmail
      null, // both null → "—" on the client
    ]);
    expect(result.items.map((i) => i.bathrooms)).toEqual([2, null, 1]);
  });

  it("maps each filter field independently (partial filters)", async () => {
    const fake = new ListingRepository();
    const listSpy = vi
      .spyOn(fake, "list")
      .mockResolvedValue({ items: [], nextCursor: null });
    _setListingRepositoryForTesting(fake);
    injectScoreRepo();

    await authedCaller.listings.list({ filter: { outcodes: ["se1"] } });
    await authedCaller.listings.list({ filter: { maxPricePence: 9_000 } });
    await authedCaller.listings.list({ filter: { minBedrooms: 1 } });
    await authedCaller.listings.list({ filter: { status: "pre_market" } });

    const filters = listSpy.mock.calls.map(
      (c) => (c[0] as ListListingsInput).filter,
    );
    expect(filters[0]).toEqual({ outcodes: ["SE1"] });
    expect(filters[1]).toEqual({ maxPricePence: 9_000 });
    expect(filters[2]).toEqual({ minBedrooms: 1 });
    expect(filters[3]).toEqual({ listingStatus: "pre_market" });
  });

  it("defaults sortBy=combinedScore, sortDir=desc, limit=20 and omits filter when absent", async () => {
    const fake = new ListingRepository();
    const listSpy = vi
      .spyOn(fake, "list")
      .mockResolvedValue({ items: [], nextCursor: null });
    _setListingRepositoryForTesting(fake);
    injectScoreRepo();

    const result = await authedCaller.listings.list({});
    expect(result).toEqual({ items: [], nextCursor: null });

    const arg = listSpy.mock.calls[0]![0] as ListListingsInput;
    expect(arg.filter).toBeUndefined();
    expect(arg.sort).toEqual({ sortBy: "combinedScore", sortDir: "desc" });
    expect(arg.limit).toBe(20);
    expect(arg.cursor).toBeUndefined();
    expect(arg.searchId).toBeUndefined(); // unfiltered → MAX-across-searches lens
  });

  it("threads searchId to the repo + reads THAT search's score (not the MAX) when a search lens is active", async () => {
    const row = makeRow();
    const fake = new ListingRepository();
    const listSpy = vi
      .spyOn(fake, "list")
      .mockResolvedValue({ items: [row], nextCursor: null });
    _setListingRepositoryForTesting(fake);

    const fakeScore = new ListingScoreRepository();
    const maxSpy = vi
      .spyOn(fakeScore, "getCombinedScoresByListingIds")
      .mockResolvedValue(new Map());
    const perSearchSpy = vi
      .spyOn(fakeScore, "getCombinedScoresByListingIdsForSearch")
      .mockResolvedValue(new Map([[row.id, 0.81]]));
    _setListingScoreRepositoryForTesting(fakeScore);
    const searchSpy = vi.spyOn(injectSearchRepo(true), "getById");

    const SEARCH_ID = "00000000-0000-7000-8000-00000000f001";
    const result = await authedCaller.listings.list({ searchId: SEARCH_ID });

    // The lens is validated as one of the caller's own searches first.
    expect(searchSpy).toHaveBeenCalledWith(SEARCH_ID, null); // operator → null owner

    // The scoring lens reaches the repository's combinedScore sort path.
    expect((listSpy.mock.calls[0]![0] as ListListingsInput).searchId).toBe(SEARCH_ID);
    // The per-search read path is used, NOT the MAX-across-searches path.
    expect(perSearchSpy).toHaveBeenCalledWith([row.id], SEARCH_ID);
    expect(maxSpy).not.toHaveBeenCalled();
    expect(result.items[0]!.combinedScore).toBe(0.81);
  });

  it("rejects a searchId the caller does not own with NOT_FOUND (no score lookup)", async () => {
    const fake = new ListingRepository();
    const listSpy = vi
      .spyOn(fake, "list")
      .mockResolvedValue({ items: [], nextCursor: null });
    _setListingRepositoryForTesting(fake);
    injectScoreRepo();
    injectSearchRepo(false); // getById → null → not the caller's search

    await expect(
      authedCaller.listings.list({
        searchId: "00000000-0000-7000-8000-00000000f0ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The repo list is never reached when the lens is unauthorised.
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe("listingsRouter.getById", () => {
  it("returns the row", async () => {
    const row = makeRow();
    const fake = new ListingRepository();
    vi.spyOn(fake, "getById").mockResolvedValue(row);
    _setListingRepositoryForTesting(fake);

    const result = await authedCaller.listings.getById({ id: row.id });
    expect(result).toEqual(row);
  });

  it("throws TRPCError NOT_FOUND on an unknown id", async () => {
    const fake = new ListingRepository();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    _setListingRepositoryForTesting(fake);

    await expect(
      authedCaller.listings.getById({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listingsRouter.expand", () => {
  it("returns analysed photos + the hybrid match score for a known id", async () => {
    const row = makeRow();
    const fakeListings = new ListingRepository();
    vi.spyOn(fakeListings, "getById").mockResolvedValue(row);
    _setListingRepositoryForTesting(fakeListings);

    const fakePhotos = new PhotoAnalysisRepository();
    vi.spyOn(fakePhotos, "listByListingId").mockResolvedValue([
      {
        id: "p1",
        listingId: row.id,
        imageHash: "h1",
        imageUrl: "r2://b/h1",
        tasteScore: 82,
        featuresJson: { style: "modern", highlights: ["bay window"] },
        model: "claude-haiku-4-5",
        costPence: 4,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    _setPhotoAnalysisRepositoryForTesting(fakePhotos);

    const fakeScore = new ListingScoreRepository();
    vi.spyOn(fakeScore, "getBestByListingId").mockResolvedValue({
      id: "s1",
      listingId: row.id,
      searchId: "00000000-0000-7000-8000-0000000000a1",
      vectorScore: 0.8,
      llmScore: 0.5,
      combinedScore: 0.62,
      rationale: "Modern and bright.",
      scoredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    _setListingScoreRepositoryForTesting(fakeScore);

    const result = await authedCaller.listings.expand({ id: row.id });
    expect(result.id).toBe(row.id);
    expect(result.photos).toHaveLength(1);
    expect(result.photos[0]).toEqual({
      imageUrl: "r2://b/h1",
      tasteScore: 82,
      features: { style: "modern", highlights: ["bay window"] },
    });
    expect(result.combinedScore).toBeCloseTo(0.62);
    expect(result.vectorScore).toBeCloseTo(0.8);
    expect(result.llmScore).toBeCloseTo(0.5);
    expect(result.scoreRationale).toBe("Modern and bright.");
  });

  it("returns empty photos + null scores for an un-analysed listing", async () => {
    const row = makeRow();
    const fakeListings = new ListingRepository();
    vi.spyOn(fakeListings, "getById").mockResolvedValue(row);
    _setListingRepositoryForTesting(fakeListings);

    const fakePhotos = new PhotoAnalysisRepository();
    vi.spyOn(fakePhotos, "listByListingId").mockResolvedValue([]);
    _setPhotoAnalysisRepositoryForTesting(fakePhotos);

    const fakeScore = new ListingScoreRepository();
    vi.spyOn(fakeScore, "getBestByListingId").mockResolvedValue(null);
    _setListingScoreRepositoryForTesting(fakeScore);

    const result = await authedCaller.listings.expand({ id: row.id });
    expect(result).toEqual({
      id: row.id,
      photos: [],
      combinedScore: null,
      vectorScore: null,
      llmScore: null,
      scoreRationale: null,
    });
  });

  it("throws TRPCError NOT_FOUND on an unknown id", async () => {
    const fake = new ListingRepository();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    _setListingRepositoryForTesting(fake);

    await expect(
      authedCaller.listings.expand({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listingsRouter.saved / save / unsave", () => {
  function injectSavedRepo(): SavedListingRepository {
    const fake = new SavedListingRepository();
    _setSavedListingRepositoryForTesting(fake);
    return fake;
  }

  it("hydrates the user's saved listing ids into rows (saved order) with scores", async () => {
    const saved = injectSavedRepo();
    const a = makeRow({ id: "00000000-0000-7000-8000-00000000d001" });
    const b = makeRow({ id: "00000000-0000-7000-8000-00000000d002" });
    // Saved newest-first = [b, a]; getByIds returns them in arbitrary order.
    const idsSpy = vi
      .spyOn(saved, "listSavedListingIds")
      .mockResolvedValue([b.id, a.id]);
    const fakeListings = new ListingRepository();
    vi.spyOn(fakeListings, "getByIds").mockResolvedValue([a, b]);
    _setListingRepositoryForTesting(fakeListings);
    injectScoreRepo(new Map([[b.id, 0.7]]));

    const result = await partnerCaller.listings.saved();

    expect(idsSpy).toHaveBeenCalledWith(PARTNER_ID);
    // Re-ordered to the saved order (b before a); scores merged.
    expect(result.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(result[0]!.combinedScore).toBe(0.7);
    expect(result[1]!.combinedScore).toBeNull();
  });

  it("save/unsave forward the listingId + owner key to the repo", async () => {
    const saved = injectSavedRepo();
    const saveSpy = vi.spyOn(saved, "save").mockResolvedValue(true);
    const unsaveSpy = vi.spyOn(saved, "unsave").mockResolvedValue(true);
    const listingId = "00000000-0000-7000-8000-00000000d010";

    expect(await partnerCaller.listings.save({ listingId })).toEqual({
      saved: true,
    });
    expect(await authedCaller.listings.unsave({ listingId })).toEqual({
      saved: false,
    });

    // Non-operator → their id; operator → null namespace.
    expect(saveSpy).toHaveBeenCalledWith(PARTNER_ID, listingId);
    expect(unsaveSpy).toHaveBeenCalledWith(null, listingId);
  });

  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.listings.saved()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("listingsRouter.dismissed / dismiss / restore", () => {
  function injectDismissedRepo(): DismissedListingRepository {
    const fake = new DismissedListingRepository();
    _setDismissedListingRepositoryForTesting(fake);
    return fake;
  }

  it("hydrates the user's dismissed listing ids into rows (dismissed order) with scores", async () => {
    const dismissed = injectDismissedRepo();
    const a = makeRow({ id: "00000000-0000-7000-8000-00000000e001" });
    const b = makeRow({ id: "00000000-0000-7000-8000-00000000e002" });
    // Dismissed newest-first = [b, a]; getByIds returns them in arbitrary order.
    const idsSpy = vi
      .spyOn(dismissed, "listDismissedListingIds")
      .mockResolvedValue([b.id, a.id]);
    const fakeListings = new ListingRepository();
    vi.spyOn(fakeListings, "getByIds").mockResolvedValue([a, b]);
    _setListingRepositoryForTesting(fakeListings);
    injectScoreRepo(new Map([[b.id, 0.4]]));

    const result = await partnerCaller.listings.dismissed();

    expect(idsSpy).toHaveBeenCalledWith(PARTNER_ID);
    expect(result.map((r) => r.id)).toEqual([b.id, a.id]); // dismissed order
    expect(result[0]!.combinedScore).toBe(0.4);
    expect(result[1]!.combinedScore).toBeNull();
  });

  it("dismiss/restore forward the listingId + owner key to the repo", async () => {
    const dismissed = injectDismissedRepo();
    const dismissSpy = vi.spyOn(dismissed, "dismiss").mockResolvedValue(true);
    const restoreSpy = vi.spyOn(dismissed, "restore").mockResolvedValue(true);
    const listingId = "00000000-0000-7000-8000-00000000e010";

    expect(await partnerCaller.listings.dismiss({ listingId })).toEqual({
      dismissed: true,
    });
    expect(await authedCaller.listings.restore({ listingId })).toEqual({
      dismissed: false,
    });

    // Non-operator → their id; operator → null namespace.
    expect(dismissSpy).toHaveBeenCalledWith(PARTNER_ID, listingId);
    expect(restoreSpy).toHaveBeenCalledWith(null, listingId);
  });

  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.listings.dismissed()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("listingsRouter auth", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.listings.list({})).rejects.toBeInstanceOf(TRPCError);
    await expect(anon.listings.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
