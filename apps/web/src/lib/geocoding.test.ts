/**
 * Unit tests for the client-side UK postcode geocoder. The map view turns each
 * home's postcode into a lat/lng via postcodes.io (free, keyless, UK open data),
 * caching every hit in localStorage so a postcode is only ever fetched once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocodePostcodes, normalizePostcode } from "./geocoding";

interface BulkEntry {
  query: string;
  result: { postcode: string; latitude: number; longitude: number } | null;
}

/** Stub global fetch with a single postcodes.io bulk response. */
function stubFetch(result: BulkEntry[]) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 200, result }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentPostcodes(fetchMock: ReturnType<typeof vi.fn>, call = 0): string[] {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string) ?? "{}").postcodes;
}

describe("normalizePostcode", () => {
  it("upper-cases and collapses internal whitespace", () => {
    expect(normalizePostcode(" se1  1aa ")).toBe("SE1 1AA");
    expect(normalizePostcode("m3 4lz")).toBe("M3 4LZ");
  });
});

describe("geocodePostcodes", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves coordinates from the postcodes.io bulk API", async () => {
    const fetchMock = stubFetch([
      { query: "SE1 1AA", result: { postcode: "SE1 1AA", latitude: 51.5, longitude: -0.09 } },
      { query: "M3 4LZ", result: { postcode: "M3 4LZ", latitude: 53.47, longitude: -2.25 } },
    ]);
    const out = await geocodePostcodes(["SE1 1AA", "M3 4LZ"]);
    expect(out.get("SE1 1AA")).toEqual({ lat: 51.5, lng: -0.09 });
    expect(out.get("M3 4LZ")).toEqual({ lat: 53.47, lng: -2.25 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentPostcodes(fetchMock)).toEqual(["SE1 1AA", "M3 4LZ"]);
  });

  it("normalizes and de-duplicates before hitting the network", async () => {
    const fetchMock = stubFetch([
      { query: "SE1 1AA", result: { postcode: "SE1 1AA", latitude: 51.5, longitude: -0.09 } },
    ]);
    await geocodePostcodes(["se1 1aa", "SE1 1AA", null, undefined, "  se1   1aa "]);
    expect(sentPostcodes(fetchMock)).toEqual(["SE1 1AA"]);
  });

  it("caches resolved postcodes so a second call skips the network", async () => {
    const fetchMock = stubFetch([
      { query: "SE1 1AA", result: { postcode: "SE1 1AA", latitude: 51.5, longitude: -0.09 } },
    ]);
    await geocodePostcodes(["SE1 1AA"]);
    const again = await geocodePostcodes(["se1 1aa"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.get("SE1 1AA")).toEqual({ lat: 51.5, lng: -0.09 });
  });

  it("omits postcodes the API cannot resolve", async () => {
    stubFetch([{ query: "ZZ99 9ZZ", result: null }]);
    const out = await geocodePostcodes(["ZZ99 9ZZ"]);
    expect(out.has("ZZ99 9ZZ")).toBe(false);
    expect(out.size).toBe(0);
  });

  it("never throws on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const out = await geocodePostcodes(["SE1 1AA"]);
    expect(out.size).toBe(0);
  });

  it("returns an empty map for empty input without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await geocodePostcodes([null, undefined, "", "   "]);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
