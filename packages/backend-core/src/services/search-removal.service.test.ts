/**
 * Unit tests for search-removal.service — the delete-a-search cascade. No DB:
 * the repository singletons are swapped for spies via each repo's
 * `_setXRepositoryForTesting` seam, and the transaction boundary is swapped for a
 * stub runner that just invokes the callback with a dummy tx. Asserts the
 * GDPR-correct + overlap-safe agent selection, the operator gate, the atomic
 * composition, and the NOT_FOUND (P2025) contract.
 */
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  previewSearchRemoval,
  removeSearchCascade,
  selectAgentsToRemove,
  _setTransactionRunnerForTesting,
} from "./search-removal.service.js";
import {
  SearchRepository,
  _setSearchRepositoryForTesting,
  type SearchRecord,
} from "../repositories/search.repository.js";
import {
  AgentRepository,
  _setAgentRepositoryForTesting,
} from "../repositories/agent.repository.js";
import {
  ListingRepository,
  _setListingRepositoryForTesting,
} from "../repositories/listing.repository.js";
import {
  DismissedListingRepository,
  _setDismissedListingRepositoryForTesting,
} from "../repositories/dismissed-listing.repository.js";
import {
  EmailEventRepository,
  _setEmailEventRepositoryForTesting,
} from "../repositories/email-event.repository.js";

function makeSearch(overrides: Partial<SearchRecord> = {}): SearchRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Snowdonia",
    location: "Snowdonia, Gwynedd",
    outcodes: ["LL55", "LL40"],
    types: [],
    condition: [],
    land: [],
    saleMethods: [],
    minBedrooms: null,
    maxPricePence: null,
    keywords: "",
    status: "active",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

interface Spies {
  searchGetById: ReturnType<typeof vi.fn>;
  searchList: ReturnType<typeof vi.fn>;
  searchDelete: ReturnType<typeof vi.fn>;
  listingIds: ReturnType<typeof vi.fn>;
  listingCount: ReturnType<typeof vi.fn>;
  findIds: ReturnType<typeof vi.fn>;
  findEmails: ReturnType<typeof vi.fn>;
  deleteAgents: ReturnType<typeof vi.fn>;
  deleteEvents: ReturnType<typeof vi.fn>;
  dismissMany: ReturnType<typeof vi.fn>;
}

function inject(opts: {
  search?: SearchRecord | null;
  otherSearches?: SearchRecord[];
  listingIds?: string[];
  listingCount?: number;
  candidates?: Array<{ id: string; coveredOutcodes: string[] }>;
  agentEmails?: string[];
}): Spies {
  const search = opts.search === undefined ? makeSearch() : opts.search;

  const searchRepo = new SearchRepository();
  const searchGetById = vi
    .spyOn(searchRepo, "getById")
    .mockResolvedValue(search) as unknown as ReturnType<typeof vi.fn>;
  const searchList = vi
    .spyOn(searchRepo, "list")
    .mockResolvedValue(opts.otherSearches ?? []) as unknown as ReturnType<
    typeof vi.fn
  >;
  const searchDelete = vi
    .spyOn(searchRepo, "delete")
    .mockResolvedValue({ id: search?.id ?? "x" }) as unknown as ReturnType<
    typeof vi.fn
  >;
  _setSearchRepositoryForTesting(searchRepo);

  const agentRepo = new AgentRepository();
  const findIds = vi
    .spyOn(agentRepo, "findIdsByOutcodes")
    .mockResolvedValue(opts.candidates ?? []) as unknown as ReturnType<
    typeof vi.fn
  >;
  const deleteAgents = vi
    .spyOn(agentRepo, "deleteManyByIds")
    .mockResolvedValue(0) as unknown as ReturnType<typeof vi.fn>;
  const findEmails = vi
    .spyOn(agentRepo, "findEmailsByIds")
    .mockResolvedValue(opts.agentEmails ?? []) as unknown as ReturnType<
    typeof vi.fn
  >;
  _setAgentRepositoryForTesting(agentRepo);

  const eventRepo = new EmailEventRepository();
  const deleteEvents = vi
    .spyOn(eventRepo, "deleteByEmails")
    .mockResolvedValue(0) as unknown as ReturnType<typeof vi.fn>;
  _setEmailEventRepositoryForTesting(eventRepo);

  const listingRepo = new ListingRepository();
  const listingIds = vi
    .spyOn(listingRepo, "listIdsByOutcodes")
    .mockResolvedValue(opts.listingIds ?? []) as unknown as ReturnType<
    typeof vi.fn
  >;
  const listingCount = vi
    .spyOn(listingRepo, "countByOutcodes")
    .mockResolvedValue(opts.listingCount ?? 0) as unknown as ReturnType<
    typeof vi.fn
  >;
  _setListingRepositoryForTesting(listingRepo);

  const dismissedRepo = new DismissedListingRepository();
  const dismissMany = vi
    .spyOn(dismissedRepo, "dismissMany")
    .mockResolvedValue(0) as unknown as ReturnType<typeof vi.fn>;
  _setDismissedListingRepositoryForTesting(dismissedRepo);

  // Stub transaction: invoke the callback with a dummy tx (repos are spies that
  // ignore the tx arg). Record that all writes ran inside it via call order.
  _setTransactionRunnerForTesting(async (fn) =>
    fn({} as unknown as Prisma.TransactionClient),
  );

  return {
    searchGetById,
    searchList,
    searchDelete,
    listingIds,
    listingCount,
    findIds,
    findEmails,
    deleteAgents,
    deleteEvents,
    dismissMany,
  };
}

