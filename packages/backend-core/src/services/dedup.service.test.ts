/**
 * Unit tests for DedupService (M4 test plan, Unit: DedupService — same address
 * two emails → one Listing; near-duplicate via embedding fallback merges). Uses
 * a fake ListingRepository (no DB): a stubbed getByAddressNormalized + vectorTopK.
 */
import { describe, expect, it } from "vitest";
import { DefaultDedupService } from "./dedup.service.js";
import type {
  ListingRecord,
  VectorTopKResult,
} from "../repositories/listing.repository.js";

function makeRow(overrides: Partial<ListingRecord> = {}): ListingRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "00000000-0000-7000-8000-0000000000aa",
    addressNormalized: "12 ACACIA AVENUE SW1A 1AA",
    postcode: "SW1A 1AA",
    outcode: "SW1A",
    pricePence: 45_000_000,
    bedrooms: 3,
    tenure: null,
    propertyType: null,
    epcRating: null,
    listingStatus: "pre_market",
    isPreMarket: true,
    listingUrl: null,
    primarySource: "agent_email",
    bathrooms: 2,
    agentEmail: null,
    agencyName: null,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeRepoOpts {
  byAddress?: Map<string, ListingRecord>;
  vectorHit?: VectorTopKResult | null;
}

function fakeRepo(opts: FakeRepoOpts = {}) {
  const byAddress = opts.byAddress ?? new Map<string, ListingRecord>();
  return {
    async getByAddressNormalized(key: string): Promise<ListingRecord | null> {
      return byAddress.get(key) ?? null;
    },
    async vectorTopK(): Promise<VectorTopKResult[]> {
      return opts.vectorHit ? [opts.vectorHit] : [];
    },
  } as unknown as import("../repositories/listing.repository.js").ListingRepository;
}

describe("DedupService.normaliseAddress", () => {
  it("builds a deterministic canonical key from address + postcode", () => {
    const svc = new DefaultDedupService({ listingRepository: fakeRepo() });
    const key = svc.normaliseAddress("12 Acacia Avenue, London", "sw1a1aa");
    expect(key).toBe("12 ACACIA AVENUE LONDON SW1A 1AA");
  });

  it("strips an inline postcode from the free-text line so it is not doubled", () => {
    const svc = new DefaultDedupService({ listingRepository: fakeRepo() });
    const key = svc.normaliseAddress("12 Acacia Avenue SW1A 1AA", "SW1A 1AA");
    expect(key).toBe("12 ACACIA AVENUE SW1A 1AA");
  });

  it("returns null when there is no keyable address or postcode", () => {
    const svc = new DefaultDedupService({ listingRepository: fakeRepo() });
    expect(svc.normaliseAddress("", null)).toBeNull();
  });
});

describe("DedupService.find", () => {
  it("returns an exact match (same canonical address → existing listing)", async () => {
    const existing = makeRow({ addressNormalized: "12 ACACIA AVENUE SW1A 1AA" });
    const svc = new DefaultDedupService({
      listingRepository: fakeRepo({
        byAddress: new Map([["12 ACACIA AVENUE SW1A 1AA", existing]]),
      }),
    });
    const result = await svc.find({
      addressRaw: "12 Acacia Avenue",
      postcode: "SW1A 1AA",
    });
    expect(result.matchedBy).toBe("exact");
    expect(result.listingId).toBe(existing.id);
    expect(result.addressNormalized).toBe("12 ACACIA AVENUE SW1A 1AA");
  });

  it("falls back to the embedding match when no exact hit and distance ≤ threshold", async () => {
    const near = { ...makeRow({ id: "near-id" }), distance: 0.05 };
    const svc = new DefaultDedupService({
      listingRepository: fakeRepo({ vectorHit: near }),
      embeddingDistanceThreshold: 0.12,
    });
    const result = await svc.find({
      addressRaw: "Different wording, same place",
      postcode: null,
      embedding: new Array(1024).fill(0.01),
    });
    expect(result.matchedBy).toBe("embedding");
    expect(result.listingId).toBe("near-id");
  });

  it("does NOT merge when the nearest embedding is beyond the threshold", async () => {
    const far = { ...makeRow({ id: "far-id" }), distance: 0.4 };
    const svc = new DefaultDedupService({
      listingRepository: fakeRepo({ vectorHit: far }),
      embeddingDistanceThreshold: 0.12,
    });
    const result = await svc.find({
      addressRaw: "Totally different property",
      postcode: null,
      embedding: new Array(1024).fill(0.01),
    });
    expect(result.matchedBy).toBeNull();
    expect(result.listingId).toBeNull();
  });

  it("returns no match (exact-only) when no embedding is supplied and no exact hit", async () => {
    const svc = new DefaultDedupService({ listingRepository: fakeRepo() });
    const result = await svc.find({
      addressRaw: "99 Nowhere Street",
      postcode: "EC1A 1BB",
    });
    expect(result.listingId).toBeNull();
    expect(result.matchedBy).toBeNull();
    expect(result.addressNormalized).toBe("99 NOWHERE STREET EC1A 1BB");
  });
});
