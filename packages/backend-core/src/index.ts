// @homescout/backend-core public surface. Routers, services, repositories,
// trpc context, and provider interfaces (EmailProvider, EmbeddingProvider)
// are exported from here. M2 surfaces the repository layer + its shared
// lib helpers (prisma client + cursor pagination); later milestones add
// routers/services/providers.

// Repository layer (the ONLY place that touches Prisma).
export * from "./repositories/index.js";

// Shared lib helpers consumed by routers/services.
export * from "./lib/prisma.js";
export * from "./lib/pagination/cursor.js";
