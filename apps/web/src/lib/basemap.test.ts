/**
 * Unit tests for the basemap tile-source resolver. MapTiler is the preferred
 * provider (set VITE_MAPTILER_KEY); without a key it falls back to Carto's
 * keyless light/dark basemap CDN so the map ships and tests run with no secret.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { basemapFor } from "./basemap";

describe("basemapFor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the keyless Carto basemap when no MapTiler key is set", () => {
    vi.stubEnv("VITE_MAPTILER_KEY", "");
    const light = basemapFor("light");
    expect(light.url).toContain("basemaps.cartocdn.com");
    expect(light.url).toContain("light_all");
    expect(light.attribution).toMatch(/OpenStreetMap/);
    expect(light.attribution).toMatch(/CARTO/);

    expect(basemapFor("dark").url).toContain("dark_all");
  });

  it("uses MapTiler with the key when VITE_MAPTILER_KEY is provided", () => {
    vi.stubEnv("VITE_MAPTILER_KEY", "test-key-123");
    const light = basemapFor("light");
    expect(light.url).toContain("api.maptiler.com");
    expect(light.url).toContain("dataviz-light");
    expect(light.url).toContain("key=test-key-123");
    expect(light.attribution).toMatch(/MapTiler/);
    expect(light.attribution).toMatch(/OpenStreetMap/);

    const dark = basemapFor("dark");
    expect(dark.url).toContain("dataviz-dark");
    expect(dark.url).toContain("key=test-key-123");
  });
});
