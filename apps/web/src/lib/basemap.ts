/**
 * Basemap tile source for the listings map.
 *
 * MapTiler is the preferred provider — set VITE_MAPTILER_KEY (baked into the
 * build) and the map uses MapTiler's calm `dataviz` light/dark styles. With no
 * key it falls back to Carto's keyless light/dark basemap CDN, so the map ships
 * and the tests run with no secret, and never goes blank if the key has an
 * issue. Both are OpenStreetMap-derived raster tiles (attribution required).
 *
 * The basemap follows the app's light/dark theme (picking a tile style is just
 * a different URL — no extra dependency).
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
export type Theme = "light" | "dark";

export interface BasemapTiles {
  /** Leaflet tile URL template. */
  url: string;
  /** Attribution HTML (OSM is always required; provider added per source). */
  attribution: string;
  /** Tile subdomain rotation (Carto serves a/b/c/d). */
  subdomains?: string;
  maxZoom: number;
}

const OSM =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function carto(theme: Theme): BasemapTiles {
  const style = theme === "dark" ? "dark_all" : "light_all";
  return {
    url: `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`,
    attribution: `${OSM} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    subdomains: "abcd",
    maxZoom: 20,
  };
}

function maptiler(theme: Theme, key: string): BasemapTiles {
  const style = theme === "dark" ? "dataviz-dark" : "dataviz-light";
  return {
    url: `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${key}`,
    attribution: `${OSM} &copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a>`,
    maxZoom: 20,
  };
}

/** Resolve the tile source for the active theme (MapTiler if keyed, else Carto). */
export function basemapFor(theme: Theme): BasemapTiles {
  const key = import.meta.env.VITE_MAPTILER_KEY;
  return key ? maptiler(theme, key) : carto(theme);
}
