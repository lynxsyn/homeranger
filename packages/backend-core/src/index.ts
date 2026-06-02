// @homescout/backend-core public surface. Routers, services, repositories,
// trpc context, and provider interfaces (EmailProvider, EmbeddingProvider)
// are exported from here. M2 surfaces the repository layer + its shared
// lib helpers (prisma client + cursor pagination); later milestones add
// routers/services/providers.

// Repository layer (the ONLY place that touches Prisma). The raw `prisma`
// client is deliberately NOT re-exported from the package surface — routers and
// services must go through repositories (backend.md: "repositories own ALL
// Prisma"). When M4+ services need transactions, export `runTransaction`
// specifically here rather than the client.
export * from "./repositories/index.js";

// Cursor-pagination contract consumed by routers/services.
export * from "./lib/pagination/cursor.js";

// tRPC surface — the appRouter tree + its type (the SPA infers over AppRouter),
// and createContext (apps/api mounts the fastify tRPC plugin with these). The
// raw prisma client stays unexported (repositories own all Prisma access).
export { appRouter, type AppRouter } from "./routers/index.js";
export { createContext } from "./context.js";
