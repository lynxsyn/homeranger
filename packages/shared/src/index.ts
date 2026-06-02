// @homescout/shared public surface. Zod schemas, shared enums, and UK
// constants shared between web and backend-core are exported from here.
// Barrel pattern mirrors Doxus (`doxus .../packages/shared/src/index.ts`):
// re-export from each module with explicit `.js` extensions (Node16 module
// resolution requires them) so consumers import from `@homescout/shared`.

// Listing domain enums (single source of truth with the Prisma schema).
export * from "./listing-enums.js";

// UK postal-geography constants + normalisation helpers.
export * from "./uk.js";

// Cursor-pagination primitives ({ items, nextCursor }, default 20 / max 100).
export * from "./pagination.js";

// Listing list/filter/sort input contract (drives listingsRouter.list).
export * from "./listing-query.js";

// SearchProfile update contract (drives preferencesRouter.update + the form).
export * from "./preferences.js";

// Scout domain enums + option sets (status / types / condition / land / sale).
export * from "./scout-enums.js";

// Scout input contracts (drives scoutsRouter create/update/setStatus/byId).
export * from "./scouts.js";

// Outreach control contracts (drives outreachRouter.killSwitch toggle).
export * from "./outreach.js";
