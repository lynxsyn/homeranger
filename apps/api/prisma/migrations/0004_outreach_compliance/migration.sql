-- M6 — outbound outreach + ComplianceGuard.
--
-- Two first-class modelled additions (the schema.prisma changes that go with
-- this DDL — generated client must match):
--   1. OutreachThread.status: the AC#4 thread state machine (no LangGraph —
--      a status enum advanced by BullMQ jobs, per scope-discipline.md).
--   2. WarmupState.killSwitch: the AC#6 manual hard-stop for all sends.
--
-- DDL only (no data backfill): both columns carry NOT NULL DEFAULTs, so existing
-- rows (the single WarmupState row, any OutreachThread rows) adopt the default.
-- Authored by hand to match the NNNN_name convention of 0002_pgvector /
-- 0003_grant_app_role (homeranger does NOT use Prisma's timestamped dirs); the
-- DDL is exactly what `prisma migrate diff` emits for these schema changes.

-- The thread lifecycle enum (active → awaiting_reply → replied; → closed on opt-out).
CREATE TYPE "OutreachThreadStatus" AS ENUM ('active', 'awaiting_reply', 'replied', 'closed');

-- Thread status — defaults to 'active' for existing + new rows.
ALTER TABLE "OutreachThread"
  ADD COLUMN "status" "OutreachThreadStatus" NOT NULL DEFAULT 'active';

-- Follow-up scan index: threads awaiting a reply, oldest activity first.
CREATE INDEX "OutreachThread_status_lastMessageAt_idx"
  ON "OutreachThread" ("status", "lastMessageAt" DESC);

-- The manual kill-switch — halts every outbound send immediately when true.
ALTER TABLE "WarmupState"
  ADD COLUMN "killSwitch" BOOLEAN NOT NULL DEFAULT false;
