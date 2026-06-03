/**
 * scoutsRouter unit tests (M8). Pure unit: a fake ScoutRepository is injected
 * via `_setScoutRepositoryForTesting`, and procedures are invoked through a
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { appRouter } from "../index.js";
import {
  ScoutRepository,
  _setScoutRepositoryForTesting,
  type ScoutRecord,
} from "../../repositories/scout.repository.js";
import {
  _setScoutComplianceGuardForTesting,
  _setScoutAgentRepositoryForTesting,
  _setScoutListingRepositoryForTesting,
  _setScoutSearchProfileRepositoryForTesting,
  _setDiscoverAgentsEnqueuerForTesting,
  _setScoutOutreachSendEnqueuerForTesting,
} from "../scouts.router.js";
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
  _setScoutSearchProfileRepositoryForTesting(repo);
}

function makeScout(overrides: Partial<ScoutRecord> = {}): ScoutRecord {
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

const authedCaller = appRouter.createCaller({
  user: { email: "dev@homeranger.local" },
});

afterEach(() => {
  _setScoutRepositoryForTesting(null);
  _setScoutComplianceGuardForTesting(null);
  _setScoutAgentRepositoryForTesting(null);
  _setScoutListingRepositoryForTesting(null);
  _setScoutSearchProfileRepositoryForTesting(null);
  _setDiscoverAgentsEnqueuerForTesting(null);
  _setScoutOutreachSendEnqueuerForTesting(null);
  vi.restoreAllMocks();
});

function injectRepo(): ScoutRepository {
  const fake = new ScoutRepository();
  _setScoutRepositoryForTesting(fake);
  return fake;
}

describe("scoutsRouter.list", () => {
  it("returns every scout from the repository", async () => {
    const fake = injectRepo();
    const scouts = [makeScout(), makeScout({ id: "00000000-0000-7000-8000-000000000002" })];
    const spy = vi.spyOn(fake, "list").mockResolvedValue(scouts);

    const result = await authedCaller.scouts.list();
    expect(result).toEqual(scouts);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("scoutsRouter.getById", () => {
  it("returns the scout", async () => {
    const fake = injectRepo();
    const scout = makeScout();
    vi.spyOn(fake, "getById").mockResolvedValue(scout);

    const result = await authedCaller.scouts.getById({ id: scout.id });
    expect(result).toEqual(scout);
  });

  it("throws TRPCError NOT_FOUND on an unknown id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);

    await expect(
      authedCaller.scouts.getById({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter.create", () => {
  it("maps the wire fields to the repository (no outcodes passed) and returns the row", async () => {
    const fake = injectRepo();
    const created = makeScout();
    const spy = vi.spyOn(fake, "create").mockResolvedValue(created);

    const result = await authedCaller.scouts.create({
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
    const spy = vi.spyOn(fake, "create").mockResolvedValue(makeScout());

    await authedCaller.scouts.create({ name: "Anywhere" });

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

describe("scoutsRouter.update", () => {
  it("updates an existing scout and returns the row", async () => {
    const fake = injectRepo();
    const existing = makeScout();
    const updated = makeScout({ name: "Renamed" });
    vi.spyOn(fake, "getById").mockResolvedValue(existing);
    const updateSpy = vi.spyOn(fake, "update").mockResolvedValue(updated);

    const result = await authedCaller.scouts.update({
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
      authedCaller.scouts.update({
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

describe("scoutsRouter.delete", () => {
  it("deletes by id and echoes { id }", async () => {
    const fake = injectRepo();
    const id = "00000000-0000-7000-8000-000000000001";
    const spy = vi.spyOn(fake, "delete").mockResolvedValue({ id });

    const result = await authedCaller.scouts.delete({ id });
    expect(result).toEqual({ id });
    expect(spy).toHaveBeenCalledWith(id);
  });

  it("maps Prisma P2025 (already gone) to NOT_FOUND", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "delete").mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Record not found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    await expect(
      authedCaller.scouts.delete({ id: "00000000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter.setStatus", () => {
  it("maps id + status to the repository and returns the row", async () => {
    const fake = injectRepo();
    const paused = makeScout({ status: "paused" });
    const spy = vi.spyOn(fake, "setStatus").mockResolvedValue(paused);

    const result = await authedCaller.scouts.setStatus({
      id: paused.id,
      status: "paused",
    });
    expect(result).toEqual(paused);
    expect(spy).toHaveBeenCalledWith(paused.id, "paused");
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
      authedCaller.scouts.setStatus({
        id: "00000000-0000-7000-8000-0000000000ff",
        status: "paused",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter.launch", () => {
  it("enqueues discover:agents over the scout's outcodes and echoes them", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(
      makeScout({ outcodes: ["LL30", "LL31"] }),
    );
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setDiscoverAgentsEnqueuerForTesting(enqueue);

    const result = await authedCaller.scouts.launch({
      id: "00000000-0000-7000-8000-000000000001",
    });
    expect(result).toEqual({ enqueued: true, outcodes: ["LL30", "LL31"] });
    expect(enqueue).toHaveBeenCalledWith({
      idempotencyKey:
        "discover:agents:scout:00000000-0000-7000-8000-000000000001",
      payload: { regionName: "Conwy County", outcodes: ["LL30", "LL31"] },
    });
  });

  it("BAD_REQUEST when the scout has no target outcodes (no enqueue)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(makeScout({ outcodes: [] }));
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setDiscoverAgentsEnqueuerForTesting(enqueue);

    await expect(
      authedCaller.scouts.launch({
        id: "00000000-0000-7000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("NOT_FOUND for an unknown scout id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    await expect(
      authedCaller.scouts.launch({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter.reviewDrafts", () => {
  function injectAgents(agents: AgentRecord[]): AgentRepository {
    const repo = new AgentRepository();
    vi.spyOn(repo, "list").mockResolvedValue({ items: agents, nextCursor: null });
    _setScoutAgentRepositoryForTesting(repo);
    return repo;
  }

  function injectGuard(impl: (agentId: string) => Promise<void>): void {
    _setScoutComplianceGuardForTesting({
      assertCanSend: vi.fn(
        (agent: { id: string }) => impl(agent.id),
      ),
    } as unknown as ComplianceGuard);
  }

  it("builds the scout draft and maps each agent's guard precheck to eligible/reason", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(
      makeScout({ location: "Conwy County", outcodes: ["LL30"] }),
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

    const result = await authedCaller.scouts.reviewDrafts({
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

  it("signs + paces the reviewed draft from the buyer profile (Settings)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(
      makeScout({ location: "Conwy County", outcodes: ["LL30"] }),
    );
    injectAgents([]);
    injectProfile({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });

    const result = await authedCaller.scouts.reviewDrafts({
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
    vi.spyOn(fake, "getById").mockResolvedValue(makeScout({ outcodes: ["LL30"] }));
    injectAgents([makeAgent()]);
    injectProfile();
    const assertCanSend = vi.fn().mockResolvedValue(undefined);
    _setScoutComplianceGuardForTesting({
      assertCanSend,
    } as unknown as ComplianceGuard);

    await authedCaller.scouts.reviewDrafts({
      id: "00000000-0000-7000-8000-000000000001",
    });
    expect(assertCanSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: makeAgent().id }),
      { reserve: false },
    );
  });

  it("rethrows a non-ComplianceError from the guard (a real fault, not a block)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(makeScout({ outcodes: ["LL30"] }));
    injectAgents([makeAgent()]);
    injectProfile();
    injectGuard(async () => {
      throw new Error("redis down");
    });
    await expect(
      authedCaller.scouts.reviewDrafts({
        id: "00000000-0000-7000-8000-000000000001",
      }),
    ).rejects.toThrow("redis down");
  });

  it("NOT_FOUND for an unknown scout id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    await expect(
      authedCaller.scouts.reviewDrafts({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter.approveSends", () => {
  it("enqueues one guarded outreach:send per agent, each carrying the scoutId", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setScoutOutreachSendEnqueuerForTesting(enqueue);

    const result = await authedCaller.scouts.approveSends({
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
        "outreach:send:scout:00000000-0000-7000-8000-000000000001:00000000-0000-7000-8000-0000000000a1",
      payload: {
        agentId: "00000000-0000-7000-8000-0000000000a1",
        scoutId: "00000000-0000-7000-8000-000000000001",
      },
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, {
      idempotencyKey:
        "outreach:send:scout:00000000-0000-7000-8000-000000000001:00000000-0000-7000-8000-0000000000a2",
      payload: {
        agentId: "00000000-0000-7000-8000-0000000000a2",
        scoutId: "00000000-0000-7000-8000-000000000001",
      },
    });
  });

  it("enqueues nothing for an empty agentIds list", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setScoutOutreachSendEnqueuerForTesting(enqueue);
    const result = await authedCaller.scouts.approveSends({
      id: "00000000-0000-7000-8000-000000000001",
      agentIds: [],
    });
    expect(result).toEqual({ enqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("scoutsRouter.stats", () => {
  it("returns homesFound + agentsInPatch + agentsContacted for the scout's outcodes", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(
      makeScout({ outcodes: ["LL30", "LL31"] }),
    );

    const listingRepo = new ListingRepository();
    const countListings = vi
      .spyOn(listingRepo, "countByOutcodes")
      .mockResolvedValue(7);
    _setScoutListingRepositoryForTesting(listingRepo);

    const agentRepo = new AgentRepository();
    const countAgents = vi
      .spyOn(agentRepo, "countByOutcodes")
      .mockImplementation(async (_outcodes, options) =>
        options?.contactedOnly ? 2 : 5,
      );
    _setScoutAgentRepositoryForTesting(agentRepo);

    const result = await authedCaller.scouts.stats({
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

  it("NOT_FOUND for an unknown scout id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    await expect(
      authedCaller.scouts.stats({ id: "00000000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter auth", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.scouts.list()).rejects.toBeInstanceOf(TRPCError);
    await expect(anon.scouts.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
