-- Canonical rename: Scout → Search (table + enum + indexes), aligning the code
-- + DB with the product's "Searches" terminology. Pure RENAMEs — data-preserving
-- (the operator's existing rows are kept; only object names change). Hand-authored
-- to match the NNNN_name convention; RENAME (not drop/recreate) is what Prisma's
-- diff would NOT emit on its own (it sees a rename as drop+add), so we author it
-- explicitly to avoid data loss. GRANTs + the status column's enum type follow
-- the renamed objects automatically.

-- Enum type first (the Search.status column re-points to it automatically).
ALTER TYPE "ScoutStatus" RENAME TO "SearchStatus";

-- Table.
ALTER TABLE "Scout" RENAME TO "Search";

-- Primary key + indexes → the Prisma naming convention for the new model name,
-- so schema.prisma (model Search) and the DB stay drift-free.
ALTER INDEX "Scout_pkey" RENAME TO "Search_pkey";
ALTER INDEX "Scout_status_idx" RENAME TO "Search_status_idx";
ALTER INDEX "Scout_updatedAt_idx" RENAME TO "Search_updatedAt_idx";
ALTER INDEX "Scout_userId_idx" RENAME TO "Search_userId_idx";
