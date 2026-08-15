CREATE TYPE "public"."alert_comparator" AS ENUM('ABOVE', 'BELOW', 'CROSSES_ABOVE', 'CROSSES_BELOW');--> statement-breakpoint
CREATE TYPE "public"."alert_type" AS ENUM('BO_RATIO_THRESHOLD', 'BO_MOMENTUM_THRESHOLD', 'UNUSUAL_VOLUME', 'PRICE_CHANGE', 'VALUATION_THRESHOLD', 'CORPORATE_ACTION', 'PRESSURE_SCORE');--> statement-breakpoint
CREATE TYPE "public"."bo_state" AS ENUM('NORMAL', 'NO_OFFER', 'NO_BID', 'EMPTY_BOOK');--> statement-breakpoint
CREATE TYPE "public"."corporate_action_type" AS ENUM('DIVIDEND', 'STOCK_SPLIT', 'BONUS_ISSUE', 'RIGHTS_ISSUE', 'AGM', 'EGM', 'EARNINGS_ANNOUNCEMENT', 'SUSPENSION', 'RESUMPTION', 'DELISTING', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."error_severity" AS ENUM('WARNING', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."ingestion_source_type" AS ENUM('CSV_MANUAL', 'DSE_OFFICIAL', 'LICENSED_FEED', 'THIRD_PARTY_API', 'DEV_PARSER');--> statement-breakpoint
CREATE TYPE "public"."ingestion_status" AS ENUM('RUNNING', 'PREVIEW', 'SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."period_type" AS ENUM('FY', 'H1', 'H2', 'Q1', 'Q2', 'Q3', 'Q4', 'INTERIM');--> statement-breakpoint
CREATE TYPE "public"."pressure_signal" AS ENUM('STRONG_DEMAND', 'DEMAND', 'BALANCED', 'SUPPLY', 'STRONG_SUPPLY', 'INSUFFICIENT_DATA');--> statement-breakpoint
CREATE TYPE "public"."security_type" AS ENUM('EQUITY', 'PREFERENCE_SHARE', 'BOND', 'FUND', 'ETF', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('VIEWER', 'ANALYST', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."validation_status" AS ENUM('VALID', 'WARNING', 'REJECTED');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"instrument_id" uuid,
	"type" "alert_type" NOT NULL,
	"comparator" "alert_comparator" DEFAULT 'ABOVE' NOT NULL,
	"threshold" numeric(18, 6),
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"last_triggered_value" numeric(18, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"trading_date" date NOT NULL,
	"bo_ratio" numeric(18, 6),
	"bo_state" "bo_state" DEFAULT 'EMPTY_BOOK' NOT NULL,
	"bid_value_tzs" numeric(24, 4),
	"offer_value_tzs" numeric(24, 4),
	"bid_pct_mcap" numeric(14, 6),
	"offer_pct_mcap" numeric(14, 6),
	"avg_bo_5d" numeric(18, 6),
	"bo_momentum_pct" numeric(14, 6),
	"bo_observations_5d" smallint DEFAULT 0 NOT NULL,
	"avg_volume_5d" numeric(22, 4),
	"avg_volume_20d" numeric(22, 4),
	"median_volume_20d" numeric(22, 4),
	"volume_ratio" numeric(18, 6),
	"turnover_ratio" numeric(18, 6),
	"avg_deal_size" numeric(22, 4),
	"liquidity_percentile" numeric(6, 2),
	"return_1d" numeric(14, 6),
	"return_5d" numeric(14, 6),
	"return_20d" numeric(14, 6),
	"range_pct" numeric(14, 6),
	"volatility_20d" numeric(14, 6),
	"liquidity_score" numeric(6, 2),
	"pressure_score" numeric(6, 2),
	"opportunity_score" numeric(6, 2),
	"data_confidence_score" numeric(6, 2),
	"pressure_signal" "pressure_signal" DEFAULT 'INSUFFICIENT_DATA' NOT NULL,
	"pressure_components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opportunity_components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence_factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_version" varchar(40) DEFAULT 'v1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corporate_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"type" "corporate_action_type" NOT NULL,
	"announced_date" date,
	"ex_date" date,
	"record_date" date,
	"payment_date" date,
	"effective_date" date,
	"amount_per_share" numeric(20, 4),
	"currency" varchar(3) DEFAULT 'TZS' NOT NULL,
	"ratio_from" numeric(12, 6),
	"ratio_to" numeric(12, 6),
	"subscription_price" numeric(20, 4),
	"title" varchar(250) NOT NULL,
	"description" text,
	"source" varchar(200),
	"source_url" text,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fundamentals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"period_type" "period_type" NOT NULL,
	"fiscal_year" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'TZS' NOT NULL,
	"revenue" numeric(30, 4),
	"gross_profit" numeric(30, 4),
	"operating_income" numeric(30, 4),
	"profit_before_tax" numeric(30, 4),
	"net_income" numeric(30, 4),
	"total_assets" numeric(30, 4),
	"total_equity" numeric(30, 4),
	"total_liabilities" numeric(30, 4),
	"total_debt" numeric(30, 4),
	"cash_and_equivalents" numeric(30, 4),
	"operating_cash_flow" numeric(30, 4),
	"capital_expenditure" numeric(30, 4),
	"free_cash_flow" numeric(30, 4),
	"eps" numeric(20, 4),
	"dps" numeric(20, 4),
	"book_value_per_share" numeric(20, 4),
	"shares_outstanding" bigint,
	"weighted_avg_shares" bigint,
	"roa" numeric(14, 6),
	"roe" numeric(14, 6),
	"gross_margin" numeric(14, 6),
	"net_margin" numeric(14, 6),
	"debt_to_equity" numeric(18, 6),
	"payout_ratio" numeric(14, 6),
	"loans_and_advances" numeric(30, 4),
	"customer_deposits" numeric(30, 4),
	"net_interest_income" numeric(30, 4),
	"net_interest_margin" numeric(14, 6),
	"npl_ratio" numeric(14, 6),
	"capital_adequacy_ratio" numeric(14, 6),
	"tier1_capital_ratio" numeric(14, 6),
	"cost_to_income_ratio" numeric(14, 6),
	"loan_to_deposit_ratio" numeric(14, 6),
	"source" varchar(200),
	"source_url" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by" varchar(120),
	"published_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"row_number" integer,
	"symbol" varchar(40),
	"trading_date_raw" varchar(40),
	"severity" "error_severity" DEFAULT 'ERROR' NOT NULL,
	"code" varchar(60) NOT NULL,
	"message" text NOT NULL,
	"field" varchar(60),
	"raw_row" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"trading_date" date,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"records_received" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"warnings" integer DEFAULT 0 NOT NULL,
	"status" "ingestion_status" DEFAULT 'RUNNING' NOT NULL,
	"error_summary" text,
	"payload_checksum" varchar(64),
	"file_name" varchar(255),
	"triggered_by" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" "ingestion_source_type" NOT NULL,
	"endpoint" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" smallint DEFAULT 100 NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_env_key" varchar(100),
	"is_licensed" boolean DEFAULT false NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"last_health_status" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"security_type" "security_type" DEFAULT 'EQUITY' NOT NULL,
	"sector" varchar(80),
	"is_cross_listed" boolean DEFAULT false NOT NULL,
	"country_of_incorporation" varchar(2) DEFAULT 'TZ' NOT NULL,
	"currency" varchar(3) DEFAULT 'TZS' NOT NULL,
	"listed_date" date,
	"active" boolean DEFAULT true NOT NULL,
	"shares_outstanding" bigint,
	"source_identifier" varchar(80),
	"isin" varchar(12),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"trading_date" date NOT NULL,
	"open" numeric(20, 4),
	"previous_close" numeric(20, 4),
	"close" numeric(20, 4),
	"high" numeric(20, 4),
	"low" numeric(20, 4),
	"change_pct" numeric(14, 6),
	"turnover_tzs" numeric(24, 4),
	"deals" integer,
	"volume" bigint,
	"outstanding_bid_qty" bigint,
	"outstanding_offer_qty" bigint,
	"market_cap_tzs" numeric(30, 4),
	"source_id" uuid,
	"source_timestamp" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ingestion_run_id" uuid,
	"validation_status" "validation_status" DEFAULT 'VALID' NOT NULL,
	"validation_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_daily_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trading_date" date NOT NULL,
	"total_turnover_tzs" numeric(30, 4),
	"total_volume" bigint,
	"total_deals" integer,
	"counters_traded" integer,
	"counters_listed" integer,
	"total_bid_qty" bigint,
	"total_offer_qty" bigint,
	"market_bo_ratio" numeric(18, 6),
	"market_bo_state" "bo_state" DEFAULT 'EMPTY_BOOK' NOT NULL,
	"total_market_cap_tzs" numeric(30, 4),
	"gainers" integer,
	"losers" integer,
	"unchanged" integer,
	"market_pressure_score" numeric(6, 2),
	"market_pressure_signal" "pressure_signal" DEFAULT 'INSUFFICIENT_DATA' NOT NULL,
	"breadth_components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_confidence_score" numeric(6, 2),
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_version" varchar(40) DEFAULT 'v1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_market_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"source_id" uuid,
	"trading_date" date,
	"content_type" varchar(60) DEFAULT 'text/csv' NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" varchar(40) NOT NULL,
	"family" varchar(40) NOT NULL,
	"description" text,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(120),
	"role" "user_role" DEFAULT 'VIEWER' NOT NULL,
	"password_hash" text,
	"locale" varchar(5) DEFAULT 'en' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"trading_date" date NOT NULL,
	"fundamentals_id" uuid,
	"close_price" numeric(20, 4),
	"market_cap_tzs" numeric(30, 4),
	"pe_ratio" numeric(18, 6),
	"pb_ratio" numeric(18, 6),
	"price_to_sales" numeric(18, 6),
	"dividend_yield" numeric(14, 6),
	"earnings_yield" numeric(14, 6),
	"enterprise_value_tzs" numeric(30, 4),
	"ev_to_ebitda" numeric(18, 6),
	"ev_to_sales" numeric(18, 6),
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_confidence_score" numeric(6, 2),
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_version" varchar(40) DEFAULT 'v1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watchlist_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"notes" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_errors" ADD CONSTRAINT "ingestion_errors_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_source_id_ingestion_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."ingestion_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_daily" ADD CONSTRAINT "market_daily_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_daily" ADD CONSTRAINT "market_daily_source_id_ingestion_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."ingestion_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_daily" ADD CONSTRAINT "market_daily_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_market_payloads" ADD CONSTRAINT "raw_market_payloads_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_market_payloads" ADD CONSTRAINT "raw_market_payloads_source_id_ingestion_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."ingestion_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_fundamentals_id_fundamentals_id_fk" FOREIGN KEY ("fundamentals_id") REFERENCES "public"."fundamentals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_watchlist_id_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."watchlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_user_idx" ON "alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alerts_instrument_idx" ON "alerts" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "alerts_enabled_idx" ON "alerts" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_daily_instrument_date_model_key" ON "analytics_daily" USING btree ("instrument_id","trading_date","model_version");--> statement-breakpoint
CREATE INDEX "analytics_daily_date_model_idx" ON "analytics_daily" USING btree ("trading_date","model_version");--> statement-breakpoint
CREATE INDEX "analytics_daily_instrument_date_desc_idx" ON "analytics_daily" USING btree ("instrument_id","trading_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "analytics_daily_pressure_idx" ON "analytics_daily" USING btree ("trading_date","pressure_score");--> statement-breakpoint
CREATE INDEX "corporate_actions_instrument_idx" ON "corporate_actions" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "corporate_actions_ex_date_idx" ON "corporate_actions" USING btree ("ex_date");--> statement-breakpoint
CREATE INDEX "corporate_actions_type_idx" ON "corporate_actions" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "corporate_actions_natural_key" ON "corporate_actions" USING btree ("instrument_id","type","effective_date","title");--> statement-breakpoint
CREATE UNIQUE INDEX "fundamentals_instrument_period_key" ON "fundamentals" USING btree ("instrument_id","period_end","period_type");--> statement-breakpoint
CREATE INDEX "fundamentals_instrument_year_idx" ON "fundamentals" USING btree ("instrument_id","fiscal_year");--> statement-breakpoint
CREATE INDEX "ingestion_errors_run_idx" ON "ingestion_errors" USING btree ("ingestion_run_id");--> statement-breakpoint
CREATE INDEX "ingestion_errors_code_idx" ON "ingestion_errors" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ingestion_runs_source_started_idx" ON "ingestion_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "ingestion_runs_status_idx" ON "ingestion_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ingestion_runs_trading_date_idx" ON "ingestion_runs" USING btree ("trading_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_sources_name_key" ON "ingestion_sources" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_symbol_key" ON "instruments" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "instruments_active_idx" ON "instruments" USING btree ("active");--> statement-breakpoint
CREATE INDEX "instruments_sector_idx" ON "instruments" USING btree ("sector");--> statement-breakpoint
CREATE UNIQUE INDEX "market_daily_instrument_date_key" ON "market_daily" USING btree ("instrument_id","trading_date");--> statement-breakpoint
CREATE INDEX "market_daily_trading_date_idx" ON "market_daily" USING btree ("trading_date");--> statement-breakpoint
CREATE INDEX "market_daily_instrument_date_desc_idx" ON "market_daily" USING btree ("instrument_id","trading_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "market_daily_date_turnover_idx" ON "market_daily" USING btree ("trading_date","turnover_tzs");--> statement-breakpoint
CREATE UNIQUE INDEX "market_daily_summary_date_model_key" ON "market_daily_summary" USING btree ("trading_date","model_version");--> statement-breakpoint
CREATE INDEX "market_daily_summary_date_idx" ON "market_daily_summary" USING btree ("trading_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "raw_market_payloads_run_idx" ON "raw_market_payloads" USING btree ("ingestion_run_id");--> statement-breakpoint
CREATE INDEX "raw_market_payloads_checksum_idx" ON "raw_market_payloads" USING btree ("checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "scoring_models_version_key" ON "scoring_models" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "valuations_instrument_date_model_key" ON "valuations" USING btree ("instrument_id","trading_date","model_version");--> statement-breakpoint
CREATE INDEX "valuations_date_idx" ON "valuations" USING btree ("trading_date");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_items_unique" ON "watchlist_items" USING btree ("watchlist_id","instrument_id");--> statement-breakpoint
CREATE INDEX "watchlist_items_instrument_idx" ON "watchlist_items" USING btree ("instrument_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlists_user_name_key" ON "watchlists" USING btree ("user_id","name");