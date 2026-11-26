CREATE TABLE "candidate_talent_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"posting_key" text NOT NULL,
	"posting_label" text,
	"job_id" uuid,
	"score" integer NOT NULL,
	"tier" text,
	"reason" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_talent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"tag_version" text NOT NULL,
	"input_hash" text,
	"engine" text NOT NULL,
	"model" text,
	"city" text,
	"experience_years" integer,
	"education" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"companies" text[] DEFAULT '{}'::text[] NOT NULL,
	"key_companies" text[] DEFAULT '{}'::text[] NOT NULL,
	"industries" text[] DEFAULT '{}'::text[] NOT NULL,
	"work_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"works" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"best_posting_key" text,
	"best_score" integer,
	"first_contact_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"tagged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_talent_matches" ADD CONSTRAINT "candidate_talent_matches_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_talent_matches" ADD CONSTRAINT "candidate_talent_matches_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_talent_matches" ADD CONSTRAINT "candidate_talent_matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_talent_profiles" ADD CONSTRAINT "candidate_talent_profiles_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_talent_profiles" ADD CONSTRAINT "candidate_talent_profiles_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_talent_matches_candidate_posting_idx" ON "candidate_talent_matches" USING btree ("workspace_id","candidate_id","posting_key");--> statement-breakpoint
CREATE INDEX "candidate_talent_matches_posting_score_idx" ON "candidate_talent_matches" USING btree ("workspace_id","posting_key","score");--> statement-breakpoint
CREATE INDEX "candidate_talent_matches_candidate_idx" ON "candidate_talent_matches" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_talent_profiles_workspace_candidate_idx" ON "candidate_talent_profiles" USING btree ("workspace_id","candidate_id");--> statement-breakpoint
CREATE INDEX "candidate_talent_profiles_skills_idx" ON "candidate_talent_profiles" USING gin ("skills");--> statement-breakpoint
CREATE INDEX "candidate_talent_profiles_roles_idx" ON "candidate_talent_profiles" USING gin ("roles");--> statement-breakpoint
CREATE INDEX "candidate_talent_profiles_companies_idx" ON "candidate_talent_profiles" USING gin ("companies");--> statement-breakpoint
CREATE INDEX "candidate_talent_profiles_key_companies_idx" ON "candidate_talent_profiles" USING gin ("key_companies");--> statement-breakpoint
CREATE INDEX "candidate_talent_profiles_industries_idx" ON "candidate_talent_profiles" USING gin ("industries");--> statement-breakpoint
CREATE INDEX "candidate_talent_profiles_first_contact_idx" ON "candidate_talent_profiles" USING btree ("workspace_id","first_contact_at");--> statement-breakpoint
CREATE INDEX "candidate_talent_profiles_last_active_idx" ON "candidate_talent_profiles" USING btree ("workspace_id","last_active_at");--> statement-breakpoint
CREATE INDEX "candidate_talent_profiles_best_score_idx" ON "candidate_talent_profiles" USING btree ("workspace_id","best_score");