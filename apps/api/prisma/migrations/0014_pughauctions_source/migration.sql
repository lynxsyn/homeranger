-- Add a third read-only, link-out scraped listing source to the ListingSource
-- enum (Listing.primarySource + ListingSourceRecord.sourceType): pughauctions
-- (Pugh Auctions, www.pugh-auctions.com). Decision:
-- docs/decisions/2026-06-05-listing-site-ingestion.md (amended 2026-06-05 to add
-- Pugh: ToS expressly permits personal use; a national auction catalogue
-- scraped link-out-only). A data source only — never an outreach target.
--
-- Hand-authored to match the NNNN_name convention (homeranger does NOT use
-- Prisma's timestamped dirs); this is exactly what `prisma migrate diff` emits
-- for adding an enum value. Pure additive — no existing rows change, no GRANT
-- needed (ALTER TYPE follows the type's existing ACL). The new value is not used
-- in the same transaction (Postgres 12+ permits ADD VALUE in a migration tx).

-- AlterEnum
ALTER TYPE "ListingSource" ADD VALUE 'pughauctions';
