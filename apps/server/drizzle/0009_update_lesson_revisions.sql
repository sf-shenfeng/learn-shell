CREATE TABLE IF NOT EXISTS "lesson_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"revision" integer NOT NULL,
	"prev_content_markdown" text,
	"prev_title" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" text,
	"revised_by" text NOT NULL,
	"revised_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_revisions" ADD CONSTRAINT "lesson_revisions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
