ALTER TABLE "lessons" ALTER COLUMN "content_markdown" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "needs_review" boolean DEFAULT false;