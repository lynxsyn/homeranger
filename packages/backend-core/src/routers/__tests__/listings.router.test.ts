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

function makeRow(overrides: Partial<ListingRecord> = {}): ListingRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "00000000-0000-7000-8000-000000000001",
    addressNormalized: "1 test street",
    postcode: null,
    outcode: "SE1",
    pricePence: 42_500_000,
    bedrooms: 2,
    tenure: null,
    propertyType: null,
    epcRating: null,
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://example.test/1",
    primarySource: "agent_email",
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Caller authenticated as the dev user. */
const authedCaller = appRouter.createCaller({ user: { email: "dev@homescout.local" } });

afterEach(() => {
  _setListingRepositoryForTesting(null);
  vi.restoreAllMocks();
});

describe("listingsRouter.list", () => {
  it("maps filter (status→listingStatus) + sort + cursor + limit to the repo and returns { items, nextCursor }", async () => {
    const row = makeRow();
    const fake = new ListingRepository();
    const listSpy = vi
      .spyOn(fake, "list")
      .mockResolvedValue({ items: [row], nextCursor: "CURSOR2" });
    _setListingRepositoryForTesting(fake);

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

    expect(result).toEqual({ items: [row], nextCursor: "CURSOR2" });
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

  it("defaults sortBy=combinedScore, sortDir=desc, limit=20 and omits filter when absent", async () => {
    const fake = new ListingRepository();
    const listSpy = vi
      .spyOn(fake, "list")
      .mockResolvedValue({ items: [], nextCursor: null });
    _setListingRepositoryForTesting(fake);

    const result = await authedCaller.listings.list({});
    expect(result).toEqual({ items: [], nextCursor: null });

    const arg = listSpy.mock.calls[0]![0] as ListListingsInput;
    expect(arg.filter).toBeUndefined();
    expect(arg.sort).toEqual({ sortBy: "combinedScore", sortDir: "desc" });
    expect(arg.limit).toBe(20);
    expect(arg.cursor).toBeUndefined();
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
  it("returns the M5 placeholder payload (nulls) for a known id", async () => {
    const row = makeRow();
    const fake = new ListingRepository();
    vi.spyOn(fake, "getById").mockResolvedValue(row);
    _setListingRepositoryForTesting(fake);

    const result = await authedCaller.listings.expand({ id: row.id });
    expect(result).toEqual({
      id: row.id,
      photoFeatures: null,
      combinedScore: null,
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

describe("listingsRouter auth", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.listings.list({})).rejects.toBeInstanceOf(TRPCError);
    await expect(anon.listings.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
