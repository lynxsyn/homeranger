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
