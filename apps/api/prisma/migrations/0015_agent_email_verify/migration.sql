-- Agent email deliverability (discovery SMTP probe).
-- Adds an EmailVerifyStatus enum + two Agent columns. `undeliverable` agents are
-- blocked at the ComplianceGuard so a known-dead address is never re-sent
-- (the ~30% hard-bounce rate on scraped info@/contact@ addresses motivated this).
-- New columns inherit the table-level GRANTs from 0003 (column adds need none).

CREATE TYPE "EmailVerifyStatus" AS ENUM ('unknown', 'deliverable', 'undeliverable');

ALTER TABLE "Agent"
  ADD COLUMN "emailVerifyStatus" "EmailVerifyStatus" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ;
