// @homeranger/backend-core public surface. Routers, services, repositories,
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

// Transaction helper — M4 services compose multi-repository writes (Listing +
// ListingSourceRecord) inside one transaction. The raw `prisma` client stays
// unexported; only `runTransaction` is surfaced (per the index.ts contract).
export { runTransaction } from "./lib/prisma.js";

// M4 queue layer (BullMQ): config + client + enqueue helpers. apps/api (webhook
// routes) and apps/processor (worker) import these. Deep imports
// (`@homeranger/backend-core/lib/queue/queue-client`) also resolve via the
// package.json "./*" wildcard; the barrel re-export keeps the type surface
// available to consumers that import from the package root.
export * from "./lib/queue/queue-config.js";
export * from "./lib/queue/queue-client.js";
export * from "./lib/queue/enqueue.js";
export * from "./lib/queue/redis-connection.js";

// M4 services (DI singletons) — the worker references these; exporting them
// keeps the service surface importable from the package root too.
export * from "./services/dedup.service.js";
export * from "./services/email-event.service.js";
export * from "./services/inbound-ingestion.service.js";
// M5 analysis services (DI singletons initialised at worker boot).
export * from "./services/listing-analysis.service.js";
export * from "./services/preference-match.service.js";
// M6 outreach + ComplianceGuard (DI singletons / worker-boot factory).
export * from "./services/outreach.service.js";
export * from "./services/outreach-reply.service.js";
export * from "./services/warmup.service.js";
export * from "./lib/compliance/compliance-guard.js";
export * from "./lib/email/email-provider.js";

// tRPC surface — the appRouter tree + its type (the SPA infers over AppRouter),
// and createContext (apps/api mounts the fastify tRPC plugin with these). The
// raw prisma client stays unexported (repositories own all Prisma access).
export { appRouter, type AppRouter } from "./routers/index.js";
export { createContext } from "./context.js";

// Supabase Auth identity + owner-key helpers. `ownerKeyFor`/`isOperator` are the
// single chokepoint routers use to scope per-user data; the integration tests +
// any admin tooling import the verifier surface from here.
export {
  isOperator,
  operatorEmail,
  ownerKeyFor,
  readSupabaseAuthConfigFromEnv,
  resolveSupabaseIdentity,
  verifySupabaseJwt,
  type SupabaseAuthConfig,
  type SupabaseIdentity,
} from "./lib/auth/supabase-auth.js";
