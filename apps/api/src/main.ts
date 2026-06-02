/**
 * homescout API entrypoint — Fastify 5 + tRPC 11 (Cloudflare Access auth).
 *
 * Wiring mirrors doxus-web/apps/control-plane-api/main.ts, minus SuperTokens:
 *   1. @fastify/cors + @fastify/formbody.
 *   2. Raw Fastify routes (/api/health, /api/version) registered BEFORE the
 *      tRPC plugin so they are not swallowed by the tRPC catch-all (the
 *      load-bearing ordering from control-plane-api/main.ts).
 *   3. fastifyTRPCPlugin LAST, at prefix /trpc, with the appRouter +
 *      createContext from @homescout/backend-core.
 *
 * Auth is entirely in createContext (CF Access JWT, dev-bypass when CF env
 * unset). No SuperTokens plugin/init.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import {
  appRouter,
  createContext,
  type AppRouter,
} from "@homescout/backend-core";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

const server = Fastify({ logger: true });

await server.register(cors, {
  origin: webOrigin,
  credentials: true,
});
await server.register(formbody);

// Raw routes BEFORE the tRPC plugin (not caught by the tRPC catch-all).
server.get("/api/health", async () => ({ status: "ok" }));
server.get("/api/version", async () => ({
  service: "homescout-api",
  gitSha: process.env.GIT_SHA ?? "unknown",
}));

await server.register(fastifyTRPCPlugin, {
  prefix: "/trpc",
  trpcOptions: {
    router: appRouter,
    createContext,
  } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
});

// Graceful shutdown on SIGTERM/SIGINT.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      server.log.info(`Received ${signal}, shutting down`);
      await server.close();
    } finally {
      process.exit(0);
    }
  });
}

try {
  await server.listen({ port, host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
