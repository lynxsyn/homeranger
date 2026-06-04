-- Per-search match scoring — re-key ListingScore to (listingId, searchId) + give
-- each Search its own taste vector.
--
-- BEFORE: the M5 match path scored every listing against ONE global SearchProfile
-- (single row, in practice empty), so analyze:listing logged
-- `match.score.skipped.empty_profile` and wrote NO ListingScore (prod
-- listing_scores=0). The Match ring was always blank.
--
-- AFTER: a listing is scored against the taste (keywords + brief) of each active
-- operator Search whose outcodes contain it, so two searches rank the same home
-- differently. A listing has ONE ListingScore PER search; the link-through shows
-- the viewed search's score, the unfiltered table shows MAX(combinedScore) across
-- the operator's searches.
--
-- Hand-authored to match the NNNN_name convention of 0001..0010 (homeranger does
-- NOT use Prisma's timestamped dirs); the DDL is exactly what `prisma migrate
-- diff` emits for these schema.prisma changes. pgvector was enabled in 0002.

-- ── 1. Search gains its taste vector ─────────────────────────────────────────
-- Voyage voyage-3.5 vector(1024); Unsupported (raw SQL read/write — Prisma has no
-- vector type), mirroring SearchProfile.preferenceEmbedding. NO HNSW index: we
-- read ONE search's vector and KNN-search Listings, never the reverse.
ALTER TABLE "Search" ADD COLUMN "keywordsEmbedding" vector(1024);

-- ── 2. Re-key ListingScore: one-per-listing → one-per-(listing, search) ──────
-- The existing rows are STALE empty global-SearchProfile scores (the retired M5
-- match path; prod has 0 rows) with NO real search association — backfilling them
-- to an arbitrary search would fabricate bogus per-search data, so they are
-- DELETEd. This runs at migrate time (prisma:deploy / integration globalSetup),
-- never mid-test; integration tests create their own (listingId, searchId) rows
-- afterward. DELETE precedes ADD COLUMN NOT NULL so the empty table accepts the
-- non-defaulted NOT NULL column.
DELETE FROM "ListingScore";

-- Drop the old single-listing unique + the global combinedScore index (the score
-- is no longer global; ordering is now per-search).
DROP INDEX "ListingScore_listingId_key";
DROP INDEX "ListingScore_combinedScore_idx";

ALTER TABLE "ListingScore" ADD COLUMN "searchId" UUID NOT NULL;

-- A deleted search cascades its scores away (mirrors the listingId FK).
ALTER TABLE "ListingScore"
    ADD CONSTRAINT "ListingScore_searchId_fkey"
    FOREIGN KEY ("searchId") REFERENCES "Search"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One score per (listing, search). The unique's listingId prefix also serves the
-- MAX(combinedScore) GROUP BY listingId the unfiltered listings table uses.
CREATE UNIQUE INDEX "ListingScore_listingId_searchId_key" ON "ListingScore"("listingId", "searchId");

-- Per-search ordering (the link-through's ORDER BY combinedScore) + the
-- searchId-prefix the FK cascade delete uses.
CREATE INDEX "ListingScore_searchId_combinedScore_idx" ON "ListingScore"("searchId", "combinedScore" DESC);

-- ListingScore + Search are EXISTING tables → 0003's table-level grants already
-- cover the new columns (mirrors 0006/0007); no GRANT statement is needed here.
