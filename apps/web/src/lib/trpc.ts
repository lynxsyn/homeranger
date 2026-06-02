/**
 * Typed tRPC React client for the homescout SPA.
 *
 * Mirrors the Doxus web client: `createTRPCReact<AppRouter>()` for the hooks
 * namespace + a client whose `httpBatchLink` carries `transformer: superjson`
 * (the v11 breaking change — the transformer lives ON THE LINK, and MUST match
 * the server's `initTRPC(...).create({ transformer: superjson })` or Date
 * payloads corrupt). A custom `fetch` adds `credentials: "include"` so the
 * Cloudflare Access cookie rides along in prod (in dev/E2E auth is bypassed).
 *
 * URL is the relative `/trpc` — same-origin in prod (behind CF Access),
 * proxied to :3000 by Vite in dev (see vite.config.ts). No VITE_API_URL needed.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import SuperJSON from "superjson";
import type { AppRouter } from "@homescout/backend-core";

export const trpc = createTRPCReact<AppRouter>();

const fetchWithCredentials: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: "include" });

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
      fetch: fetchWithCredentials,
    }),
  ],
});
