-- DismissedListing — the per-user "hidden" overlay on the global Listing
-- catalogue. The exact mirror of SavedListing (migration 0008), opposite intent:
-- a dismiss buries a home from the buyer's working feed. Reversible (restore =
-- DELETE the row) and silent (never communicated to the agent). The two overlays
-- (saved / dismissed) are independent; the SPA computes the Active / Saved /
-- Dismissed buckets from the two id sets.
--
-- Hand-authored to match the NNNN_name convention of 0001..0009 (homeranger does
-- NOT use Prisma's timestamped dirs); the COALESCE-based unique index is raw
-- (Prisma cannot express a NULL-safe expression index) exactly like SavedListing
-- and the pgvector HNSW index are raw — so it lives here, not in schema.prisma.
-- Migration-safe by construction: a brand-new table, no backfill.

-- ── DismissedListing: per-user "hidden" overlay on the global catalogue ───────
CREATE TABLE "DismissedListing" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "listingId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DismissedListing_pkey" PRIMARY KEY ("id")
);

-- FK to the shared Listing; a deleted listing drops its dismissals.
ALTER TABLE "DismissedListing"
    ADD CONSTRAINT "DismissedListing_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "Listing" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One dismissal per (owner, listing). COALESCE collapses the operator's NULL
-- owner to a fixed sentinel so the operator's dismissals are deduped per listing
-- too (a plain UNIQUE(userId, listingId) would let duplicate NULL-owner rows
-- through since NULLs are distinct). Raw expression index — not representable in
-- schema.prisma. Lets `dismiss` be idempotent (re-dismiss = ON CONFLICT no-op).
CREATE UNIQUE INDEX "DismissedListing_owner_listing_key"
    ON "DismissedListing" (COALESCE("userId", '00000000-0000-0000-0000-000000000000'::uuid), "listingId");
CREATE INDEX "DismissedListing_userId_idx" ON "DismissedListing" ("userId");
CREATE INDEX "DismissedListing_listingId_idx" ON "DismissedListing" ("listingId");

-- New table → grant explicitly (mirrors 0004/0005/0006/0008) so a missing
-- privilege can never silently 500 the app in prod (post-release-verify only
-- probes /api/version, so it would not catch a GRANT gap).
GRANT SELECT, INSERT, UPDATE, DELETE ON "DismissedListing" TO "homeranger";
