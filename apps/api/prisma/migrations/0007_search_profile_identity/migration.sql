-- Searches/Settings — buyer identity on the SearchProfile singleton.
--
-- The Settings ("Your details") screen captures the operator's own contact
-- identity so outreach emails are signed + paced personally. Four columns on
-- the existing single-row SearchProfile table:
--   1. firstName / lastName → the email sign-off name (the resolved sender
--      prefers this; falls back to the RESEND_FROM display name when blank).
--   2. phone                → appended to the sign-off when set.
--   3. urgency              → selects the closing "how soon" line
--                             (browsing | active | ready | soon).
--
-- All NOT NULL with defaults so the existing singleton row stays valid after
-- migrate (no backfill needed). Authored by hand to match the NNNN_name
-- convention of 0004/0005/0006 (homeranger does NOT use Prisma's timestamped
-- dirs); the DDL is exactly what `prisma migrate diff` emits for these schema
-- changes. SearchProfile is an existing table → 0003's grants already cover the
-- new columns, so no GRANT statement is needed here.

ALTER TABLE "SearchProfile" ADD COLUMN "firstName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SearchProfile" ADD COLUMN "lastName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SearchProfile" ADD COLUMN "phone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SearchProfile" ADD COLUMN "urgency" TEXT NOT NULL DEFAULT 'active';
