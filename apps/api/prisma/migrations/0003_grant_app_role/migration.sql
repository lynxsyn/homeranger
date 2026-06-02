-- Grant the runtime app role (`homescout`, used by DATABASE_URL) privileges on
-- the schema objects owned by the migrator (`homescout_migrator`, which owns the
-- DB and created every table via `prisma migrate deploy`).
--
-- Without this, the app role has only schema USAGE (granted by the M1 init-roles
-- Job) and gets "permission denied for table ..." on every query — surfaced the
-- first time the API ran against the cluster's two-role setup. (Local/CI test
-- DBs use a single superuser role, so they never hit this.)
--
-- This migration runs AS `homescout_migrator` (MIGRATION_DATABASE_URL), which
-- owns the tables/sequences and so can grant on them and set its own default
-- privileges. All statements are idempotent.

-- Existing tables + sequences.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "homescout";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "homescout";

-- Future tables/sequences created by the migration role inherit the same grants,
-- so later migrations (M4+) don't need to repeat this. We DON'T name the role
-- explicitly (no `FOR ROLE`) so this is portable: it binds to the migration's
-- current_user — `homescout_migrator` on the cluster, the single superuser on
-- the local/CI test DB (where a separate migrator role doesn't exist).
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "homescout";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT USAGE, SELECT ON SEQUENCES TO "homescout";
