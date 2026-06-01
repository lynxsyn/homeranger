---
spec_id: M3-listings-table
status: queued
bump: minor
risk_class: tier-2
---

# Spec: M3 — Listings table read path (first demo)

## Why now

This is the product's core surface and the first demoable slice. Building it on fixtures (real data arrives at M4) proves the read path — router → service → repository → SPA table — and the click-out UX end-to-end before the riskier ingestion/AI/outreach milestones.

## Goal

A `listingsRouter` and a hand-rolled accessible `ListingsPage` that lists, filters, sorts, and paginates listings and links out to each listing's source URL.

## Non-goals

- Real ingestion (M4), AI scores (M5), outreach (M6/M7).
- A heavyweight table library — `apps/web` has `@tanstack/react-query` but NOT `@tanstack/react-table`; tables are hand-rolled.

## Acceptance criteria

1. `listingsRouter` (single `protectedProcedure` — one user, no tenant scoping per YAGNI) exposes: `list` (filter by outcode/price/beds/status, sort by `combinedScore`/price/`lastSeenAt`, cursor-paginated `{items,nextCursor}`), `getById`, and an `expand` payload (photo features + score rationale, null until M5).
2. Filters and sorts are applied in the repository (not in-memory); `list` defaults to 20/max 100.
3. `ListingsPage` (mirror `doxus .../OverviewFailuresTable.tsx`) renders a semantic `<table>` with `inferRouterOutputs`-typed rows, `<th scope="col">`, and a11y attributes.
4. The source-link cell is `<a href={row.listingUrl} target="_blank" rel="noreferrer">` and is omitted/disabled when `listingUrl` is null (email-only pre-market).
5. Filter controls (outcode, max price, min beds) and a sort selector drive the query via `@trpc/react-query`; empty/loading/error states render.
6. Row-expand reveals a placeholder for photo features + score (wired for real in M5).

## Allowed edit surface

- `packages/backend-core/src/routers/listings.router.ts` (+ service if needed) + `__tests__`.
- `apps/web/src/pages/ListingsPage.tsx` + table/filter components.
- `e2e/listings.spec.ts` (Playwright).
- Test fixtures/seed for listings.

## Test plan

| Layer | Coverage |
|---|---|
| Unit | `listingsRouter.list` applies outcode/price/beds filters + sort; pagination cursor round-trips; 20/100 bounds. |
| Unit | `getById` returns the row; unknown id → `TRPCError NOT_FOUND`. |
| E2E (Playwright) | `ListingsPage` loads seeded listings, filters by outcode + max price, sorts by match score, and a source-link cell click opens `listingUrl`. |
| E2E | A pre-market row with null `listingUrl` renders without a broken link. |

## Definition of Done

RED router + table tests first → GREEN · coverage ≥ threshold · E2E green against local dev (`browser-debugging.md`) · review APPROVED · release tag (MINOR) · post-release verify green.
