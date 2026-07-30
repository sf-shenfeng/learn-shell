ALTER TABLE "teacher_reflections" ADD COLUMN "primary_attribution" text;--> statement-breakpoint
ALTER TABLE "teacher_reflections" ADD COLUMN "secondary_attribution" text;--> statement-breakpoint
ALTER TABLE "teacher_reflections" ADD COLUMN "evidence" text;--> statement-breakpoint
ALTER TABLE "teacher_reflections" ADD COLUMN "counterfactual" text;--> statement-breakpoint
ALTER TABLE "teacher_reflections" ADD COLUMN "action_link" jsonb;--> statement-breakpoint
ALTER TABLE "teacher_reflections" ADD COLUMN "weather_expires_at" timestamp with time zone;