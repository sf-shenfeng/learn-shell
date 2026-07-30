CREATE TABLE IF NOT EXISTS "bridge_states" (
	"pair_id" text PRIMARY KEY NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"online_until" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teaching_moves" ADD COLUMN "layer" text DEFAULT 'guided' NOT NULL;--> statement-breakpoint
ALTER TABLE "teaching_moves" ADD COLUMN "context_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "teaching_responses" ADD COLUMN "layer" text DEFAULT 'guided' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bridge_states" ADD CONSTRAINT "bridge_states_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
