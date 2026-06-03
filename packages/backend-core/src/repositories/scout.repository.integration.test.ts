/**
 * Integration test for scoutRepository against a real pgvector Postgres (M8).
 * Proves the full CRUD round-trip — create → list → getById → update →
 * setStatus → delete — and that `outcodes` are RESOLVED server-side from the
 * free-text `location` on create + update (both a region-NAME location and an
 * explicit-outcode location).
 *
 * Gate: integration project only (VITEST_INTEGRATION=1 + DATABASE_URL).
 *
 * Cleanup: Scout has no `test-` natural key in the shared cleanupTestData
 * teardown, so this spec names its rows with a `test-scout-` prefix and removes
 * them itself in before/after hooks.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectTestPrisma, getTestPrisma } from "../test/db-helper.js";
import { scoutRepository, type CreateScoutInput } from "./scout.repository.js";

const db = getTestPrisma();
const NAME_PREFIX = "test-scout-";

async function cleanupScouts(): Promise<void> {
  await db.scout.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } });
}

function baseInput(overrides: Partial<CreateScoutInput> = {}): CreateScoutInput {
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
  await cleanupScouts();
});
afterEach(async () => {
  await cleanupScouts();
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe("scoutRepository CRUD round-trip (real pgvector)", () => {
  it("creates → lists → getById → updates → setStatus → deletes a scout", async () => {
    // CREATE — outcodes resolved from a region-NAME location.
    const created = await scoutRepository.create(
      baseInput({ name: `${NAME_PREFIX}roundtrip`, location: "Snowdonia, Gwynedd" }),
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
    const listed = await scoutRepository.list();
    expect(listed.some((s) => s.id === created.id)).toBe(true);

    // GET BY ID.
    const fetched = await scoutRepository.getById(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.outcodes).toEqual(created.outcodes);

    // UPDATE — full replace; new location re-resolves outcodes from EXPLICIT text.
    const updated = await scoutRepository.update({
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
    });
    expect(updated.location).toBe("SE16, SE1");
    expect(updated.types).toEqual(["Flat"]);
    expect(updated.minBedrooms).toBeNull();
    expect(updated.maxPricePence).toBeNull();
    // outcodes re-resolved from the explicit-outcode text, deduped + sorted.
    expect(updated.outcodes).toEqual(["SE1", "SE16"]);

    // SET STATUS — active → paused.
    const paused = await scoutRepository.setStatus(created.id, "paused");
    expect(paused.status).toBe("paused");

    // DELETE — echoes the id, and the row is gone.
    const deleted = await scoutRepository.delete(created.id);
    expect(deleted).toEqual({ id: created.id });
    expect(await scoutRepository.getById(created.id)).toBeNull();
  });

  it("resolves outcodes from an explicit-outcode location on create", async () => {
    const created = await scoutRepository.create(
      baseInput({ name: `${NAME_PREFIX}explicit`, location: "SE16, SE1" }),
    );
    expect(created.outcodes).toEqual(["SE1", "SE16"]);
  });

  it("orders list by updatedAt desc (most recently touched first)", async () => {
    const first = await scoutRepository.create(
      baseInput({ name: `${NAME_PREFIX}order-a`, location: "Conwy County" }),
    );
    const second = await scoutRepository.create(
      baseInput({ name: `${NAME_PREFIX}order-b`, location: "Gwynedd" }),
    );
    // Wait a clock tick so `first`'s touch is STRICTLY newer than `second`'s
    // create — `updatedAt` is millisecond-resolution, so without this the desc
    // order can tie and flake (observed once on a fast run).
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Touch `first` so it becomes the most-recently-updated.
    await scoutRepository.setStatus(first.id, "paused");

    const listed = (await scoutRepository.list()).filter((s) =>
      s.name.startsWith(NAME_PREFIX),
    );
    const firstIdx = listed.findIndex((s) => s.id === first.id);
    const secondIdx = listed.findIndex((s) => s.id === second.id);
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