afterEach(() => {
  _setSearchRepositoryForTesting(null);
  _setAgentRepositoryForTesting(null);
  _setListingRepositoryForTesting(null);
  _setDismissedListingRepositoryForTesting(null);
  _setEmailEventRepositoryForTesting(null);
  _setTransactionRunnerForTesting(null);
  vi.restoreAllMocks();
});

const OPERATOR = { searchId: "11111111-1111-1111-1111-111111111111", ownerId: null, isOperator: true };
const USER = {
  searchId: "11111111-1111-1111-1111-111111111111",
  ownerId: "22222222-2222-2222-2222-222222222222",
  isOperator: false,
};

describe("selectAgentsToRemove", () => {
  it("removes an agent that touches only the target patch", () => {
    const out = selectAgentsToRemove(
      ["LL55"],
      [],
      [{ id: "a", coveredOutcodes: ["LL55", "LL40"] }],
    );
    expect(out).toEqual(["a"]);
  });

  it("KEEPS an agent also covered by another remaining search (legitimate-interest basis)", () => {
    const out = selectAgentsToRemove(
      ["LL55"],
      ["NW3"], // another search covers NW3
      [
        { id: "only-here", coveredOutcodes: ["LL55"] },
        { id: "shared", coveredOutcodes: ["LL55", "NW3"] },
      ],
    );
    expect(out).toEqual(["only-here"]);
  });

  it("is case-insensitive on outcodes", () => {
    const out = selectAgentsToRemove(
      ["ll55"],
      ["nw3"],
      [{ id: "shared", coveredOutcodes: ["LL55", "NW3"] }],
    );
    expect(out).toEqual([]); // shared with NW3 → kept
  });

  it("skips a candidate that does not touch the target patch (defensive)", () => {
    const out = selectAgentsToRemove(
      ["LL55"],
      [],
      [{ id: "elsewhere", coveredOutcodes: ["SE1"] }],
    );
    expect(out).toEqual([]);
  });
});

