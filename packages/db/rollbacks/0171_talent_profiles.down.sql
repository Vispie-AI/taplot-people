-- Down migration for 0171_talent_profiles. Drizzle has no down step, so run this by hand:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/rollbacks/0171_talent_profiles.down.sql
-- It drops only the two tables 0171 created (their indexes and foreign keys go with them) and removes 0171's row
-- from drizzle's ledger, so a later `db:migrate` can apply it again. No existing table or row is touched.
-- Talent profiles written since the deploy are lost; take a database backup first if they matter.
BEGIN;
DROP TABLE IF EXISTS "candidate_talent_matches";
DROP TABLE IF EXISTS "candidate_talent_profiles";
-- 1795608615758 = "when" of 0171_talent_profiles in migrations/meta/_journal.json
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1795608615758;
COMMIT;
