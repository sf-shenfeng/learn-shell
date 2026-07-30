CREATE TABLE IF NOT EXISTS "mid_lesson_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"after_turn_n" integer NOT NULL,
	"rolling_summary" text NOT NULL,
	"current_direction" text NOT NULL,
	"weak_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mid_lesson_snapshots" ADD CONSTRAINT "mid_lesson_snapshots_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
