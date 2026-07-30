CREATE TABLE IF NOT EXISTS "lesson_loop_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_loop_receipts_kind_check" CHECK ("lesson_loop_receipts"."kind" IN ('exercise_feedback', 'forward_revision', 'teacher_note', 'erratum', 'flashcard_change', 'hypothesis_update', 'journal_entry'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lesson_patches" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"pair_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"anchor" text,
	"source_attribution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_patches_kind_check" CHECK ("lesson_patches"."kind" IN ('teacher_note', 'erratum'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lesson_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"state" text DEFAULT 'not_started' NOT NULL,
	"declared_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"checklist_snapshot" jsonb,
	"prerequisite_skips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_loop_receipts" ADD CONSTRAINT "lesson_loop_receipts_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_loop_receipts" ADD CONSTRAINT "lesson_loop_receipts_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_patches" ADD CONSTRAINT "lesson_patches_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_patches" ADD CONSTRAINT "lesson_patches_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lesson_progress_pair_lesson_uniq" ON "lesson_progress" USING btree ("pair_id","lesson_id");