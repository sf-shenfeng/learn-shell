CREATE TABLE IF NOT EXISTS "simulated_quiz_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"quiz_id" text NOT NULL,
	"learner_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" double precision
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "simulated_quizzes" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"course_id" text NOT NULL,
	"agent_skill_used" text NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulated_quiz_attempts" ADD CONSTRAINT "simulated_quiz_attempts_quiz_id_simulated_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."simulated_quizzes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulated_quiz_attempts" ADD CONSTRAINT "simulated_quiz_attempts_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulated_quizzes" ADD CONSTRAINT "simulated_quizzes_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulated_quizzes" ADD CONSTRAINT "simulated_quizzes_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
