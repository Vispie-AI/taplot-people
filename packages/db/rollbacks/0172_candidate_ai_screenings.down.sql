-- Down migration for 0172_candidate_ai_screenings. Drizzle has no down step, so run this by hand:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/rollbacks/0172_candidate_ai_screenings.down.sql
-- It drops only the table 0172 created (its indexes and foreign keys go with it) and removes 0172's row from
-- drizzle's ledger, so a later `db:migrate` can apply it again. No existing table or row is touched.
-- Screenings written since the deploy are lost; they can be written again from the screening engine's own copy.
BEGIN;
DROP TABLE IF EXISTS "candidate_ai_screenings";
-- 1795702649324 = "when" of 0172_candidate_ai_screenings in migrations/meta/_journal.json
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1795702649324;
COMMIT;
