/**
 * Typed tRPC React client for the homeranger SPA.
 *
 * Mirrors the Doxus web client: `createTRPCReact<AppRouter>()` for the hooks
 * namespace + a client whose `httpBatchLink` carries `transformer: superjson`
 * (the v11 breaking change — the transformer lives ON THE LINK, and MUST match
 * the server's `initTRPC(...).create({ transformer: superjson })` or Date
 * payloads corrupt).
 *
 * AUTH: a custom `fetch` attaches the Supabase access token as
 * `Authorization: Bearer <jwt>` when the user is signed in — the API's
 * createContext verifies it. With no session (the E2E/dev bypass, where nobody
 * logs in) no header is sent and the API takes its own dev bypass.
 * `credentials: "include"` is kept so the request still rides the CF tunnel.
 *
 * URL is the relative `/trpc` — same-origin in prod (behind the tunnel),
 * proxied to :3000 by Vite in dev (see vite.config.ts). No VITE_API_URL needed.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import SuperJSON from "superjson";
import type { AppRouter } from "@homeranger/backend-core";
import { AUTH_BYPASS, supabase } from "./supabase";

export const trpc = createTRPCReact<AppRouter>();

const authedFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  // Skip the session lookup entirely under the E2E/dev bypass — there is no
  // login, so no token, and avoiding the per-request async getSession() hop
  // keeps requests snappy (the API takes its own dev bypass).
  if (!AUTH_BYPASS) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }
  }
  return fetch(input, { ...init, headers, credentials: "include" });
};

export const trpcClient = trpc.createClient({
  links: [
    loggerLink({
      enabled: (opts) =>
        import.meta.env.DEV ||
        (opts.direction === "down" && opts.result instanceof Error),
    }),
    httpBatchLink({
      url: "/trpc",
      transformer: SuperJSON,
      fetch: authedFetch,
    }),
  ],
});
