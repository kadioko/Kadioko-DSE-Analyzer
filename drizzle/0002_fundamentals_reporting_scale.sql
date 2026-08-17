CREATE TYPE "public"."scale_source" AS ENUM('DECLARED', 'INFERRED', 'UNDETERMINED', 'NOT_APPLICABLE');--> statement-breakpoint
ALTER TABLE "fundamentals" ADD COLUMN "reporting_scale" numeric(12, 2) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD COLUMN "scale_source" "scale_source" DEFAULT 'NOT_APPLICABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD COLUMN "scale_note" text;