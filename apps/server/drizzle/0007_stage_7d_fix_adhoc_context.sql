CREATE TABLE IF NOT EXISTS "ad_hoc_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"payload" jsonb,
	"context_snapshot" jsonb NOT NULL,
	"is_learning_related" boolean DEFAULT false NOT NULL,
	"client_message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_hoc_messages_client_message_id_unique" UNIQUE("client_message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_hoc_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_states" ADD COLUMN "context_used_tokens" integer;--> statement-breakpoint
ALTER TABLE "bridge_states" ADD COLUMN "context_total_tokens" integer;--> statement-breakpoint
ALTER TABLE "bridge_states" ADD COLUMN "context_used_pct" integer;--> statement-breakpoint
ALTER TABLE "bridge_states" ADD COLUMN "context_compact_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_states" ADD COLUMN "last_context_report_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_hoc_messages" ADD CONSTRAINT "ad_hoc_messages_thread_id_ad_hoc_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."ad_hoc_threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_hoc_threads" ADD CONSTRAINT "ad_hoc_threads_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "teaching_moves" DROP COLUMN IF EXISTS "layer";--> statement-breakpoint
ALTER TABLE "teaching_moves" DROP COLUMN IF EXISTS "context_snapshot";--> statement-breakpoint
ALTER TABLE "teaching_responses" DROP COLUMN IF EXISTS "layer";