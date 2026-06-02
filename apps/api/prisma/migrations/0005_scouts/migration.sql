-- M8 (scouts) — standing briefs that drive area outreach.
--
-- One first-class modelled addition: the `Scout` table + its `ScoutStatus`
-- enum. A scout carries WHERE (location → resolved outcodes), WHAT (types /
-- condition / land / saleMethods + beds/price), and the free-text `keywords`
-- taste that shapes the first outreach email. It relates to listings purely by
-- OUTCODE (the "homes found" link-through). Multi-row; supersedes the single
-- SearchProfile in the UI.
--
-- DDL only (no data backfill — a fresh table). Hand-authored to match the
-- NNNN_name convention of 0001..0004 (homescout does NOT use Prisma's
-- timestamped dirs); the DDL is exactly what `prisma migrate diff` emits for
-- this schema change. The string-array option columns mirror the
-- SearchProfile.outcodes / Agent.coveredOutcodes form (TEXT[] DEFAULT ARRAY).

-- The scout lifecycle enum (active ⇄ paused; no terminal state).
CREATE TYPE "ScoutStatus" AS ENUM ('active', 'paused');

-- CreateTable
CREATE TABLE "Scout" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "outcodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "condition" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "land" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "saleMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minBedrooms" INTEGER,
    "maxPricePence" INTEGER,
    "keywords" TEXT NOT NULL DEFAULT '',
    "status" "ScoutStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Scout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Scout_status_idx" ON "Scout" ("status");

-- CreateIndex
CREATE INDEX "Scout_updatedAt_idx" ON "Scout" ("updatedAt" DESC);

-- Grant the app role access to the new table. 0003's ALTER DEFAULT PRIVILEGES
-- should already cover tables created by the migration role, but we grant
-- explicitly here so a missing privilege can never silently 500 the app in prod
-- (post-release-verify only probes /api/version, so it would not catch it).
GRANT SELECT, INSERT, UPDATE, DELETE ON "Scout" TO "homescout";
