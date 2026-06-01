-- pgvector: the load-bearing raw migration. Hand-written AFTER the
-- Prisma-generated 0001_init because Prisma cannot emit `CREATE EXTENSION`, and
-- the `Unsupported("vector(1024)")` columns + HNSW index need the extension to
-- exist first.
--
-- Follows the CREATE EXTENSION raw-migration precedent at
-- doxus-web/.../20260413200000_s10_supplier_matching/migration.sql (pg_trgm)
-- and uses IF NOT EXISTS guards so the migration is idempotent and safe to
-- re-apply.
--
-- On homescout-postgres the `vector` extension is ALREADY created by the
-- postgres-init-roles Job (run by the bootstrap SUPERUSER, since the extension
-- is untrusted). `homescout_migrator` is NOT a superuser, so it cannot create
-- the extension itself — but `CREATE EXTENSION IF NOT EXISTS vector` is a no-op
-- there (the extension exists) and PostgreSQL does not require ownership to run
-- a no-op IF NOT EXISTS, so `prisma migrate deploy` (as the migrator) succeeds.
-- Keeping the statement in migration history captures the dependency for fresh
-- environments (e.g. the docker pgvector test DB) where the init Job has not
-- run; there the superuser of the throwaway container creates it.

-- Enable pgvector (no-op against homescout-postgres; real create in test/docker).
CREATE EXTENSION IF NOT EXISTS vector;

-- Add the Listing embedding column (Voyage voyage-3.5 => 1024 dims).
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "embedding" vector(1024);

-- Add the SearchProfile preference embedding (single row; no ANN index needed).
ALTER TABLE "SearchProfile" ADD COLUMN IF NOT EXISTS "preferenceEmbedding" vector(1024);

-- HNSW index for cosine ANN search over Listing.embedding. vector_cosine_ops
-- pairs with the `<=>` cosine-distance operator used by vectorTopK. HNSW gives
-- good recall without a training step (unlike IVFFlat).
CREATE INDEX IF NOT EXISTS "Listing_embedding_hnsw_idx"
  ON "Listing"
  USING hnsw ("embedding" vector_cosine_ops);
