/**
 * sourcesRouter unit tests. Pure unit: a real `new ListingSourceRecordRepository()`
 * is injected via `_setListingSourceRecordRepositoryForTesting` (the router reads
 * the live singleton as an ESM live binding), then spied with `vi.spyOn` on the
 * two telemetry methods the router calls (`countBySourceType` /
 * `latestObservedBySourceType`). Procedures run through `appRouter.createCaller`.
 * No DB.
 *
 * Asserts:
 *   - auth (the INVERSE of agents): anon → UNAUTHORIZED; a NON-operator authed
 *     caller SUCCEEDS (protectedProcedure admits any authed user, NOT FORBIDDEN).
 *   - the catalogue rows in order ["auctionhouse","pughauctions","uklandandfarms"]
 *     (pugh = a NATIONAL source → "Nationwide" coverage, no outcode chips).
 *   - lotsFound / latestObservedAt join (present → value; absent → 0 / null).
 *   - coverage derives from REGION_TAXONOMY (LL2/LL3); no agent_email/manual row.
 *   - toCoverageLabel: first-alias title-case + empty-alias "" branch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../index.js";
import {
  toCoverageLabel,
  _setScrapeListingsEnqueuerForTesting,
} from "../sources.router.js";
import {
  ListingSourceRecordRepository,
  _setListingSourceRecordRepositoryForTesting,
} from "../../repositories/listing-source-record.repository.js";
import type { ListingSource } from "@prisma/client";

// A NON-operator signed-in user → protectedProcedure must ADMIT (NOT forbid):
// sources are a global catalogue, unlike the operator-only agent pool.
const partnerCaller = appRouter.createCaller({
  user: {
    id: "33333333-3333-4333-8333-333333333333",
    email: "partner@homeranger.test",
  },
});

// dev@homeranger.local is the default operator → ownerKeyFor resolves to null, so
// operatorProcedure admits it (requires OPERATOR_USER_EMAIL UNSET, as in CI).
const operatorCaller = appRouter.createCaller({
  user: {
    id: "00000000-0000-0000-0000-0000000000de",
    email: "dev@homeranger.local",
  },
});

function injectRepo(opts: {
  counts?: Map<ListingSource, number>;
  latest?: Map<ListingSource, Date>;
}) {
  const repo = new ListingSourceRecordRepository();
  const countSpy = vi
    .spyOn(repo, "countBySourceType")
    .mockResolvedValue(opts.counts ?? new Map());
  const latestSpy = vi
    .spyOn(repo, "latestObservedBySourceType")
    .mockResolvedValue(opts.latest ?? new Map());
  _setListingSourceRecordRepositoryForTesting(repo);
  return { countSpy, latestSpy };
}

afterEach(() => {
  _setListingSourceRecordRepositoryForTesting(null);
  _setScrapeListingsEnqueuerForTesting(null);
  vi.restoreAllMocks();
});

describe("sourcesRouter auth", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    injectRepo({});
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.sources.list()).rejects.toBeInstanceOf(TRPCError);
    await expect(anon.sources.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("ADMITS a non-operator authed caller (global catalogue, not operator-only)", async () => {
    injectRepo({});
    const rows = await partnerCaller.sources.list();
    expect(Array.isArray(rows)).toBe(true);
    // The inverse of agents: a non-operator is NOT forbidden here.
  });
});

describe("sourcesRouter.list rows", () => {
  it("returns the catalogue rows in order with the telemetry join applied", async () => {
    const { countSpy, latestSpy } = injectRepo({
      counts: new Map<ListingSource, number>([["auctionhouse", 5]]),
      latest: new Map<ListingSource, Date>([
        ["auctionhouse", new Date("2026-06-01T00:00:00.000Z")],
      ]),
    });

    const rows = await partnerCaller.sources.list();

    expect(rows.map((r) => r.id)).toEqual([
      "auctionhouse",
      "pughauctions",
      "uklandandfarms",
    ]);
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(latestSpy).toHaveBeenCalledTimes(1);

    // Row 0: present in BOTH Maps → real values.
    expect(rows[0]).toMatchObject({
      id: "auctionhouse",
      name: "Auction House",
      kind: "auction",
      domain: "auctionhouse.co.uk",
      lotsFound: 5,
      coverageOutcodes: ["LL2", "LL3"],
      coverageLabel: "North Wales",
    });
    expect(rows[0]!.latestObservedAt).toEqual(
      new Date("2026-06-01T00:00:00.000Z"),
    );

    // Row 1: Pugh — a NATIONAL catalogue → "Nationwide" coverage, no outcode chips.
    expect(rows[1]).toMatchObject({
      id: "pughauctions",
      name: "Pugh Auctions",
      kind: "auction",
      domain: "pugh-auctions.com",
      lotsFound: 0,
      coverageOutcodes: [],
      coverageLabel: "Nationwide",
    });
    expect(rows[1]!.latestObservedAt).toBeNull();

    // Row 2: ABSENT from both Maps → the `?? 0` / `?? null` defaults.
    expect(rows[2]).toMatchObject({
      id: "uklandandfarms",
      name: "UK Land & Farms",
      kind: "land",
      domain: "uklandandfarms.co.uk",
      lotsFound: 0,
      coverageOutcodes: ["LL2", "LL3"],
    });
    expect(rows[2]!.latestObservedAt).toBeNull();
  });

  it("never emits a non-crawled source (agent_email / manual)", async () => {
    injectRepo({});
    const rows = await partnerCaller.sources.list();
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("agent_email");
    expect(ids).not.toContain("manual");
  });
});

describe("toCoverageLabel", () => {
  it("title-cases the first alias", () => {
    expect(toCoverageLabel(["north wales", "conwy"])).toBe("North Wales");
  });

  it("returns an empty string for no aliases", () => {
    expect(toCoverageLabel([])).toBe("");
  });
});

describe("sourcesRouter.refresh", () => {
  it("operator enqueues a fieldless scrape:listings scan and echoes enqueued", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setScrapeListingsEnqueuerForTesting(enqueue);

    const result = await operatorCaller.sources.refresh();

    expect(result).toEqual({ enqueued: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      // fieldless payload → the processor runs runScheduledScrape() (all enabled
      // sites × active-search outcodes); per-minute key dedupes rapid clicks.
      idempotencyKey: expect.stringMatching(/^scrape:listings:manual:\d+$/),
      payload: {},
    });
  });

  it("forbids a non-operator caller and never enqueues", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setScrapeListingsEnqueuerForTesting(enqueue);

    await expect(partnerCaller.sources.refresh()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
