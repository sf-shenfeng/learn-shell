CREATE TABLE IF NOT EXISTS "live_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"context_type" text NOT NULL,
	"context_id" text NOT NULL,
	"context_preview" text,
	"goal" text,
	"status" text DEFAULT 'active' NOT NULL,
	"awaiting_role" text DEFAULT 'agent' NOT NULL,
	"summary" text,
	"teacher_reflection" text,
	"next_action" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teaching_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"move_type" text NOT NULL,
	"content" text NOT NULL,
	"response_kind" text DEFAULT 'none' NOT NULL,
	"payload" jsonb,
	"source_type" text,
	"source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teaching_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"move_id" text NOT NULL,
	"client_response_id" text NOT NULL,
	"content" text NOT NULL,
	"input_type" text DEFAULT 'text' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_responses_client_response_id_unique" UNIQUE("client_response_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "teaching_moves" ADD CONSTRAINT "teaching_moves_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "teaching_responses" ADD CONSTRAINT "teaching_responses_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "teaching_responses" ADD CONSTRAINT "teaching_responses_move_id_teaching_moves_id_fk" FOREIGN KEY ("move_id") REFERENCES "public"."teaching_moves"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teaching_moves_session_seq_uniq" ON "teaching_moves" USING btree ("session_id","seq");