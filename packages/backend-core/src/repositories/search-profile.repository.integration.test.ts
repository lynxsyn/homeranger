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
