-- Listing images (hotlink) — capture a single source image URL per listing so
-- the listings table can show a thumbnail for SCRAPED listings instead of the
-- placeholder. The URL is a HOTLINK reference only: the image is displayed
-- directly from the source CDN, never downloaded, stored, or redistributed
-- (see docs/decisions/2026-06-05-listing-site-ingestion.md + the LIA). NULL for
-- agent-email / manual listings and any scraped row whose page exposed no image.
--
-- DDL only (no backfill): one NULLable column with NO default, so existing rows
-- carry NULL (the table renders the placeholder icon for them). Authored by hand
-- to match the NNNN_name convention of 0006_listing_agent (homeranger does NOT
-- use Prisma's timestamped dirs); this is exactly what `prisma migrate diff`
-- emits for the schema change. No new table → 0003's ALTER DEFAULT PRIVILEGES
-- already covers the existing Listing grant, so no GRANT statement is needed.

-- Hotlinked source image URL — NULL for non-scraped + image-less rows.
ALTER TABLE "Listing" ADD COLUMN "imageUrl" TEXT;
