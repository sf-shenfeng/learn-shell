CREATE TABLE IF NOT EXISTS "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"title" text NOT NULL,
	"content_md" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_annotations" ADD COLUMN "document_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_annotations" ADD CONSTRAINT "lesson_annotations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "lesson_annotations" ADD CONSTRAINT "lesson_annotations_host_exclusive" CHECK (NOT ("lesson_annotations"."lesson_id" IS NOT NULL AND "lesson_annotations"."document_id" IS NOT NULL));