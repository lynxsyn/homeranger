/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional MapTiler API key. When set, the listings map uses MapTiler's calm
   * light/dark basemaps; without it the map falls back to Carto's keyless CDN.
   * Baked into the client bundle at build time, so it is PUBLIC — restrict it to
   * the app's domain(s) in the MapTiler dashboard.
   */
  readonly VITE_MAPTILER_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
