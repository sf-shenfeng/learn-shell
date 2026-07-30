CREATE TABLE IF NOT EXISTS "lesson_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"page_index" integer NOT NULL,
	"selected_text" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"suffix" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'amber' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_annotations" ADD CONSTRAINT "lesson_annotations_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_annotations" ADD CONSTRAINT "lesson_annotations_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
