/**
 * Integration test for searchRepository against a real pgvector Postgres (M8).
 * Proves the full CRUD round-trip — create → list → getById → update →
 * setStatus → delete — and that `outcodes` are RESOLVED server-side from the
 * free-text `location` on create + update (both a region-NAME location and an
 * explicit-outcode location).
 *
 * Gate: integration project only (VITEST_INTEGRATION=1 + DATABASE_URL).
 *
 * Cleanup: Search has no `test-` natural key in the shared cleanupTestData
 * teardown, so this spec names its rows with a `test-search-` prefix and removes
 * them itself in before/after hooks.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectTestPrisma, getTestPrisma } from "../test/db-helper.js";
import { searchRepository, type CreateSearchInput } from "./search.repository.js";

const db = getTestPrisma();
const NAME_PREFIX = "test-search-";
// Two distinct non-operator owners for the isolation test.
const OWNER_A = "a0a0a0a0-0000-4000-8000-00000000000a";
const OWNER_B = "b0b0b0b0-0000-4000-8000-00000000000b";

async function cleanupSearches(): Promise<void> {
  await db.search.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } });
}

function baseInput(overrides: Partial<CreateSearchInput> = {}): CreateSearchInput {
  return {
    name: `${NAME_PREFIX}base`,
    location: "Conwy County",
    types: ["Cottage", "Farmhouse"],
    condition: ["Restoration project"],
    land: ["Land with a building to convert"],
    saleMethods: ["Private treaty"],
    minBedrooms: 3,
    maxPricePence: 42_500_000,
    keywords: "sea views, character",
    status: "active",
    ...overrides,
  };
}

beforeEach(async () => {
  await cleanupSearches();
});
afterEach(async () => {
  await cleanupSearches();
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe("searchRepository CRUD round-trip (real pgvector)", () => {
  it("creates → lists → getById → updates → setStatus → deletes a search", async () => {
    // CREATE — outcodes resolved from a region-NAME location.
    const created = await searchRepository.create(
      baseInput({ name: `${NAME_PREFIX}roundtrip`, location: "Snowdonia, Gwynedd" }),
      OWNER_A,
    );
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(`${NAME_PREFIX}roundtrip`);
    expect(created.minBedrooms).toBe(3);
    expect(created.maxPricePence).toBe(42_500_000);
    expect(created.status).toBe("active");
    // "Gwynedd" segment resolves its curated outcodes.
    expect(created.outcodes).toContain("LL23");
    expect(created.outcodes.length).toBeGreaterThan(0);

    // LIST — ordered updatedAt desc; our row is present.
    const listed = await searchRepository.list(OWNER_A);
    expect(listed.some((s) => s.id === created.id)).toBe(true);

    // GET BY ID.
    const fetched = await searchRepository.getById(created.id, OWNER_A);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.outcodes).toEqual(created.outcodes);

    // UPDATE — full replace; new location re-resolves outcodes from EXPLICIT text.
    const updated = await searchRepository.update(
      {
        id: created.id,
        name: `${NAME_PREFIX}roundtrip`,
        location: "SE16, SE1",
        types: ["Flat"],
        condition: ["Move-in ready"],
        land: [],
        saleMethods: ["Auction"],
        minBedrooms: null,
        maxPricePence: null,
        keywords: "",
        status: "active",
      },
      OWNER_A,
    );
    expect(updated.location).toBe("SE16, SE1");
    expect(updated.types).toEqual(["Flat"]);
    expect(updated.minBedrooms).toBeNull();
    expect(updated.maxPricePence).toBeNull();
    // outcodes re-resolved from the explicit-outcode text, deduped + sorted.
    expect(updated.outcodes).toEqual(["SE1", "SE16"]);

    // SET STATUS — active → paused.
    const paused = await searchRepository.setStatus(created.id, "paused", OWNER_A);
    expect(paused.status).toBe("paused");

    // DELETE — echoes the id, and the row is gone.
    const deleted = await searchRepository.delete(created.id, OWNER_A);
    expect(deleted).toEqual({ id: created.id });
    expect(await searchRepository.getById(created.id, OWNER_A)).toBeNull();
  });

  it("resolves outcodes from an explicit-outcode location on create", async () => {
    const created = await searchRepository.create(
      baseInput({ name: `${NAME_PREFIX}explicit`, location: "SE16, SE1" }),
      OWNER_A,
    );
    expect(created.outcodes).toEqual(["SE1", "SE16"]);
  });

  it("orders list by updatedAt desc (most recently touched first)", async () => {
    const first = await searchRepository.create(
      baseInput({ name: `${NAME_PREFIX}order-a`, location: "Conwy County" }),
      OWNER_A,
    );
    const second = await searchRepository.create(
      baseInput({ name: `${NAME_PREFIX}order-b`, location: "Gwynedd" }),
      OWNER_A,
    );
    // Wait a clock tick so `first`'s touch is STRICTLY newer than `second`'s
    // create — `updatedAt` is millisecond-resolution, so without this the desc
    // order can tie and flake (observed once on a fast run).
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Touch `first` so it becomes the most-recently-updated.
    await searchRepository.setStatus(first.id, "paused", OWNER_A);

    const listed = (await searchRepository.list(OWNER_A)).filter((s) =>
      s.name.startsWith(NAME_PREFIX),
    );
    const firstIdx = listed.findIndex((s) => s.id === first.id);
    const secondIdx = listed.findIndex((s) => s.id === second.id);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("isolates searches across owners — B cannot see or mutate A's search", async () => {
    const aSearch = await searchRepository.create(
      baseInput({ name: `${NAME_PREFIX}owner-a-private`, location: "Conwy County" }),
      OWNER_A,
    );

    // B's list + getById never surface A's search.
    const bList = await searchRepository.list(OWNER_B);
    expect(bList.some((s) => s.id === aSearch.id)).toBe(false);
    expect(await searchRepository.getById(aSearch.id, OWNER_B)).toBeNull();
    // The operator namespace (null) is also separate from A's.
    expect(await searchRepository.getById(aSearch.id, null)).toBeNull();

    // B's writes against A's id are no-ops that surface as P2025 (→ NOT_FOUND).
    await expect(
      searchRepository.update(
        { ...baseInput({ name: `${NAME_PREFIX}hijack` }), id: aSearch.id },
        OWNER_B,
      ),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(
      searchRepository.setStatus(aSearch.id, "paused", OWNER_B),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(
      searchRepository.delete(aSearch.id, OWNER_B),
    ).rejects.toMatchObject({ code: "P2025" });

    // A's search is untouched + still active.
    const stillThere = await searchRepository.getById(aSearch.id, OWNER_A);
    expect(stillThere?.status).toBe("active");
  });
});
