-- Add two read-only, link-out scraped listing sources to the ListingSource enum
-- (Listing.primarySource + ListingSourceRecord.sourceType). Decision:
-- docs/decisions/2026-06-05-listing-site-ingestion.md. These are a data source
-- only — never an outreach target.
--
-- Hand-authored to match the NNNN_name convention of 0001..0011 (homeranger does
-- NOT use Prisma's timestamped dirs); this is exactly what `prisma migrate diff`
-- emits for adding enum values. Pure additive — no existing rows change, no GRANT
-- needed (ALTER TYPE follows the type's existing ACL). Postgres 12+ permits
-- ADD VALUE in a migration transaction since the new values are not used in the
-- same transaction.

-- AlterEnum
ALTER TYPE "ListingSource" ADD VALUE 'uklandandfarms';
ALTER TYPE "ListingSource" ADD VALUE 'auctionhouse';
