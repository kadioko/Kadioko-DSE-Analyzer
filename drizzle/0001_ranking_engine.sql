CREATE TYPE "public"."exclusion_reason" AS ENUM('MISSING_FUNDAMENTALS', 'MISSING_SENTIMENT', 'STALE_FUNDAMENTALS', 'BELOW_MINIMUM_CONFIDENCE', 'BELOW_MINIMUM_LIQUIDITY', 'INSTRUMENT_INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."fundamental_source_status" AS ENUM('VERIFIED', 'UNVERIFIED', 'PARTIAL');--> statement-breakpoint
CREATE TYPE "public"."interpretation_code" AS ENUM('QUALITY_AND_TREND_ALIGNED', 'QUALITY_AWAITING_TREND', 'AVERAGE_QUALITY', 'AVERAGE_QUALITY_WEAK_TREND', 'WEAK_QUALITY');--> statement-breakpoint
CREATE TYPE "public"."market_demand" AS ENUM('DEMAND_KUBWA_SANA', 'DEMAND_KUBWA', 'DEMAND_WASTANI', 'DEMAND_NDOGO_SANA');--> statement-breakpoint
CREATE TYPE "public"."ranking_grade" AS ENUM('BORA_SANA', 'NZURI_SANA', 'NZURI', 'WASTANI', 'DHAIFU', 'DHAIFU_SANA');--> statement-breakpoint
CREATE TYPE "public"."ranking_status" AS ENUM('GENERATING', 'COMPLETE', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TABLE "fundamental_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"financial_period" date NOT NULL,
	"period_type" "period_type" NOT NULL,
	"fundamentals_id" uuid,
	"score" numeric(8, 4) NOT NULL,
	"data_completeness" numeric(6, 2) NOT NULL,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"methodology_version" varchar(40) DEFAULT 'fundamental-v1' NOT NULL,
	"source_status" "fundamental_source_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"published_at" timestamp with time zone,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ranking_snapshot_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"rank" integer,
	"previous_rank" integer,
	"rank_change" integer,
	"is_new_entrant" boolean DEFAULT false NOT NULL,
	"fundamental_score" numeric(8, 4),
	"sentiment_score" numeric(8, 4),
	"overall_score" numeric(8, 4),
	"grade" "ranking_grade",
	"market_demand" "market_demand",
	"interpretation_code" "interpretation_code",
	"interpretation_en" text,
	"interpretation_sw" text,
	"liquidity_score" numeric(6, 2),
	"data_confidence" numeric(6, 2),
	"fundamental_period" date,
	"eligible" boolean DEFAULT false NOT NULL,
	"exclusion_reason" "exclusion_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"fundamental_weight" numeric(5, 4) NOT NULL,
	"sentiment_weight" numeric(5, 4) NOT NULL,
	"minimum_confidence" numeric(6, 2),
	"minimum_liquidity" numeric(6, 2),
	"grade_bands" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" varchar(20) DEFAULT '1.0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ranking_model_id" uuid NOT NULL,
	"trading_date" date NOT NULL,
	"fundamental_period" date,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_version" varchar(20) DEFAULT '1.0' NOT NULL,
	"status" "ranking_status" DEFAULT 'GENERATING' NOT NULL,
	"instruments_considered" integer DEFAULT 0 NOT NULL,
	"instruments_ranked" integer DEFAULT 0 NOT NULL,
	"instruments_excluded" integer DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "fundamental_scores" ADD CONSTRAINT "fundamental_scores_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamental_scores" ADD CONSTRAINT "fundamental_scores_fundamentals_id_fundamentals_id_fk" FOREIGN KEY ("fundamentals_id") REFERENCES "public"."fundamentals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_ranking_snapshot_id_ranking_snapshots_id_fk" FOREIGN KEY ("ranking_snapshot_id") REFERENCES "public"."ranking_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_snapshots" ADD CONSTRAINT "ranking_snapshots_ranking_model_id_ranking_models_id_fk" FOREIGN KEY ("ranking_model_id") REFERENCES "public"."ranking_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fundamental_scores_instrument_period_model_key" ON "fundamental_scores" USING btree ("instrument_id","financial_period","period_type","methodology_version");--> statement-breakpoint
CREATE INDEX "fundamental_scores_instrument_idx" ON "fundamental_scores" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "fundamental_scores_published_idx" ON "fundamental_scores" USING btree ("published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_entries_snapshot_instrument_key" ON "ranking_entries" USING btree ("ranking_snapshot_id","instrument_id");--> statement-breakpoint
CREATE INDEX "ranking_entries_snapshot_rank_idx" ON "ranking_entries" USING btree ("ranking_snapshot_id","rank");--> statement-breakpoint
CREATE INDEX "ranking_entries_instrument_idx" ON "ranking_entries" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "ranking_entries_overall_score_idx" ON "ranking_entries" USING btree ("overall_score");--> statement-breakpoint
CREATE INDEX "ranking_entries_grade_idx" ON "ranking_entries" USING btree ("grade");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_models_code_version_key" ON "ranking_models" USING btree ("code","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_snapshots_model_date_key" ON "ranking_snapshots" USING btree ("ranking_model_id","trading_date","model_version");--> statement-breakpoint
CREATE INDEX "ranking_snapshots_date_idx" ON "ranking_snapshots" USING btree ("trading_date" DESC NULLS LAST);