CREATE TABLE "candidate_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"mode" text DEFAULT 'filter' NOT NULL,
	"filter_spec" jsonb,
	"candidate_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "candidate_lists_mode_check" CHECK ("candidate_lists"."mode" in ('filter', 'snapshot'))
);
--> statement-breakpoint
ALTER TABLE "candidate_lists" ADD CONSTRAINT "candidate_lists_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_lists" ADD CONSTRAINT "candidate_lists_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_lists_workspace_idx" ON "candidate_lists" USING btree ("workspace_id","created_at");