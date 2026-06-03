-- Scouts PR2 (listings refresh) — capture the sending agent on each Listing.
--
-- Two nullable columns on the existing Listing table (the schema.prisma changes
-- that go with this DDL — generated client must match):
--   1. Listing.agentEmail: the normalised sender email of the inbound agent
--      email that produced the listing (the per-agency follow-up groups by it).
--   2. Listing.agencyName: the sender display name when present; the listings
--      table's Agent column renders `agencyName ?? agentEmail ?? "—"`.
--
-- DDL only (no data backfill): both columns are NULLable with NO default, so
-- existing rows simply carry NULL (the Agent column renders "—" for them).
-- Authored by hand to match the NNNN_name convention of 0004_outreach_compliance
-- / 0005_scouts (homeranger does NOT use Prisma's timestamped dirs); the DDL is
-- exactly what `prisma migrate diff` emits for these schema changes. No new
-- table → 0003's ALTER DEFAULT PRIVILEGES already covers the existing Listing
-- grant, so no GRANT statement is needed here.

-- Sending-agent capture — both NULL for pre-existing rows + non-email sources.
ALTER TABLE "Listing" ADD COLUMN "agentEmail" TEXT;
ALTER TABLE "Listing" ADD COLUMN "agencyName" TEXT;
