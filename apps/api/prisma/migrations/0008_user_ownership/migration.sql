-- Multi-user ownership — Supabase Auth identity scoping (Supabase = AUTH only;
-- data stays in this pgvector Postgres).
--
-- Adds a nullable owner key (`userId`, the Supabase JWT `sub`) to the per-user
-- aggregates and introduces the per-user SavedListing overlay. The convention:
-- `userId IS NULL` is the OPERATOR / default namespace (the existing single-user
-- rows + whatever the outreach + AI-matching engine reads with no request
-- context), and every authenticated non-operator user gets their own namespace.
--
-- Migration-safe by construction: the new columns are NULLABLE with no backfill,
-- so the existing Scout rows and the SearchProfile singleton (id
-- 00000000-0000-0000-0000-000000000001) simply stay in the operator namespace.
-- Hand-authored to match the NNNN_name convention of 0001..0007 (homeranger does
-- NOT use Prisma's timestamped dirs); the COALESCE-based unique index is raw
-- (Prisma cannot express a NULL-safe expression index) exactly like the pgvector
-- HNSW index is raw — so it lives here, not in the schema's @@ attributes.

-- ── Scout: per-user ownership ────────────────────────────────────────────────
-- Existing table → 0003's grants already cover the new column; no GRANT needed.
ALTER TABLE "Scout" ADD COLUMN "userId" UUID;
CREATE INDEX "Scout_userId_idx" ON "Scout" ("userId");

-- ── SearchProfile: per-user ownership ────────────────────────────────────────
-- Unique so each owner has exactly one profile. The legacy singleton row keeps
-- userId NULL (distinct NULLs never collide in a UNIQUE index, so the singleton
-- and any future per-user rows coexist). Existing table → no GRANT needed.
ALTER TABLE "SearchProfile" ADD COLUMN "userId" UUID;
CREATE UNIQUE INDEX "SearchProfile_userId_key" ON "SearchProfile" ("userId");

-- ── SavedListing: per-user "interested" overlay on the global catalogue ───────
CREATE TABLE "SavedListing" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "listingId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SavedListing_pkey" PRIMARY KEY ("id")
);

-- FK to the shared Listing; a deleted listing drops its saves.
ALTER TABLE "SavedListing"
    ADD CONSTRAINT "SavedListing_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "Listing" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One save per (owner, listing). COALESCE collapses the operator's NULL owner to
-- a fixed sentinel so the operator's saves are deduped per listing too (a plain
-- UNIQUE(userId, listingId) would let duplicate NULL-owner rows through since
-- NULLs are distinct). Raw expression index — not representable in schema.prisma.
CREATE UNIQUE INDEX "SavedListing_owner_listing_key"
    ON "SavedListing" (COALESCE("userId", '00000000-0000-0000-0000-000000000000'::uuid), "listingId");
CREATE INDEX "SavedListing_userId_idx" ON "SavedListing" ("userId");
CREATE INDEX "SavedListing_listingId_idx" ON "SavedListing" ("listingId");

-- New table → grant explicitly (mirrors 0004/0005/0006) so a missing privilege
-- can never silently 500 the app in prod (post-release-verify only probes
-- /api/version, so it would not catch a GRANT gap).
GRANT SELECT, INSERT, UPDATE, DELETE ON "SavedListing" TO "homeranger";
