CREATE TABLE IF NOT EXISTS "syllabus_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"node_id" text NOT NULL,
	"asset_type" text NOT NULL,
	"asset_id" text NOT NULL,
	"mapped_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "syllabus_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"parent_id" text,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"syllabus_version" text NOT NULL,
	"exam_weight" double precision,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "syllabus_mappings" ADD CONSTRAINT "syllabus_mappings_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "syllabus_mappings" ADD CONSTRAINT "syllabus_mappings_node_id_syllabus_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."syllabus_nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "syllabus_nodes" ADD CONSTRAINT "syllabus_nodes_pair_id_learner_agent_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."learner_agent_pairs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "syllabus_nodes" ADD CONSTRAINT "syllabus_nodes_parent_id_syllabus_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."syllabus_nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
