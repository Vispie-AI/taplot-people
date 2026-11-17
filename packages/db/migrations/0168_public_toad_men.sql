CREATE TABLE "boss_resume_imports" (
	"workspace_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boss_resume_imports_workspace_id_source_record_id_pk" PRIMARY KEY("workspace_id","source_record_id")
);
--> statement-breakpoint
ALTER TABLE "boss_resume_imports" ADD CONSTRAINT "boss_resume_imports_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boss_resume_imports" ADD CONSTRAINT "boss_resume_imports_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boss_resume_imports" ADD CONSTRAINT "boss_resume_imports_file_id_candidate_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."candidate_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "boss_resume_imports_candidate_idx" ON "boss_resume_imports" USING btree ("workspace_id","candidate_id");--> statement-breakpoint
CREATE INDEX "boss_resume_imports_file_idx" ON "boss_resume_imports" USING btree ("file_id");