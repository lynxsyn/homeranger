/**
 * searchesRouter unit tests (M8). Pure unit: a fake SearchRepository is injected
 * via `_setSearchRepositoryForTesting`, and procedures are invoked through a
 * caller built with `appRouter.createCaller({ user })`. No DB.
 *
 * Asserts:
 *   - list / getById / create / update / delete / setStatus each map their
 *     input onto the repository and return its result.
 *   - getById + update map a missing id to TRPCError NOT_FOUND.
 *   - create / update forward the wire fields (outcodes are NOT passed — the
 *     repository derives them from location) and coerce optional nullable
 *     numerics to null.
 *   - protectedProcedure rejects an anonymous caller with UNAUTHORIZED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { appRouter } from "../index.js";
import {
  SearchRepository,
  _setSearchRepositoryForTesting,
  type SearchRecord,
} from "../../repositories/search.repository.js";
import {
  _setSearchComplianceGuardForTesting,
  _setSearchAgentRepositoryForTesting,
  _setSearchListingRepositoryForTesting,
  _setReviewProfileRepositoryForTesting,
  _setDiscoverAgentsEnqueuerForTesting,
  _setSearchOutreachSendEnqueuerForTesting,
  _setSearchRemovalCascadeForTesting,
  _setSearchRemovalPreviewerForTesting,
  _setSearchRecomputeTriggerForTesting,
} from "../searches.router.js";
import {
  AgentRepository,
  type AgentRecord,
} from "../../repositories/agent.repository.js";
import {
  SearchProfileRepository,
  type SearchProfileRecord,
} from "../../repositories/search-profile.repository.js";
import { ListingRepository } from "../../repositories/listing.repository.js";
import {
  ComplianceError,
  type ComplianceGuard,
} from "../../lib/compliance/compliance-guard.js";

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "00000000-0000-7000-8000-0000000000a1",
    email: "info@conwy-estates.co.uk",
    agencyName: "Conwy Estates",
    mailboxType: "corporate_subscriber",
    optedOut: false,
    coveredOutcodes: ["LL30"],
    lastContactedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as AgentRecord;
}

function makeProfile(
  overrides: Partial<SearchProfileRecord> = {},
): SearchProfileRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "00000000-0000-0000-0000-000000000001",
    freeTextPreferences: "",
    minBedrooms: null,
    maxPricePence: null,
    outcodes: [],
    requiredTenure: null,
    firstName: "",
    lastName: "",
    phone: "",
    urgency: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Inject a fake profile repo so reviewDrafts resolves a sender without a DB. */
function injectProfile(overrides: Partial<SearchProfileRecord> = {}): void {
  const repo = new SearchProfileRepository();
  vi.spyOn(repo, "getOrCreate").mockResolvedValue(makeProfile(overrides));
  _setReviewProfileRepositoryForTesting(repo);
}

function makeSearch(overrides: Partial<SearchRecord> = {}): SearchRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "00000000-0000-7000-8000-000000000001",
    name: "Conwy coast",
    location: "Conwy County",
    outcodes: ["LL30", "LL31"],
    types: ["Cottage"],
    condition: ["Restoration project"],
    land: [],
    saleMethods: ["Private treaty"],
    minBedrooms: 3,
    maxPricePence: 42_500_000,
    keywords: "sea views, character",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// dev@homeranger.local is the default operator → owner key resolves to null (the
// operator/default namespace), so the existing assertions see ownerId === null.
const authedCaller = appRouter.createCaller({
  user: { id: "00000000-0000-0000-0000-0000000000de", email: "dev@homeranger.local" },
});

// A non-operator signed-in user → owner key is their id (their own namespace).
const PARTNER_ID = "33333333-3333-4333-8333-333333333333";
const partnerCaller = appRouter.createCaller({
  user: { id: PARTNER_ID, email: "partner@homeranger.test" },
});

// Per-search match-scoring re-rank trigger. Set to a no-op spy so the operator
// create/update/setStatus paths don't hit a live queue, and tests can assert it.
let recomputeTriggerSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  recomputeTriggerSpy = vi.fn().mockResolvedValue(undefined);
  _setSearchRecomputeTriggerForTesting(
    recomputeTriggerSpy as unknown as (searchId: string) => Promise<void>,
  );
});

