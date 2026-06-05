-- Agent website + free-mail cleanup.
--
-- (1) Add a nullable website column (the agency's site, for operator
--     verification before outreach). No GRANT needed — 0003 grants all columns
--     of "Agent" to the app role.
ALTER TABLE "Agent" ADD COLUMN "website" TEXT;

-- (2) Backfill: a corporate subscriber's website is its email domain, so the
--     operator gets a clickable link for agents discovered before this change.
--     (Free-mail agents are removed below, so only corporate rows are touched.)
UPDATE "Agent"
SET "website" = 'https://' || split_part("email", '@', 2)
WHERE "website" IS NULL
  AND "mailboxType" = 'corporate_subscriber'
  AND position('@' IN "email") > 0;

-- (3) Drop free-mail / personal agents we will never contact. PECR: a personal
--     mailbox (gmail/outlook/etc.) is not a corporate subscriber, so the
--     ComplianceGuard already blocks every send to it — these rows are
--     unsendable dead weight. The FK ON DELETE CASCADE removes any attached
--     OutreachThread/OutreachMessage (individuals were never sent to, so there
--     should be none). Discovery now drops free-mail at source, so this set will
--     not regrow.
DELETE FROM "Agent" WHERE "mailboxType" = 'individual';
