/**
 * Supabase browser client for the SPA.
 *
 * Reads the PUBLIC project config from Vite env (`VITE_SUPABASE_URL` /
 * `VITE_SUPABASE_ANON_KEY`) — both are publishable, client-side values (the anon
 * key is designed to ship in the bundle), so they live in `.env` for dev/E2E and
 * are passed as build args (from a CI variable) for the prod image. No secret is
 * embedded. The URL falls back to the project hostname (not key-shaped) so a
 * misconfigured build still resolves the right project; the anon key falls back
 * to a harmless non-empty sentinel so `createClient` never throws at import — in
 * that case real auth fails (a misconfig) but the app still mounts (and, under
 * the E2E bypass below, never touches Supabase at all).
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "https://jdaklyjwxymrahnbuczi.supabase.co";
const ANON_SENTINEL = "anon-key-not-configured";
// `||` so an EMPTY repo var (an unset CI variable resolves the build-arg to "")
// collapses to the sentinel too, not just genuine undefined.
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || ANON_SENTINEL;

/**
 * When `VITE_E2E_AUTH_BYPASS === "1"` the SPA treats the user as the signed-in
 * operator WITHOUT a Supabase session (and the tRPC client sends no token, so
 * the API takes its own dev bypass). This is the frontend twin of the backend's
 * SUPABASE_URL-unset dev bypass — the linchpin that lets the existing E2E suite
 * run against the app without a real Supabase login. NEVER set in the prod build.
 */
export const AUTH_BYPASS = import.meta.env.VITE_E2E_AUTH_BYPASS === "1";

// Loud, not silent: a real (non-bypass) build with no anon key would otherwise
// mount fine and only fail when a user tries to sign in. Surface the misconfig
// at boot so a missing `VITE_SUPABASE_ANON_KEY` build var is obvious in the
// browser console rather than a mysterious "Invalid API key" on submit.
if (!AUTH_BYPASS && SUPABASE_ANON_KEY === ANON_SENTINEL) {
  console.error(
    "[homeranger] VITE_SUPABASE_ANON_KEY is not configured — Supabase sign-in " +
      "will fail. Set the repo variable / .env value and rebuild.",
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // SPA email+password flow — no magic-link/OAuth redirect to parse.
    detectSessionInUrl: false,
    storageKey: "hr-auth",
  },
});
