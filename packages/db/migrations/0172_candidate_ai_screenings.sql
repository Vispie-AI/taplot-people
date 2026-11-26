CREATE TABLE "candidate_ai_screenings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_job_id" text NOT NULL,
	"job_id" uuid,
	"source_record_id" text,
	"verdict" text NOT NULL,
	"reason" text,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"screened_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_ai_screenings" ADD CONSTRAINT "candidate_ai_screenings_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_ai_screenings" ADD CONSTRAINT "candidate_ai_screenings_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_ai_screenings" ADD CONSTRAINT "candidate_ai_screenings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_ai_screenings_candidate_job_idx" ON "candidate_ai_screenings" USING btree ("workspace_id","candidate_id","source_job_id");--> statement-breakpoint
CREATE INDEX "candidate_ai_screenings_screened_at_idx" ON "candidate_ai_screenings" USING btree ("workspace_id","screened_at");--> statement-breakpoint
CREATE INDEX "candidate_ai_screenings_job_idx" ON "candidate_ai_screenings" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "candidate_ai_screenings_candidate_idx" ON "candidate_ai_screenings" USING btree ("candidate_id");