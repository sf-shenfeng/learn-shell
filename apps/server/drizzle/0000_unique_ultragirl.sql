CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"provider" text NOT NULL,
	"model_family" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identity_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learner_agent_pairs" (
	"id" text PRIMARY KEY NOT NULL,
	"learner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"established_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learners" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"preferences" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teaching_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"goal" text NOT NULL,
	"time_range" jsonb NOT NULL,
	"success_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_read_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_write_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feedback_tone" jsonb NOT NULL,
	"human_approval_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"intensity" text NOT NULL,
	"interaction_mode" text NOT NULL,
	"content_modality" text NOT NULL,
	"weekly_capacity_hours" integer,
	"preferred_time_of_day" jsonb,
	"accepts_reminders" boolean DEFAULT true NOT NULL,
	"reminder_channels" jsonb,
	"reminder_types" jsonb,
	"do_not_disturb" jsonb,
	"ical_subscription_url" text,
	"setup_status" text DEFAULT 'draft' NOT NULL,
	"setup_started_at" timestamp with time zone,
	"setup_completed_at" timestamp with time zone,
	"setup_steps" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "concepts" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"course_id" text NOT NULL,
	"name" text NOT NULL,
	"short_definition" text DEFAULT '' NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flashcard_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "courses" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"topic" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"structure" jsonb NOT NULL,
	"generated_by_agent_id" text,
	"generated_from" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"syllabus_version" text,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flashcards" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"concept_id" text,
	"deck_id" text NOT NULL,
	"front" text NOT NULL,
	"back" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fsrs_state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" text NOT NULL,
	"order" integer NOT NULL,
	"title" text NOT NULL,
	"content_markdown" text NOT NULL,
	"concept_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_minutes" integer DEFAULT 15 NOT NULL,
	"skill_used" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"course_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"concepts_touched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cards_reviewed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"agent_summary" text,
	"teacher_reflection_id" text,
	"next_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text,
	"skill_used" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"session_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"recorded_by" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permission_state" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learner_hypotheses" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"domain" text NOT NULL,
	"observation" text NOT NULL,
	"evidence_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counterevidence_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"written_by_agent_id" text NOT NULL,
	"from_session_id" text,
	"user_approved" boolean,
	"user_note" text,
	"last_verified_at" timestamp with time zone,
	"allowed_for_teaching" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teacher_reflections" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"from_session_id" text,
	"linked_intervention_event_id" text,
	"method" text NOT NULL,
	"rationale" text NOT NULL,
	"expected_outcome" text NOT NULL,
	"actual_evidence" text NOT NULL,
	"what_worked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"what_failed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hypothesis_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_action" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exercise_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"exercise_id" text NOT NULL,
	"learner_id" text NOT NULL,
	"learner_answer" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"withdrew_at" timestamp with time zone,
	"previous_submission_id" text,
	"agent_feedback" text,
	"agent_score" double precision,
	"graded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exercises" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"order" integer NOT NULL,
	"prompt" text NOT NULL,
	"reference_answer" text NOT NULL,
	"expected_concepts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_skill_used" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "question_banks" (
	"id" text PRIMARY KEY NOT NULL,
	"exam" text NOT NULL,
	"year" integer,
	"source" text NOT NULL,
	"language" text NOT NULL,
	"version" text NOT NULL,
	"questions_count" integer DEFAULT 0 NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quiz_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"learner_id" text NOT NULL,
	"bank_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quiz_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"bank_id" text NOT NULL,
	"stem" text NOT NULL,
	"question_type" text NOT NULL,
	"choices" jsonb,
	"reference_answer" text NOT NULL,
	"explanation" text,
	"concept_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"difficulty" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mindmap_associations" (
	"id" text PRIMARY KEY NOT NULL,
	"mindmap_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mindmaps" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_pair_id" text NOT NULL,
	"scope" text NOT NULL,
	"title" text NOT NULL,
	"folder" text,
	"source" text DEFAULT 'user' NOT NULL,
	"agent_skill_used" text,
	"agent_seed_snapshot" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"has_been_reset" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_mindmap_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_pair_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"source_title" text,
	"placed_in_mindmap_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learner_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"week_of" timestamp with time zone NOT NULL,
	"pace" integer,
	"difficulty" integer,
	"helpfulness" integer,
	"tone_fit" integer,
	"free_text" text,
	"suggested_changes" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"type" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb,
	"fired_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "post_lesson_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"session_id" text,
	"concepts_touched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flashcards_reviewed_count" integer DEFAULT 0 NOT NULL,
	"flashcards_rating_distribution" jsonb NOT NULL,
	"exercises_submitted_count" integer DEFAULT 0 NOT NULL,
	"live_turns_count" integer DEFAULT 0 NOT NULL,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"agent_observation" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learner_agent_pairs" ADD CONSTRAINT "learner_agent_pairs_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learner_agent_pairs" ADD CONSTRAINT "learner_agent_pairs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "teaching_contracts" ADD CONSTRAINT "teaching_contracts_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "concepts" ADD CONSTRAINT "concepts_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "concepts" ADD CONSTRAINT "concepts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "courses" ADD CONSTRAINT "courses_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lessons" ADD CONSTRAINT "lessons_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learning_sessions" ADD CONSTRAINT "learning_sessions_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_events" ADD CONSTRAINT "session_events_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_learning_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."learning_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learner_hypotheses" ADD CONSTRAINT "learner_hypotheses_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "teacher_reflections" ADD CONSTRAINT "teacher_reflections_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exercise_submissions" ADD CONSTRAINT "exercise_submissions_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exercise_submissions" ADD CONSTRAINT "exercise_submissions_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exercises" ADD CONSTRAINT "exercises_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_bank_id_question_banks_id_fk" FOREIGN KEY ("bank_id") REFERENCES "public"."question_banks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_bank_id_question_banks_id_fk" FOREIGN KEY ("bank_id") REFERENCES "public"."question_banks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mindmap_associations" ADD CONSTRAINT "mindmap_associations_mindmap_id_mindmaps_id_fk" FOREIGN KEY ("mindmap_id") REFERENCES "public"."mindmaps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mindmaps" ADD CONSTRAINT "mindmaps_owner_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("owner_pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_mindmap_cards" ADD CONSTRAINT "pending_mindmap_cards_owner_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("owner_pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learner_feedback" ADD CONSTRAINT "learner_feedback_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learner_feedback" ADD CONSTRAINT "learner_feedback_contract_id_teaching_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."teaching_contracts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminders" ADD CONSTRAINT "reminders_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_lesson_evaluations" ADD CONSTRAINT "post_lesson_evaluations_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_lesson_evaluations" ADD CONSTRAINT "post_lesson_evaluations_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_lesson_evaluations" ADD CONSTRAINT "post_lesson_evaluations_session_id_learning_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."learning_sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
