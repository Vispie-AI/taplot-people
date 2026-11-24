ALTER TABLE "candidate_lists" ADD COLUMN "short_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "short_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_lists_short_id_idx" ON "candidate_lists" USING btree ("short_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_workspace_short_code_idx" ON "jobs" USING btree ("workspace_id",lower("short_code")) WHERE "jobs"."deleted_at" is null and "jobs"."short_code" is not null;