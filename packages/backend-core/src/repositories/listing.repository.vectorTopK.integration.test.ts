/**
 * Integration test for listingRepository.vectorTopK.
 *
 * Proves cosine nearest-first ordering on hand-built 1024-dim vectors, plus the
 * optional structured pre-filter (outcode). Runs against a live pgvector
 * Postgres (docker-compose + `prisma migrate deploy`).
 *
 * Gate: skipped unless VITEST_INTEGRATION=1 (mirrors Doxus repo integration
 * specs, e.g. oauth-connection.repository.integration.test.ts).
 *
 * RED until M2 GREEN lands:
 *   - apps/api/prisma/schema.prisma (Listing model + enums)
 *   - the raw pgvector migration (vector(1024) + HNSW index)
 *   - packages/backend-core/src/repositories/listing.repository.ts exporting
 *     `listingRepository.vectorTopK(embedding, k, filter?)`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { listingRepository } from "./listing.repository.js";

const db = getTestPrisma();
const TEST_PREFIX = "m2-listing-vectortopk";
const DIM = 1024;

/** Build a deterministic 1024-dim vector with `value` in slot 0, `rest` elsewhere. */
function vec(value: number, rest = 0): number[] {
  const v = new Array<number>(DIM).fill(rest);
  v[0] = value;
  return v;
}

/** pgvector literal: "[1,0,0,...]". */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * Insert a Listing with a raw embedding. Prisma maps `embedding` as
 * Unsupported("vector(1024)"), so the column is written via $executeRawUnsafe.
 */
async function seedListing(args: {
  addressNormalized: string;
  outcode: string;
  embedding: number[];
}): Promise<string> {
  const listing = await db.listing.create({
    data: {
      addressNormalized: args.addressNormalized,
      outcode: args.outcode,
      listingStatus: "live",
      isPreMarket: false,
      primarySource: "agent_email",
    },
    select: { id: true },
  });
  await db.$executeRawUnsafe(
    `UPDATE "Listing" SET "embedding" = $1::vector WHERE "id" = $2::uuid`,
    toVectorLiteral(args.embedding),
    listing.id,
  );
  return listing.id;
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "listingRepository.vectorTopK (cosine, pgvector)",
  () => {
    let nearId: string;
    let midId: string;
    let farId: string;

    beforeAll(async () => {
      // Query vector points along slot 0. Cosine distance grows as the stored
      // vector tilts away from [1,0,0,...].
      nearId = await seedListing({
        addressNormalized: `test-${TEST_PREFIX}-near`,
        outcode: "SW1A",
        embedding: vec(1, 0), // identical direction -> distance 0
      });
      midId = await seedListing({
        addressNormalized: `test-${TEST_PREFIX}-mid`,
        outcode: "SW1A",
        embedding: vec(1, 0.5), // tilted -> larger cosine distance
      });
      farId = await seedListing({
        addressNormalized: `test-${TEST_PREFIX}-far`,
        outcode: "E1",
        embedding: vec(0, 1), // orthogonal -> distance ~1
      });
    });

    afterAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await disconnectTestPrisma();
    });

    it("returns rows nearest-first by cosine distance", async () => {
      const query = vec(1, 0);
      const results = await listingRepository.vectorTopK(query, 3);

      expect(results.map((r) => r.id)).toEqual([nearId, midId, farId]);
      // Distances must be monotonically non-decreasing.
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.distance).toBeGreaterThanOrEqual(
          results[i - 1]!.distance,
        );
      }
      expect(results[0]!.distance).toBeCloseTo(0, 5);
    });

    it("respects k (limit)", async () => {
      const results = await listingRepository.vectorTopK(vec(1, 0), 2);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id)).toEqual([nearId, midId]);
    });

    it("applies an optional structured outcode pre-filter before ranking", async () => {
      const results = await listingRepository.vectorTopK(vec(1, 0), 10, {
        outcodes: ["E1"],
      });
      expect(results.map((r) => r.id)).toEqual([farId]);
    });
  },
);