describe("removeSearchCascade", () => {
  it("operator: hides homes, removes non-shared agents, deletes the search, atomically", async () => {
    const spies = inject({
      search: makeSearch({ id: "self", outcodes: ["LL55", "LL40"] }),
      otherSearches: [
        makeSearch({ id: "other", outcodes: ["NW3"] }),
        makeSearch({ id: "self", outcodes: ["LL55"] }), // the one being removed (filtered out)
      ],
      listingIds: ["l1", "l2", "l3"],
      candidates: [
        { id: "ag-here", coveredOutcodes: ["LL55"] },
        { id: "ag-shared", coveredOutcodes: ["LL40", "NW3"] }, // shared with NW3 → kept
      ],
      agentEmails: ["ag-here@x.test"],
    });

    const result = await removeSearchCascade(OPERATOR);

    expect(result).toEqual({ id: "self", dismissedCount: 3, removedAgentCount: 1 });
    expect(spies.dismissMany).toHaveBeenCalledWith(null, ["l1", "l2", "l3"], expect.anything());
    expect(spies.deleteAgents).toHaveBeenCalledWith(["ag-here"], expect.anything());
    // GDPR: the removed agents' EmailEvent feed is purged in the same tx.
    expect(spies.findEmails).toHaveBeenCalledWith(["ag-here"]);
    expect(spies.deleteEvents).toHaveBeenCalledWith(["ag-here@x.test"], expect.anything());
    expect(spies.searchDelete).toHaveBeenCalledWith("self", null, expect.anything());
  });

  it("non-operator: hides their homes + deletes the search but NEVER touches the global agent pool", async () => {
    const spies = inject({
      search: makeSearch({ outcodes: ["LL55"] }),
      listingIds: ["l1"],
      candidates: [{ id: "ag", coveredOutcodes: ["LL55"] }],
    });

    const result = await removeSearchCascade(USER);

    expect(result.removedAgentCount).toBe(0);
    expect(spies.deleteAgents).not.toHaveBeenCalled();
    expect(spies.deleteEvents).not.toHaveBeenCalled();
    expect(spies.findIds).not.toHaveBeenCalled(); // no agent resolution for a non-operator
    expect(spies.dismissMany).toHaveBeenCalledWith(USER.ownerId, ["l1"], expect.anything());
    expect(spies.searchDelete).toHaveBeenCalledWith(OPERATOR.searchId, USER.ownerId, expect.anything());
  });

  it("a search with no outcodes hides nothing and removes no agents", async () => {
    const spies = inject({ search: makeSearch({ outcodes: [] }), listingIds: [] });
    const result = await removeSearchCascade(OPERATOR);
    expect(result).toEqual({ id: OPERATOR.searchId, dismissedCount: 0, removedAgentCount: 0 });
    expect(spies.deleteAgents).not.toHaveBeenCalled();
    expect(spies.deleteEvents).not.toHaveBeenCalled();
    expect(spies.dismissMany).toHaveBeenCalledWith(null, [], expect.anything());
  });

  it("throws Prisma P2025 (→ NOT_FOUND) for a missing or foreign search, mutating nothing", async () => {
    const spies = inject({ search: null });
    await expect(removeSearchCascade(OPERATOR)).rejects.toMatchObject({ code: "P2025" });
    expect(spies.dismissMany).not.toHaveBeenCalled();
    expect(spies.searchDelete).not.toHaveBeenCalled();
  });
});

describe("previewSearchRemoval", () => {
  it("operator: returns homes-in-patch + the precise agents-to-remove count", async () => {
    inject({
      search: makeSearch({ outcodes: ["LL55"] }),
      otherSearches: [makeSearch({ id: "other", outcodes: ["NW3"] })],
      listingCount: 7,
      candidates: [
        { id: "ag-here", coveredOutcodes: ["LL55"] },
        { id: "ag-shared", coveredOutcodes: ["LL55", "NW3"] },
      ],
    });
    const preview = await previewSearchRemoval(OPERATOR);
    expect(preview).toEqual({ listingsToHide: 7, agentsToRemove: 1 });
  });

  it("non-operator: agentsToRemove is always 0", async () => {
    const spies = inject({ search: makeSearch(), listingCount: 4 });
    const preview = await previewSearchRemoval(USER);
    expect(preview).toEqual({ listingsToHide: 4, agentsToRemove: 0 });
    expect(spies.findIds).not.toHaveBeenCalled();
  });

  it("throws Prisma P2025 for a missing or foreign search", async () => {
    inject({ search: null });
    await expect(previewSearchRemoval(OPERATOR)).rejects.toMatchObject({ code: "P2025" });
  });
});