afterEach(() => {
  _setSearchRepositoryForTesting(null);
  _setSearchComplianceGuardForTesting(null);
  _setSearchAgentRepositoryForTesting(null);
  _setSearchListingRepositoryForTesting(null);
  _setReviewProfileRepositoryForTesting(null);
  _setDiscoverAgentsEnqueuerForTesting(null);
  _setSearchOutreachSendEnqueuerForTesting(null);
  _setSearchRemovalCascadeForTesting(null);
  _setSearchRemovalPreviewerForTesting(null);
  _setSearchRecomputeTriggerForTesting(null);
  vi.restoreAllMocks();
});

function injectRepo(): SearchRepository {
  const fake = new SearchRepository();
  _setSearchRepositoryForTesting(fake);
  return fake;
}

describe("searchesRouter.list", () => {
  it("returns every search from the repository", async () => {
    const fake = injectRepo();
    const searches = [makeSearch(), makeSearch({ id: "00000000-0000-7000-8000-000000000002" })];
    const spy = vi.spyOn(fake, "list").mockResolvedValue(searches);

    const result = await authedCaller.searches.list();
    expect(result).toEqual(searches);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("searchesRouter.getById", () => {
  it("returns the search", async () => {
    const fake = injectRepo();
    const search = makeSearch();
    vi.spyOn(fake, "getById").mockResolvedValue(search);

    const result = await authedCaller.searches.getById({ id: search.id });
    expect(result).toEqual(search);
  });

  it("throws TRPCError NOT_FOUND on an unknown id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);

    await expect(
      authedCaller.searches.getById({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("searchesRouter.create", () => {
  it("maps the wire fields to the repository (no outcodes passed) and returns the row", async () => {
    const fake = injectRepo();
    const created = makeSearch();
    const spy = vi.spyOn(fake, "create").mockResolvedValue(created);

    const result = await authedCaller.searches.create({
      name: "Conwy coast",
      location: "Conwy County",
      types: ["Cottage"],
      condition: ["Restoration project"],
      land: [],
      saleMethods: ["Private treaty"],
      minBedrooms: 3,
      maxPricePence: 42_500_000,
      keywords: "sea views, character",
      status: "active",
    });

    expect(result).toEqual(created);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0];
    // The router forwards the brief verbatim and never sets outcodes (the
    // repository derives them from `location`).
    expect(arg).not.toHaveProperty("outcodes");
    expect(arg).toMatchObject({
      name: "Conwy coast",
      location: "Conwy County",
      types: ["Cottage"],
      condition: ["Restoration project"],
      land: [],
      saleMethods: ["Private treaty"],
      minBedrooms: 3,
      maxPricePence: 42_500_000,
      keywords: "sea views, character",
      status: "active",
    });
  });

  it("coerces an omitted minBedrooms/maxPricePence to null", async () => {
    const fake = injectRepo();
    const spy = vi.spyOn(fake, "create").mockResolvedValue(makeSearch());

    await authedCaller.searches.create({ name: "Anywhere" });

    const arg = spy.mock.calls[0]![0];
    expect(arg.minBedrooms).toBeNull();
    expect(arg.maxPricePence).toBeNull();
    // Wire-schema defaults flowed through.
    expect(arg.location).toBe("");
    expect(arg.types).toEqual([]);
    expect(arg.saleMethods).toEqual(["Private treaty"]);
    expect(arg.status).toBe("active");
  });
});

describe("searchesRouter per-search recompute trigger", () => {
  it("fires the recompute for an OPERATOR's newly-created ACTIVE search", async () => {
    const fake = injectRepo();
    const created = makeSearch({ status: "active" });
    vi.spyOn(fake, "create").mockResolvedValue(created);

    await authedCaller.searches.create({
      name: "Conwy coast",
      keywords: "sea views",
      status: "active",
    });

    expect(recomputeTriggerSpy).toHaveBeenCalledWith(created.id);
  });

  it("does NOT fire for a PAUSED new search (paused searches don't score)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "create").mockResolvedValue(makeSearch({ status: "paused" }));

    await authedCaller.searches.create({ name: "Later", status: "paused" });

    expect(recomputeTriggerSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire for a NON-operator's search (scoring is the operator's engine)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "create").mockResolvedValue(makeSearch({ status: "active" }));

    await partnerCaller.searches.create({ name: "Mine", status: "active" });

    expect(recomputeTriggerSpy).not.toHaveBeenCalled();
  });

  it("fires when an operator RESUMES a search (setStatus → active) but not on pause", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "setStatus")
      .mockResolvedValueOnce(makeSearch({ status: "active" }))
      .mockResolvedValueOnce(makeSearch({ status: "paused" }));

    await authedCaller.searches.setStatus({ id: makeSearch().id, status: "active" });
    expect(recomputeTriggerSpy).toHaveBeenCalledTimes(1);

    await authedCaller.searches.setStatus({ id: makeSearch().id, status: "paused" });
    expect(recomputeTriggerSpy).toHaveBeenCalledTimes(1); // pause did not re-fire
  });

  it("does not fail the write when the recompute trigger throws (best-effort)", async () => {
    const fake = injectRepo();
    const created = makeSearch({ status: "active" });
    vi.spyOn(fake, "create").mockResolvedValue(created);
    recomputeTriggerSpy.mockRejectedValueOnce(new Error("queue down"));

    const result = await authedCaller.searches.create({
      name: "Conwy coast",
      status: "active",
    });

    expect(result).toEqual(created);
  });
});

describe("searchesRouter.update", () => {
  it("updates an existing search and returns the row", async () => {
    const fake = injectRepo();
    const existing = makeSearch();
    const updated = makeSearch({ name: "Renamed" });
    vi.spyOn(fake, "getById").mockResolvedValue(existing);
    const updateSpy = vi.spyOn(fake, "update").mockResolvedValue(updated);

    const result = await authedCaller.searches.update({
      id: existing.id,
      name: "Renamed",
      location: "Conwy County",
      types: ["Cottage"],
      condition: [],
      land: [],
      saleMethods: ["Private treaty"],
      minBedrooms: null,
      maxPricePence: null,
      keywords: "",
      status: "paused",
    });

    expect(result).toEqual(updated);
    const arg = updateSpy.mock.calls[0]![0];
    expect(arg).not.toHaveProperty("outcodes");
    expect(arg).toMatchObject({ id: existing.id, name: "Renamed", status: "paused" });
  });

  it("throws TRPCError NOT_FOUND when the id does not exist (and does not call update)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    const updateSpy = vi.spyOn(fake, "update");

    await expect(
      authedCaller.searches.update({
        id: "00000000-0000-7000-8000-0000000000ff",
        name: "Ghost",
        location: "",
        types: [],
        condition: [],
        land: [],
        saleMethods: ["Private treaty"],
        minBedrooms: null,
        maxPricePence: null,
        keywords: "",
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("searchesRouter.delete (cascade)", () => {
  const ID = "00000000-0000-7000-8000-000000000001";

  it("operator: runs the cascade with isOperator=true + the operator NULL owner, echoing its counts", async () => {
    injectRepo();
    const cascade = vi.fn().mockResolvedValue({
      id: ID,
      dismissedCount: 3,
      removedAgentCount: 2,
    });
    _setSearchRemovalCascadeForTesting(cascade);

    const result = await authedCaller.searches.delete({ id: ID });

    expect(result).toEqual({ id: ID, dismissedCount: 3, removedAgentCount: 2 });
    expect(cascade).toHaveBeenCalledWith({
      searchId: ID,
      ownerId: null,
      isOperator: true,
    });
  });

  it("non-operator: runs the cascade with isOperator=false + their own owner id (never touches the global agent pool)", async () => {
    injectRepo();
    const cascade = vi.fn().mockResolvedValue({
      id: ID,
      dismissedCount: 1,
      removedAgentCount: 0,
    });
    _setSearchRemovalCascadeForTesting(cascade);

    const result = await partnerCaller.searches.delete({ id: ID });

    expect(result.removedAgentCount).toBe(0);
    expect(cascade).toHaveBeenCalledWith({
      searchId: ID,
      ownerId: PARTNER_ID,
      isOperator: false,
    });
  });

  it("maps Prisma P2025 (missing/foreign) to NOT_FOUND", async () => {
    injectRepo();
    _setSearchRemovalCascadeForTesting(
      vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Record not found", {
          code: "P2025",
          clientVersion: "test",
        }),
      ),
    );
    await expect(
      authedCaller.searches.delete({ id: "00000000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("searchesRouter.removalPreview", () => {
  const ID = "00000000-0000-7000-8000-000000000001";

  it("operator: returns the cascade preview counts for the confirm dialog", async () => {
    injectRepo();
    const preview = vi
      .fn()
      .mockResolvedValue({ listingsToHide: 5, agentsToRemove: 3 });
    _setSearchRemovalPreviewerForTesting(preview);

    const result = await authedCaller.searches.removalPreview({ id: ID });

    expect(result).toEqual({ listingsToHide: 5, agentsToRemove: 3 });
    expect(preview).toHaveBeenCalledWith({
      searchId: ID,
      ownerId: null,
      isOperator: true,
    });
  });

  it("non-operator: passes isOperator=false (preview returns 0 agents)", async () => {
    injectRepo();
    const preview = vi
      .fn()
      .mockResolvedValue({ listingsToHide: 2, agentsToRemove: 0 });
    _setSearchRemovalPreviewerForTesting(preview);

    await partnerCaller.searches.removalPreview({ id: ID });
    expect(preview).toHaveBeenCalledWith({
      searchId: ID,
      ownerId: PARTNER_ID,
      isOperator: false,
    });
  });

  it("maps Prisma P2025 to NOT_FOUND", async () => {
    injectRepo();
    _setSearchRemovalPreviewerForTesting(
      vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Record not found", {
          code: "P2025",
          clientVersion: "test",
        }),
      ),
    );
    await expect(
      authedCaller.searches.removalPreview({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("searchesRouter.setStatus", () => {
  it("maps id + status to the repository and returns the row", async () => {
    const fake = injectRepo();
    const paused = makeSearch({ status: "paused" });
    const spy = vi.spyOn(fake, "setStatus").mockResolvedValue(paused);

    const result = await authedCaller.searches.setStatus({
      id: paused.id,
      status: "paused",
    });
    expect(result).toEqual(paused);
    expect(spy).toHaveBeenCalledWith(paused.id, "paused", null);
  });

  it("maps Prisma P2025 (already gone) to NOT_FOUND", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "setStatus").mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Record not found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    await expect(
      authedCaller.searches.setStatus({
        id: "00000000-0000-7000-8000-0000000000ff",
        status: "paused",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("searchesRouter.launch", () => {
  it("enqueues discover:agents over the search's outcodes and echoes them", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(
      makeSearch({ outcodes: ["LL30", "LL31"] }),
    );
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setDiscoverAgentsEnqueuerForTesting(enqueue);

    const result = await authedCaller.searches.launch({
      id: "00000000-0000-7000-8000-000000000001",
    });
    expect(result).toEqual({ enqueued: true, outcodes: ["LL30", "LL31"] });
    expect(enqueue).toHaveBeenCalledWith({
      idempotencyKey:
        "discover:agents:search:00000000-0000-7000-8000-000000000001",
      payload: { regionName: "Conwy County", outcodes: ["LL30", "LL31"] },
    });
  });

  it("BAD_REQUEST when the search has no target outcodes (no enqueue)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(makeSearch({ outcodes: [] }));
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setDiscoverAgentsEnqueuerForTesting(enqueue);

    await expect(
      authedCaller.searches.launch({
        id: "00000000-0000-7000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("NOT_FOUND for an unknown search id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    await expect(
      authedCaller.searches.launch({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("searchesRouter.reviewDrafts", () => {
  function injectAgents(agents: AgentRecord[]): AgentRepository {
    const repo = new AgentRepository();
    vi.spyOn(repo, "list").mockResolvedValue({ items: agents, nextCursor: null });
    _setSearchAgentRepositoryForTesting(repo);
    return repo;
  }

  function injectGuard(impl: (agentId: string) => Promise<void>): void {
    _setSearchComplianceGuardForTesting({
      assertCanSend: vi.fn(
        (agent: { id: string }) => impl(agent.id),
      ),
    } as unknown as ComplianceGuard);
  }

  it("builds the search draft and maps each agent's guard precheck to eligible/reason", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(
      makeSearch({ location: "Conwy County", outcodes: ["LL30"] }),
    );
    const eligible = makeAgent({
      id: "00000000-0000-7000-8000-0000000000a1",
      email: "ok@conwy-estates.co.uk",
    });
    const blocked = makeAgent({
      id: "00000000-0000-7000-8000-0000000000a2",
      email: "blocked@conwy-estates.co.uk",
    });
    injectAgents([eligible, blocked]);
    injectProfile();
    // reserve:false precheck: the first passes, the second is SUPPRESSED.
    injectGuard(async (agentId) => {
      if (agentId === blocked.id) {
        throw new ComplianceError("SUPPRESSED", {
          retryable: false,
          trpcCode: "FORBIDDEN",
        });
      }
    });

    const result = await authedCaller.searches.reviewDrafts({
      id: "00000000-0000-7000-8000-000000000001",
    });

    expect(result.draft).toContain(
      "I'm a private buyer searching in Conwy County",
    );
    expect(result.agents).toEqual([
      {
        id: eligible.id,
        email: "ok@conwy-estates.co.uk",
        agencyName: "Conwy Estates",
        eligible: true,
        reason: null,
      },
      {
        id: blocked.id,
        email: "blocked@conwy-estates.co.uk",
        agencyName: "Conwy Estates",
        eligible: false,
        reason: "SUPPRESSED",
      },
    ]);
  });

  it("pages through the WHOLE patch, not just the first page (list clamps to 100)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(makeSearch({ outcodes: ["LL30"] }));
    injectProfile();
    injectGuard(async () => {}); // every agent eligible

    // The patch is larger than one page: list() returns a FULL first page (with a
    // nextCursor) then the tail. A single un-paged call would silently drop the
    // tail — those agents could then never be approved.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeAgent({ id: `agent-${i}`, email: `a${i}@conwy-estates.co.uk` }),
    );
    const page2 = [
      makeAgent({ id: "agent-tail-1", email: "tail1@conwy-estates.co.uk" }),
      makeAgent({ id: "agent-tail-2", email: "tail2@conwy-estates.co.uk" }),
    ];
    const repo = new AgentRepository();
    const listSpy = vi
      .spyOn(repo, "list")
      .mockResolvedValueOnce({ items: page1, nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ items: page2, nextCursor: null });
    _setSearchAgentRepositoryForTesting(repo);

    const result = await authedCaller.searches.reviewDrafts({
      id: "00000000-0000-7000-8000-000000000001",
    });

    // All 102 agents in the patch are reviewable — including the tail.
    expect(result.agents).toHaveLength(102);
    expect(result.agents.map((a) => a.email)).toContain("tail2@conwy-estates.co.uk");
    // It paged via the cursor rather than a single unbounded (clamped) call.
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(listSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-1" }),
    );
  });

  it("signs + paces the reviewed draft from the buyer profile (Settings)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(
      makeSearch({ location: "Conwy County", outcodes: ["LL30"] }),
    );
    injectAgents([]);
    injectProfile({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });

    const result = await authedCaller.searches.reviewDrafts({
      id: "00000000-0000-7000-8000-000000000001",
    });

    // The sign-off carries the buyer's name + phone; the urgency injects its
    // line, replacing the relaxed default — exactly what the worker will send.
    expect(result.draft).toContain("Many thanks,\nJane Whitfield\n07700 900123");
    expect(result.draft).toContain("I'm in a strong position to proceed");
    expect(result.draft).not.toContain(
      "Happy to move quickly for the right place.",
    );
  });

  it("calls the guard with reserve:false (a review never consumes a token)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(makeSearch({ outcodes: ["LL30"] }));
    injectAgents([makeAgent()]);
    injectProfile();
    const assertCanSend = vi.fn().mockResolvedValue(undefined);
    _setSearchComplianceGuardForTesting({
      assertCanSend,
    } as unknown as ComplianceGuard);

    await authedCaller.searches.reviewDrafts({
      id: "00000000-0000-7000-8000-000000000001",
    });
    expect(assertCanSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: makeAgent().id }),
      { reserve: false },
    );
  });

  it("rethrows a non-ComplianceError from the guard (a real fault, not a block)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(makeSearch({ outcodes: ["LL30"] }));
    injectAgents([makeAgent()]);
    injectProfile();
    injectGuard(async () => {
      throw new Error("redis down");
    });
    await expect(
      authedCaller.searches.reviewDrafts({
        id: "00000000-0000-7000-8000-000000000001",
      }),
    ).rejects.toThrow("redis down");
  });

  it("NOT_FOUND for an unknown search id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    await expect(
      authedCaller.searches.reviewDrafts({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("searchesRouter.approveSends", () => {
  it("enqueues one guarded outreach:send per agent, each carrying the searchId", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setSearchOutreachSendEnqueuerForTesting(enqueue);

    const result = await authedCaller.searches.approveSends({
      id: "00000000-0000-7000-8000-000000000001",
      agentIds: [
        "00000000-0000-7000-8000-0000000000a1",
        "00000000-0000-7000-8000-0000000000a2",
      ],
    });
    expect(result).toEqual({ enqueued: 2 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, {
      idempotencyKey:
        "outreach:send:search:00000000-0000-7000-8000-000000000001:00000000-0000-7000-8000-0000000000a1",
      payload: {
        agentId: "00000000-0000-7000-8000-0000000000a1",
        searchId: "00000000-0000-7000-8000-000000000001",
      },
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, {
      idempotencyKey:
        "outreach:send:search:00000000-0000-7000-8000-000000000001:00000000-0000-7000-8000-0000000000a2",
      payload: {
        agentId: "00000000-0000-7000-8000-0000000000a2",
        searchId: "00000000-0000-7000-8000-000000000001",
      },
    });
  });

  it("enqueues nothing for an empty agentIds list", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setSearchOutreachSendEnqueuerForTesting(enqueue);
    const result = await authedCaller.searches.approveSends({
      id: "00000000-0000-7000-8000-000000000001",
      agentIds: [],
    });
    expect(result).toEqual({ enqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("searchesRouter.stats", () => {
  it("returns homesFound + agentsInPatch + agentsContacted for the search's outcodes", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(
      makeSearch({ outcodes: ["LL30", "LL31"] }),
    );

    const listingRepo = new ListingRepository();
    const countListings = vi
      .spyOn(listingRepo, "countByOutcodes")
      .mockResolvedValue(7);
    _setSearchListingRepositoryForTesting(listingRepo);

    const agentRepo = new AgentRepository();
    const countAgents = vi
      .spyOn(agentRepo, "countByOutcodes")
      .mockImplementation(async (_outcodes, options) =>
        options?.contactedOnly ? 2 : 5,
      );
    _setSearchAgentRepositoryForTesting(agentRepo);

    const result = await authedCaller.searches.stats({
      id: "00000000-0000-7000-8000-000000000001",
    });
    expect(result).toEqual({
      homesFound: 7,
      agentsInPatch: 5,
      agentsContacted: 2,
    });
    expect(countListings).toHaveBeenCalledWith(["LL30", "LL31"]);
    expect(countAgents).toHaveBeenCalledWith(["LL30", "LL31"]);
    expect(countAgents).toHaveBeenCalledWith(["LL30", "LL31"], {
      contactedOnly: true,
    });
  });

  it("NOT_FOUND for an unknown search id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    await expect(
      authedCaller.searches.stats({ id: "00000000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("searchesRouter auth", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.searches.list()).rejects.toBeInstanceOf(TRPCError);
    await expect(anon.searches.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("searchesRouter multi-user scoping", () => {
  it("scopes list/create to the operator's NULL namespace for the operator", async () => {
    const fake = injectRepo();
    const listSpy = vi.spyOn(fake, "list").mockResolvedValue([]);
    const createSpy = vi.spyOn(fake, "create").mockResolvedValue(makeSearch());

    await authedCaller.searches.list();
    await authedCaller.searches.create({ name: "Op search" });

    expect(listSpy).toHaveBeenCalledWith(null);
    expect(createSpy.mock.calls[0]![1]).toBeNull();
  });

  it("scopes list/getById/create to a non-operator's own user id", async () => {
    const fake = injectRepo();
    const listSpy = vi.spyOn(fake, "list").mockResolvedValue([]);
    const getSpy = vi.spyOn(fake, "getById").mockResolvedValue(makeSearch());
    const createSpy = vi.spyOn(fake, "create").mockResolvedValue(makeSearch());

    await partnerCaller.searches.list();
    await partnerCaller.searches.getById({
      id: "00000000-0000-7000-8000-000000000001",
    });
    await partnerCaller.searches.create({ name: "Partner search" });

    expect(listSpy).toHaveBeenCalledWith(PARTNER_ID);
    expect(getSpy).toHaveBeenCalledWith(
      "00000000-0000-7000-8000-000000000001",
      PARTNER_ID,
    );
    expect(createSpy.mock.calls[0]![1]).toBe(PARTNER_ID);
  });

  it("FORBIDS the operator-only outreach loop for a non-operator", async () => {
    injectRepo();
    for (const call of [
      () => partnerCaller.searches.launch({ id: "00000000-0000-7000-8000-000000000001" }),
      () =>
        partnerCaller.searches.reviewDrafts({
          id: "00000000-0000-7000-8000-000000000001",
        }),
      () =>
        partnerCaller.searches.approveSends({
          id: "00000000-0000-7000-8000-000000000001",
          agentIds: [],
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});
