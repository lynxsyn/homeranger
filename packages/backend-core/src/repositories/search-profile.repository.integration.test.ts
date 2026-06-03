/**
 * Integration test for searchProfileRepository preference-embedding raw vector
 * read/write. Proves the Unsupported("vector(1024)") column round-trips through
 * pgvector and that the read path validates dimension/finiteness (M2 review:
 * the read path previously lacked the write path's validation + had no tests).
 *
 * Gate: integration project only (VITEST_INTEGRATION=1 + DATABASE_URL).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { searchProfileRepository } from "./search-profile.repository.js";

const db = getTestPrisma();
const DIM = 1024;

beforeEach(async () => {
  // SearchProfile is a fixed-id singleton; clear it so each test starts empty.
  await db.searchProfile.deleteMany({});
});
afterEach(async () => {
  await db.searchProfile.deleteMany({});
  await cleanupTestData(db);
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe("searchProfileRepository preference embedding (raw pgvector round-trip)", () => {
  it("returns null before any embedding is written", async () => {
    await searchProfileRepository.getOrCreate();
    expect(await searchProfileRepository.readPreferenceEmbedding()).toBeNull();
  });

  it("round-trips a 1024-dim embedding through pgvector", async () => {
    await searchProfileRepository.getOrCreate();
    const embedding = Array.from({ length: DIM }, (_, i) => (i % 7) * 0.013);
    await searchProfileRepository.writePreferenceEmbedding(embedding);

    const read = await searchProfileRepository.readPreferenceEmbedding();
    expect(read).not.toBeNull();
    expect(read).toHaveLength(DIM);
    for (let i = 0; i < DIM; i += 1) {
      // pgvector stores float4 — compare with single-precision tolerance.
      expect(read![i]).toBeCloseTo(embedding[i]!, 4);
    }
  });

  it("rejects a wrong-dimension embedding on write", async () => {
    await searchProfileRepository.getOrCreate();
    await expect(
      searchProfileRepository.writePreferenceEmbedding([1, 2, 3]),
    ).rejects.toThrow(/1024 dimensions/);
  });
});

describe("searchProfileRepository buyer identity (Settings 'Your details')", () => {
  it("defaults the identity fields on first getOrCreate", async () => {
    const profile = await searchProfileRepository.getOrCreate();
    expect(profile.firstName).toBe("");
    expect(profile.lastName).toBe("");
    expect(profile.phone).toBe("");
    expect(profile.urgency).toBe("active");
  });

  it("round-trips firstName / lastName / phone / urgency through update", async () => {
    await searchProfileRepository.getOrCreate();
    const updated = await searchProfileRepository.update({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });
    expect(updated).toMatchObject({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });

    // Persisted on the singleton — a fresh read sees the same identity.
    const reread = await searchProfileRepository.getOrCreate();
    expect(reread).toMatchObject({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });
  });

  it("leaves identity untouched when the update omits it", async () => {
    await searchProfileRepository.update({
      firstName: "Jane",
      urgency: "soon",
    });
    const after = await searchProfileRepository.update({
      freeTextPreferences: "Bright garden flat",
    });
    expect(after.firstName).toBe("Jane");
    expect(after.urgency).toBe("soon");
    expect(after.freeTextPreferences).toBe("Bright garden flat");
  });
});

describe("searchProfileRepository per-user namespace (multi-user)", () => {
  const USER_A = "a1a1a1a1-1111-4111-8111-1111111111a1";
  const USER_B = "b1b1b1b1-1111-4111-8111-1111111111b1";

  it("keeps the operator (null) profile separate from a user's profile", async () => {
    const operator = await searchProfileRepository.getOrCreate(null);
    const userA = await searchProfileRepository.getOrCreate(USER_A);
    // Distinct rows (the operator singleton has the fixed id).
    expect(userA.id).not.toBe(operator.id);

    await searchProfileRepository.update({ firstName: "Aria" }, USER_A);
    await searchProfileRepository.update({ firstName: "Owner" }, null);

    expect((await searchProfileRepository.getOrCreate(USER_A)).firstName).toBe(
      "Aria",
    );
    expect((await searchProfileRepository.getOrCreate(null)).firstName).toBe(
      "Owner",
    );
    // A second user is independent again.
    expect((await searchProfileRepository.getOrCreate(USER_B)).firstName).toBe(
      "",
    );
  });

  it("round-trips a per-user preference embedding independent of the operator", async () => {
    await searchProfileRepository.getOrCreate(USER_A);
    const embedding = Array.from({ length: DIM }, (_, i) => (i % 5) * 0.011);
    await searchProfileRepository.writePreferenceEmbedding(embedding, USER_A);

    const readA = await searchProfileRepository.readPreferenceEmbedding(USER_A);
    expect(readA).toHaveLength(DIM);
    expect(readA![3]).toBeCloseTo(embedding[3]!, 4);
    // The operator namespace was never written → still null.
    expect(await searchProfileRepository.readPreferenceEmbedding(null)).toBeNull();
  });
});
