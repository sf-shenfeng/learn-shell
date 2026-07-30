ALTER TABLE "learner_agent_pairs" ADD COLUMN "forbidden_observations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "learner_agent_pairs" ADD COLUMN "confidence_mode_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "learner_agent_pairs" ADD COLUMN "confidence_mode_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exercise_submissions" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "exercise_submissions" ADD COLUMN "confidence_pct" integer;