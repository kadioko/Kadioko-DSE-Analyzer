/**
 * Kadioko DSE Analyzer - PostgreSQL schema (Drizzle ORM).
 *
 * Design rules enforced here:
 *  1. RAW observed data (market_daily) and DERIVED data (analytics_daily,
 *     market_daily_summary, valuations) live in separate tables. They are never
 *     mixed in one row. Derived tables carry `model_version` so a recalculation
 *     can be reproduced or rolled back.
 *  2. All monetary values are NUMERIC, never float. Aggregation happens in
 *     PostgreSQL so money arithmetic stays exact; JavaScript only ever handles
 *     ratios and scores (see src/lib/db/num.ts).
 *  3. Every stored market observation is traceable to an ingestion run and a
 *     source, so any number on screen can be audited back to its origin.
 */

import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const securityTypeEnum = pgEnum('security_type', [
  'EQUITY',
  'PREFERENCE_SHARE',
  'BOND',
  'FUND',
  'ETF',
  'OTHER',
]);

/** Result of the data-quality gate for a single stored observation. */
export const validationStatusEnum = pgEnum('validation_status', [
  'VALID',
  'WARNING',
  'REJECTED',
]);

/**
 * State of the order book. This exists so the B/O ratio never has to encode
 * "no offers exist" as a fake enormous number such as 999999.
 */
export const boStateEnum = pgEnum('bo_state', [
  'NORMAL', // bid > 0 and offer > 0 -> numeric ratio is meaningful
  'NO_OFFER', // offer = 0, bid > 0  -> ratio undefined (demand, no supply)
  'NO_BID', // bid = 0, offer > 0    -> ratio is 0
  'EMPTY_BOOK', // both sides zero    -> ratio undefined
]);

export const pressureSignalEnum = pgEnum('pressure_signal', [
  'STRONG_DEMAND',
  'DEMAND',
  'BALANCED',
  'SUPPLY',
  'STRONG_SUPPLY',
  'INSUFFICIENT_DATA',
]);

export const ingestionSourceTypeEnum = pgEnum('ingestion_source_type', [
  'CSV_MANUAL',
  'DSE_OFFICIAL',
  'LICENSED_FEED',
  'THIRD_PARTY_API',
  'DEV_PARSER', // development only, feature-flagged, never a production source
]);

export const ingestionStatusEnum = pgEnum('ingestion_status', [
  'RUNNING',
  'PREVIEW', // parsed + validated, awaiting operator approval
  'SUCCESS',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
]);

export const errorSeverityEnum = pgEnum('error_severity', ['WARNING', 'ERROR']);

export const periodTypeEnum = pgEnum('period_type', [
  'FY',
  'H1',
  'H2',
  'Q1',
  'Q2',
  'Q3',
  'Q4',
  'INTERIM',
]);

export const corporateActionTypeEnum = pgEnum('corporate_action_type', [
  'DIVIDEND',
  'STOCK_SPLIT',
  'BONUS_ISSUE',
  'RIGHTS_ISSUE',
  'AGM',
  'EGM',
  'EARNINGS_ANNOUNCEMENT',
  'SUSPENSION',
  'RESUMPTION',
  'DELISTING',
  'OTHER',
]);

export const userRoleEnum = pgEnum('user_role', ['VIEWER', 'ANALYST', 'ADMIN']);

/** How the reporting scale of a set of financial statements was established. */
export const scaleSourceEnum = pgEnum('scale_source', [
  'DECLARED',
  'INFERRED',
  'UNDETERMINED',
  'NOT_APPLICABLE',
]);

export const alertTypeEnum = pgEnum('alert_type', [
  'BO_RATIO_THRESHOLD',
  'BO_MOMENTUM_THRESHOLD',
  'UNUSUAL_VOLUME',
  'PRICE_CHANGE',
  'VALUATION_THRESHOLD',
  'CORPORATE_ACTION',
  'PRESSURE_SCORE',
]);

export const alertComparatorEnum = pgEnum('alert_comparator', [
  'ABOVE',
  'BELOW',
  'CROSSES_ABOVE',
  'CROSSES_BELOW',
]);

/* -------------------------------------------------------------------------- */
/* Shared column builders                                                     */
/* -------------------------------------------------------------------------- */

const createdAt = timestamp('created_at', { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .defaultNow();

/** TZS price. 4 dp is more than the DSE quotes, but leaves room for adjustments. */
const price = (name: string) => numeric(name, { precision: 20, scale: 4 });
/** TZS turnover / cash value. */
const money = (name: string) => numeric(name, { precision: 24, scale: 4 });
/** TZS market capitalisation - DSE market caps reach 10^13. */
const bigMoney = (name: string) => numeric(name, { precision: 30, scale: 4 });
/** Percentages stored as e.g. 127.500000 meaning +127.5%. */
const pct = (name: string) => numeric(name, { precision: 14, scale: 6 });
/** Unbounded ratios such as bid/offer. */
const ratio = (name: string) => numeric(name, { precision: 18, scale: 6 });
/** 0-100 scores. */
const score = (name: string) => numeric(name, { precision: 6, scale: 2 });
/** Share / unit quantities. */
const qty = (name: string) => bigint(name, { mode: 'number' });

/* -------------------------------------------------------------------------- */
/* instruments - the security master                                          */
/* -------------------------------------------------------------------------- */

export const instruments = pgTable(
  'instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbol: varchar('symbol', { length: 20 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    securityType: securityTypeEnum('security_type').notNull().default('EQUITY'),
    sector: varchar('sector', { length: 80 }),
    /** Cross-listed counters behave differently in market breadth statistics. */
    isCrossListed: boolean('is_cross_listed').notNull().default(false),
    countryOfIncorporation: varchar('country_of_incorporation', { length: 2 })
      .notNull()
      .default('TZ'),
    currency: varchar('currency', { length: 3 }).notNull().default('TZS'),
    listedDate: date('listed_date'),
    active: boolean('active').notNull().default(true),
    sharesOutstanding: qty('shares_outstanding'),
    /** Identifier used by the upstream data source, when it differs from symbol. */
    sourceIdentifier: varchar('source_identifier', { length: 80 }),
    isin: varchar('isin', { length: 12 }),
    notes: text('notes'),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('instruments_symbol_key').on(t.symbol),
    index('instruments_active_idx').on(t.active),
    index('instruments_sector_idx').on(t.sector),
  ],
);

/* -------------------------------------------------------------------------- */
/* ingestion_sources                                                          */
/* -------------------------------------------------------------------------- */

export const ingestionSources = pgTable(
  'ingestion_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    type: ingestionSourceTypeEnum('type').notNull(),
    endpoint: text('endpoint'),
    enabled: boolean('enabled').notNull().default(true),
    /** Lower number wins when several sources report the same instrument/date. */
    priority: smallint('priority').notNull().default(100),
    /**
     * Non-secret configuration only (timeouts, column maps, timezone...).
     * Credentials live in environment variables and are referenced by name via
     * `credentialsEnvKey`; they are never written to this table.
     */
    configuration: jsonb('configuration')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    credentialsEnvKey: varchar('credentials_env_key', { length: 100 }),
    /** Whether this source is licensed for commercial redistribution. */
    isLicensed: boolean('is_licensed').notNull().default(false),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastHealthStatus: varchar('last_health_status', { length: 20 }),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('ingestion_sources_name_key').on(t.name)],
);

/* -------------------------------------------------------------------------- */
/* ingestion_runs                                                             */
/* -------------------------------------------------------------------------- */

export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => ingestionSources.id, { onDelete: 'restrict' }),
    /** Trading date the payload claims to describe (null for multi-date files). */
    tradingDate: date('trading_date'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    recordsReceived: integer('records_received').notNull().default(0),
    inserted: integer('inserted').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    unchanged: integer('unchanged').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),
    warnings: integer('warnings').notNull().default(0),
    status: ingestionStatusEnum('status').notNull().default('RUNNING'),
    errorSummary: text('error_summary'),
    /** SHA-256 of the payload; lets a re-upload of the same file be recognised. */
    payloadChecksum: varchar('payload_checksum', { length: 64 }),
    fileName: varchar('file_name', { length: 255 }),
    triggeredBy: varchar('triggered_by', { length: 120 }),
    createdAt,
  },
  (t) => [
    index('ingestion_runs_source_started_idx').on(t.sourceId, t.startedAt),
    index('ingestion_runs_status_idx').on(t.status),
    index('ingestion_runs_trading_date_idx').on(t.tradingDate),
  ],
);

/* -------------------------------------------------------------------------- */
/* market_daily - the raw observation table                                   */
/* -------------------------------------------------------------------------- */

export const marketDaily = pgTable(
  'market_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    tradingDate: date('trading_date').notNull(),

    open: price('open'),
    previousClose: price('previous_close'),
    close: price('close'),
    high: price('high'),
    low: price('low'),
    /** Session change vs previous close, in percent. */
    changePct: pct('change_pct'),

    turnoverTzs: money('turnover_tzs'),
    deals: integer('deals'),
    volume: qty('volume'),

    outstandingBidQty: qty('outstanding_bid_qty'),
    outstandingOfferQty: qty('outstanding_offer_qty'),

    marketCapTzs: bigMoney('market_cap_tzs'),

    sourceId: uuid('source_id').references(() => ingestionSources.id, {
      onDelete: 'set null',
    }),
    /** Timestamp asserted by the source, distinct from when we stored it. */
    sourceTimestamp: timestamp('source_timestamp', { withTimezone: true }),
    importedAt: timestamp('imported_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ingestionRunId: uuid('ingestion_run_id').references(() => ingestionRuns.id, {
      onDelete: 'set null',
    }),
    validationStatus: validationStatusEnum('validation_status')
      .notNull()
      .default('VALID'),
    /** Human-readable warnings attached to an otherwise-accepted row. */
    validationNotes: jsonb('validation_notes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt,
  },
  (t) => [
    // Idempotency contract: one observation per instrument per trading date.
    uniqueIndex('market_daily_instrument_date_key').on(
      t.instrumentId,
      t.tradingDate,
    ),
    index('market_daily_trading_date_idx').on(t.tradingDate),
    // Serves "latest N sessions for this instrument" without a sort.
    index('market_daily_instrument_date_desc_idx').on(
      t.instrumentId,
      t.tradingDate.desc(),
    ),
    index('market_daily_date_turnover_idx').on(t.tradingDate, t.turnoverTzs),
  ],
);

/* -------------------------------------------------------------------------- */
/* ingestion_errors - rejected rows, kept for the admin error inspector       */
/* -------------------------------------------------------------------------- */

export const ingestionErrors = pgTable(
  'ingestion_errors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ingestionRunId: uuid('ingestion_run_id')
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number'),
    symbol: varchar('symbol', { length: 40 }),
    tradingDate: varchar('trading_date_raw', { length: 40 }),
    severity: errorSeverityEnum('severity').notNull().default('ERROR'),
    /** Machine-readable rule id, e.g. CLOSE_OUTSIDE_HIGH_LOW. */
    code: varchar('code', { length: 60 }).notNull(),
    message: text('message').notNull(),
    field: varchar('field', { length: 60 }),
    /** The offending raw row, so an operator can see exactly what arrived. */
    rawRow: jsonb('raw_row').$type<Record<string, unknown>>(),
    createdAt,
  },
  (t) => [
    index('ingestion_errors_run_idx').on(t.ingestionRunId),
    index('ingestion_errors_code_idx').on(t.code),
  ],
);

/* -------------------------------------------------------------------------- */
/* raw_market_payloads - audit trail, never served publicly                   */
/* -------------------------------------------------------------------------- */

export const rawMarketPayloads = pgTable(
  'raw_market_payloads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ingestionRunId: uuid('ingestion_run_id')
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => ingestionSources.id, {
      onDelete: 'set null',
    }),
    tradingDate: date('trading_date'),
    contentType: varchar('content_type', { length: 60 }).notNull().default('text/csv'),
    checksum: varchar('checksum', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull().default(0),
    payload: text('payload').notNull(),
    createdAt,
  },
  (t) => [
    index('raw_market_payloads_run_idx').on(t.ingestionRunId),
    index('raw_market_payloads_checksum_idx').on(t.checksum),
  ],
);

/* -------------------------------------------------------------------------- */
/* scoring_models - versioned, inspectable score weights                      */
/* -------------------------------------------------------------------------- */

export const scoringModels = pgTable(
  'scoring_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. "pressure-v1", "opportunity-v1". Referenced by derived tables. */
    version: varchar('version', { length: 40 }).notNull(),
    family: varchar('family', { length: 40 }).notNull(),
    description: text('description'),
    /** Full weight set, published verbatim on /methodology. */
    weights: jsonb('weights')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    parameters: jsonb('parameters')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean('active').notNull().default(true),
    createdAt,
  },
  (t) => [uniqueIndex('scoring_models_version_key').on(t.version)],
);

/* -------------------------------------------------------------------------- */
/* analytics_daily - derived per-instrument metrics                           */
/* -------------------------------------------------------------------------- */

export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    tradingDate: date('trading_date').notNull(),

    /** Null whenever the ratio is undefined; read together with boState. */
    boRatio: ratio('bo_ratio'),
    boState: boStateEnum('bo_state').notNull().default('EMPTY_BOOK'),

    bidValueTzs: money('bid_value_tzs'),
    offerValueTzs: money('offer_value_tzs'),
    bidPctMcap: pct('bid_pct_mcap'),
    offerPctMcap: pct('offer_pct_mcap'),

    avgBo5d: ratio('avg_bo_5d'),
    boMomentumPct: pct('bo_momentum_pct'),
    boObservations5d: smallint('bo_observations_5d').notNull().default(0),

    avgVolume5d: numeric('avg_volume_5d', { precision: 22, scale: 4 }),
    avgVolume20d: numeric('avg_volume_20d', { precision: 22, scale: 4 }),
    medianVolume20d: numeric('median_volume_20d', { precision: 22, scale: 4 }),
    volumeRatio: ratio('volume_ratio'),
    turnoverRatio: ratio('turnover_ratio'),
    avgDealSize: numeric('avg_deal_size', { precision: 22, scale: 4 }),
    liquidityPercentile: numeric('liquidity_percentile', {
      precision: 6,
      scale: 2,
    }),

    return1d: pct('return_1d'),
    return5d: pct('return_5d'),
    return20d: pct('return_20d'),
    rangePct: pct('range_pct'),
    volatility20d: pct('volatility_20d'),

    liquidityScore: score('liquidity_score'),
    pressureScore: score('pressure_score'),
    opportunityScore: score('opportunity_score'),
    dataConfidenceScore: score('data_confidence_score'),
    pressureSignal: pressureSignalEnum('pressure_signal')
      .notNull()
      .default('INSUFFICIENT_DATA'),

    /** Per-component contributions, surfaced verbatim by the API. */
    pressureComponents: jsonb('pressure_components')
      .$type<Record<string, number | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    opportunityComponents: jsonb('opportunity_components')
      .$type<Record<string, number | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    confidenceFactors: jsonb('confidence_factors')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    modelVersion: varchar('model_version', { length: 40 })
      .notNull()
      .default('v1'),
  },
  (t) => [
    uniqueIndex('analytics_daily_instrument_date_model_key').on(
      t.instrumentId,
      t.tradingDate,
      t.modelVersion,
    ),
    index('analytics_daily_date_model_idx').on(t.tradingDate, t.modelVersion),
    index('analytics_daily_instrument_date_desc_idx').on(
      t.instrumentId,
      t.tradingDate.desc(),
    ),
    index('analytics_daily_pressure_idx').on(t.tradingDate, t.pressureScore),
  ],
);

/* -------------------------------------------------------------------------- */
/* market_daily_summary - derived whole-market aggregates                     */
/* -------------------------------------------------------------------------- */

export const marketDailySummary = pgTable(
  'market_daily_summary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tradingDate: date('trading_date').notNull(),
    totalTurnoverTzs: bigMoney('total_turnover_tzs'),
    totalVolume: qty('total_volume'),
    totalDeals: integer('total_deals'),
    countersTraded: integer('counters_traded'),
    countersListed: integer('counters_listed'),
    totalBidQty: qty('total_bid_qty'),
    totalOfferQty: qty('total_offer_qty'),
    marketBoRatio: ratio('market_bo_ratio'),
    marketBoState: boStateEnum('market_bo_state').notNull().default('EMPTY_BOOK'),
    totalMarketCapTzs: bigMoney('total_market_cap_tzs'),
    gainers: integer('gainers'),
    losers: integer('losers'),
    unchanged: integer('unchanged'),
    marketPressureScore: score('market_pressure_score'),
    marketPressureSignal: pressureSignalEnum('market_pressure_signal')
      .notNull()
      .default('INSUFFICIENT_DATA'),
    breadthComponents: jsonb('breadth_components')
      .$type<Record<string, number | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    dataConfidenceScore: score('data_confidence_score'),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    modelVersion: varchar('model_version', { length: 40 })
      .notNull()
      .default('v1'),
  },
  (t) => [
    uniqueIndex('market_daily_summary_date_model_key').on(
      t.tradingDate,
      t.modelVersion,
    ),
    index('market_daily_summary_date_idx').on(t.tradingDate.desc()),
  ],
);

/* -------------------------------------------------------------------------- */
/* fundamentals                                                               */
/* -------------------------------------------------------------------------- */

export const fundamentals = pgTable(
  'fundamentals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    /** Period end date, e.g. 2025-12-31 for FY2025. */
    periodEnd: date('period_end').notNull(),
    periodType: periodTypeEnum('period_type').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('TZS'),

    // Income statement
    revenue: bigMoney('revenue'),
    grossProfit: bigMoney('gross_profit'),
    operatingIncome: bigMoney('operating_income'),
    profitBeforeTax: bigMoney('profit_before_tax'),
    netIncome: bigMoney('net_income'),

    // Balance sheet
    totalAssets: bigMoney('total_assets'),
    totalEquity: bigMoney('total_equity'),
    totalLiabilities: bigMoney('total_liabilities'),
    totalDebt: bigMoney('total_debt'),
    cashAndEquivalents: bigMoney('cash_and_equivalents'),

    // Cash flow
    operatingCashFlow: bigMoney('operating_cash_flow'),
    capitalExpenditure: bigMoney('capital_expenditure'),
    freeCashFlow: bigMoney('free_cash_flow'),

    // Per-share
    eps: price('eps'),
    dps: price('dps'),
    bookValuePerShare: price('book_value_per_share'),
    sharesOutstanding: qty('shares_outstanding'),
    weightedAvgShares: qty('weighted_avg_shares'),

    // Ratios (stored so a published figure never silently changes)
    roa: pct('roa'),
    roe: pct('roe'),
    grossMargin: pct('gross_margin'),
    netMargin: pct('net_margin'),
    debtToEquity: ratio('debt_to_equity'),
    payoutRatio: pct('payout_ratio'),

    // Banking-specific. Null for non-financial issuers.
    loansAndAdvances: bigMoney('loans_and_advances'),
    customerDeposits: bigMoney('customer_deposits'),
    netInterestIncome: bigMoney('net_interest_income'),
    netInterestMargin: pct('net_interest_margin'),
    nplRatio: pct('npl_ratio'),
    capitalAdequacyRatio: pct('capital_adequacy_ratio'),
    tier1CapitalRatio: pct('tier1_capital_ratio'),
    costToIncomeRatio: pct('cost_to_income_ratio'),
    loanToDepositRatio: pct('loan_to_deposit_ratio'),

    /**
     * Multiplier that was applied to convert the source figures to absolute
     * TZS. Monetary columns above are stored ALREADY NORMALISED; this records
     * what was done so it can be audited or reversed.
     */
    reportingScale: numeric('reporting_scale', { precision: 12, scale: 2 })
      .notNull()
      .default('1'),
    scaleSource: scaleSourceEnum('scale_source')
      .notNull()
      .default('NOT_APPLICABLE'),
    scaleNote: text('scale_note'),

    source: varchar('source', { length: 200 }),
    sourceUrl: text('source_url'),
    /** True only after a human has checked the figures against the filing. */
    verified: boolean('verified').notNull().default(false),
    verifiedBy: varchar('verified_by', { length: 120 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('fundamentals_instrument_period_key').on(
      t.instrumentId,
      t.periodEnd,
      t.periodType,
    ),
    index('fundamentals_instrument_year_idx').on(t.instrumentId, t.fiscalYear),
  ],
);

/* -------------------------------------------------------------------------- */
/* valuations - derived from fundamentals + price                             */
/* -------------------------------------------------------------------------- */

export const valuations = pgTable(
  'valuations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    tradingDate: date('trading_date').notNull(),
    /** Which fundamentals row the multiples were computed against. */
    fundamentalsId: uuid('fundamentals_id').references(() => fundamentals.id, {
      onDelete: 'set null',
    }),

    closePrice: price('close_price'),
    marketCapTzs: bigMoney('market_cap_tzs'),

    peRatio: ratio('pe_ratio'),
    pbRatio: ratio('pb_ratio'),
    priceToSales: ratio('price_to_sales'),
    dividendYield: pct('dividend_yield'),
    earningsYield: pct('earnings_yield'),
    enterpriseValueTzs: bigMoney('enterprise_value_tzs'),
    evToEbitda: ratio('ev_to_ebitda'),
    evToSales: ratio('ev_to_sales'),

    /** Explains why any of the above are null (e.g. NEGATIVE_EPS, NO_FUNDAMENTALS). */
    notes: jsonb('notes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    dataConfidenceScore: score('data_confidence_score'),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    modelVersion: varchar('model_version', { length: 40 })
      .notNull()
      .default('v1'),
  },
  (t) => [
    uniqueIndex('valuations_instrument_date_model_key').on(
      t.instrumentId,
      t.tradingDate,
      t.modelVersion,
    ),
    index('valuations_date_idx').on(t.tradingDate),
  ],
);

/* -------------------------------------------------------------------------- */
/* corporate_actions                                                          */
/* -------------------------------------------------------------------------- */

export const corporateActions = pgTable(
  'corporate_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    type: corporateActionTypeEnum('type').notNull(),
    announcedDate: date('announced_date'),
    exDate: date('ex_date'),
    recordDate: date('record_date'),
    paymentDate: date('payment_date'),
    effectiveDate: date('effective_date'),

    /** Dividend amount per share, in `currency`. */
    amountPerShare: price('amount_per_share'),
    currency: varchar('currency', { length: 3 }).notNull().default('TZS'),
    /** Split / bonus / rights ratio, e.g. 2.0 for a 2-for-1 split. */
    ratioFrom: numeric('ratio_from', { precision: 12, scale: 6 }),
    ratioTo: numeric('ratio_to', { precision: 12, scale: 6 }),
    subscriptionPrice: price('subscription_price'),

    title: varchar('title', { length: 250 }).notNull(),
    description: text('description'),
    source: varchar('source', { length: 200 }),
    sourceUrl: text('source_url'),
    verified: boolean('verified').notNull().default(false),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('corporate_actions_instrument_idx').on(t.instrumentId),
    index('corporate_actions_ex_date_idx').on(t.exDate),
    index('corporate_actions_type_idx').on(t.type),
    uniqueIndex('corporate_actions_natural_key').on(
      t.instrumentId,
      t.type,
      t.effectiveDate,
      t.title,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* users / watchlists / alerts                                                */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 120 }),
    role: userRoleEnum('role').notNull().default('VIEWER'),
    /** Argon2/bcrypt hash. Null while an external identity provider is used. */
    passwordHash: text('password_hash'),
    locale: varchar('locale', { length: 5 }).notNull().default('en'),
    active: boolean('active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const watchlists = pgTable(
  'watchlists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('watchlists_user_name_key').on(t.userId, t.name)],
);

export const watchlistItems = pgTable(
  'watchlist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    watchlistId: uuid('watchlist_id')
      .notNull()
      .references(() => watchlists.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull().default(0),
    /** Optional personal cost basis; used only for the owner's own view. */
    notes: text('notes'),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('watchlist_items_unique').on(t.watchlistId, t.instrumentId),
    index('watchlist_items_instrument_idx').on(t.instrumentId),
  ],
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null means "any instrument" - used for market-wide alerts. */
    instrumentId: uuid('instrument_id').references(() => instruments.id, {
      onDelete: 'cascade',
    }),
    type: alertTypeEnum('type').notNull(),
    comparator: alertComparatorEnum('comparator').notNull().default('ABOVE'),
    threshold: numeric('threshold', { precision: 18, scale: 6 }),
    parameters: jsonb('parameters')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    lastTriggeredValue: numeric('last_triggered_value', {
      precision: 18,
      scale: 6,
    }),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('alerts_user_idx').on(t.userId),
    index('alerts_instrument_idx').on(t.instrumentId),
    index('alerts_enabled_idx').on(t.enabled),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const instrumentsRelations = relations(instruments, ({ many }) => ({
  marketDaily: many(marketDaily),
  analyticsDaily: many(analyticsDaily),
  fundamentals: many(fundamentals),
  valuations: many(valuations),
  corporateActions: many(corporateActions),
  watchlistItems: many(watchlistItems),
}));

export const marketDailyRelations = relations(marketDaily, ({ one }) => ({
  instrument: one(instruments, {
    fields: [marketDaily.instrumentId],
    references: [instruments.id],
  }),
  source: one(ingestionSources, {
    fields: [marketDaily.sourceId],
    references: [ingestionSources.id],
  }),
  ingestionRun: one(ingestionRuns, {
    fields: [marketDaily.ingestionRunId],
    references: [ingestionRuns.id],
  }),
}));

export const analyticsDailyRelations = relations(analyticsDaily, ({ one }) => ({
  instrument: one(instruments, {
    fields: [analyticsDaily.instrumentId],
    references: [instruments.id],
  }),
}));

export const ingestionRunsRelations = relations(
  ingestionRuns,
  ({ one, many }) => ({
    source: one(ingestionSources, {
      fields: [ingestionRuns.sourceId],
      references: [ingestionSources.id],
    }),
    errors: many(ingestionErrors),
    payloads: many(rawMarketPayloads),
  }),
);

export const ingestionErrorsRelations = relations(
  ingestionErrors,
  ({ one }) => ({
    run: one(ingestionRuns, {
      fields: [ingestionErrors.ingestionRunId],
      references: [ingestionRuns.id],
    }),
  }),
);

export const fundamentalsRelations = relations(fundamentals, ({ one }) => ({
  instrument: one(instruments, {
    fields: [fundamentals.instrumentId],
    references: [instruments.id],
  }),
}));

export const valuationsRelations = relations(valuations, ({ one }) => ({
  instrument: one(instruments, {
    fields: [valuations.instrumentId],
    references: [instruments.id],
  }),
  fundamentals: one(fundamentals, {
    fields: [valuations.fundamentalsId],
    references: [fundamentals.id],
  }),
}));

export const corporateActionsRelations = relations(
  corporateActions,
  ({ one }) => ({
    instrument: one(instruments, {
      fields: [corporateActions.instrumentId],
      references: [instruments.id],
    }),
  }),
);

export const usersRelations = relations(users, ({ many }) => ({
  watchlists: many(watchlists),
  alerts: many(alerts),
}));

export const watchlistsRelations = relations(watchlists, ({ one, many }) => ({
  user: one(users, { fields: [watchlists.userId], references: [users.id] }),
  items: many(watchlistItems),
}));

export const watchlistItemsRelations = relations(watchlistItems, ({ one }) => ({
  watchlist: one(watchlists, {
    fields: [watchlistItems.watchlistId],
    references: [watchlists.id],
  }),
  instrument: one(instruments, {
    fields: [watchlistItems.instrumentId],
    references: [instruments.id],
  }),
}));

/* -------------------------------------------------------------------------- */
/* Inferred row types                                                         */
/* -------------------------------------------------------------------------- */

export type Instrument = typeof instruments.$inferSelect;
export type NewInstrument = typeof instruments.$inferInsert;
export type MarketDailyRow = typeof marketDaily.$inferSelect;
export type NewMarketDailyRow = typeof marketDaily.$inferInsert;
export type AnalyticsDailyRow = typeof analyticsDaily.$inferSelect;
export type NewAnalyticsDailyRow = typeof analyticsDaily.$inferInsert;
export type MarketDailySummaryRow = typeof marketDailySummary.$inferSelect;
export type NewMarketDailySummaryRow = typeof marketDailySummary.$inferInsert;
export type FundamentalsRow = typeof fundamentals.$inferSelect;
export type ValuationRow = typeof valuations.$inferSelect;
export type CorporateActionRow = typeof corporateActions.$inferSelect;
export type IngestionRun = typeof ingestionRuns.$inferSelect;
export type IngestionSource = typeof ingestionSources.$inferSelect;
export type IngestionErrorRow = typeof ingestionErrors.$inferSelect;
export type NewIngestionErrorRow = typeof ingestionErrors.$inferInsert;
export type User = typeof users.$inferSelect;
export type Watchlist = typeof watchlists.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type BoState = (typeof boStateEnum.enumValues)[number];
export type PressureSignal = (typeof pressureSignalEnum.enumValues)[number];
export type ValidationStatus = (typeof validationStatusEnum.enumValues)[number];

/**
 * Fixed-window rate-limit counters.
 *
 * Kept in PostgreSQL rather than in process memory because Railway may run
 * several instances of the web service: an in-memory counter would give each
 * instance its own allowance, so the effective limit would be the configured
 * one multiplied by the instance count.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    /** Bucket identity, e.g. "admin-login:203.0.113.4". */
    key: varchar('key', { length: 200 }).primaryKey(),
    /** Start of the current window. */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
    updatedAt,
  },
  (t) => [index('rate_limits_window_idx').on(t.windowStart)],
);

export type RateLimitRow = typeof rateLimits.$inferSelect;

/* ========================================================================== */
/* Ranking engine                                                             */
/*                                                                            */
/* Rankings combine a long-term fundamental score with the current sentiment  */
/* (market pressure) score the analytics engine already produces. The two are */
/* never conflated: a security can have weak fundamentals and excellent       */
/* sentiment and still rank poorly. That is the intended behaviour.           */
/* ========================================================================== */

export const rankingStatusEnum = pgEnum('ranking_status', [
  'GENERATING',
  'COMPLETE',
  'PARTIAL',
  'FAILED',
]);

export const rankingGradeEnum = pgEnum('ranking_grade', [
  'BORA_SANA',
  'NZURI_SANA',
  'NZURI',
  'WASTANI',
  'DHAIFU',
  'DHAIFU_SANA',
]);

export const marketDemandEnum = pgEnum('market_demand', [
  'DEMAND_KUBWA_SANA',
  'DEMAND_KUBWA',
  'DEMAND_WASTANI',
  'DEMAND_NDOGO_SANA',
]);

export const interpretationCodeEnum = pgEnum('interpretation_code', [
  'QUALITY_AND_TREND_ALIGNED',
  'QUALITY_AWAITING_TREND',
  'AVERAGE_QUALITY',
  'AVERAGE_QUALITY_WEAK_TREND',
  'WEAK_QUALITY',
]);

export const exclusionReasonEnum = pgEnum('exclusion_reason', [
  'MISSING_FUNDAMENTALS',
  'MISSING_SENTIMENT',
  'STALE_FUNDAMENTALS',
  'BELOW_MINIMUM_CONFIDENCE',
  'BELOW_MINIMUM_LIQUIDITY',
  'INSTRUMENT_INACTIVE',
]);

export const fundamentalSourceStatusEnum = pgEnum('fundamental_source_status', [
  'VERIFIED',
  'UNVERIFIED',
  'PARTIAL',
]);

/**
 * Versioned ranking configuration.
 *
 * Weights live in the database rather than in application code so that a
 * published ranking can be reproduced exactly, and so future models
 * (Long-Term, Balanced, Momentum) can be added without touching the engine.
 */
export const rankingModels = pgTable(
  'ranking_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 40 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    /** Must sum to exactly 1.0000 with sentimentWeight. Validated in code. */
    fundamentalWeight: numeric('fundamental_weight', { precision: 5, scale: 4 }).notNull(),
    sentimentWeight: numeric('sentiment_weight', { precision: 5, scale: 4 }).notNull(),
    /** Entries below these are marked ineligible, with a reason, not dropped. */
    minimumConfidence: numeric('minimum_confidence', { precision: 6, scale: 2 }),
    minimumLiquidity: numeric('minimum_liquidity', { precision: 6, scale: 2 }),
    /** Grade band edges, published verbatim on /methodology. */
    gradeBands: jsonb('grade_bands')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean('active').notNull().default(true),
    version: varchar('version', { length: 20 }).notNull().default('1.0'),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('ranking_models_code_version_key').on(t.code, t.version)],
);

/**
 * Fundamental scores derived from the `fundamentals` table.
 *
 * Kept separate from `fundamentals` because that table holds reported figures
 * and this one holds a derived, versioned score. A row exists only where there
 * was financial data to score. A missing score is never written as zero.
 */
export const fundamentalScores = pgTable(
  'fundamental_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    financialPeriod: date('financial_period').notNull(),
    periodType: periodTypeEnum('period_type').notNull(),
    fundamentalsId: uuid('fundamentals_id').references(() => fundamentals.id, {
      onDelete: 'cascade',
    }),
    score: numeric('score', { precision: 8, scale: 4 }).notNull(),
    /** Percentage of the model weight that actually had data behind it. */
    dataCompleteness: numeric('data_completeness', { precision: 6, scale: 2 }).notNull(),
    components: jsonb('components')
      .$type<Record<string, number | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    methodologyVersion: varchar('methodology_version', { length: 40 })
      .notNull()
      .default('fundamental-v1'),
    sourceStatus: fundamentalSourceStatusEnum('source_status')
      .notNull()
      .default('UNVERIFIED'),
    /**
     * When the underlying results were published. The ranking generator uses
     * this to exclude reports published AFTER the ranking date, which is what
     * prevents look-ahead bias.
     */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    calculatedAt: timestamp('calculated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('fundamental_scores_instrument_period_model_key').on(
      t.instrumentId,
      t.financialPeriod,
      t.periodType,
      t.methodologyVersion,
    ),
    index('fundamental_scores_instrument_idx').on(t.instrumentId),
    index('fundamental_scores_published_idx').on(t.publishedAt),
  ],
);

export const rankingSnapshots = pgTable(
  'ranking_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rankingModelId: uuid('ranking_model_id')
      .notNull()
      .references(() => rankingModels.id, { onDelete: 'restrict' }),
    tradingDate: date('trading_date').notNull(),
    /** Latest financial period any constituent used, shown in the page header. */
    fundamentalPeriod: date('fundamental_period'),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    modelVersion: varchar('model_version', { length: 20 }).notNull().default('1.0'),
    status: rankingStatusEnum('status').notNull().default('GENERATING'),
    instrumentsConsidered: integer('instruments_considered').notNull().default(0),
    instrumentsRanked: integer('instruments_ranked').notNull().default(0),
    instrumentsExcluded: integer('instruments_excluded').notNull().default(0),
    notes: text('notes'),
  },
  (t) => [
    // One snapshot per model version per date; re-running updates it in place
    // rather than accumulating duplicates.
    uniqueIndex('ranking_snapshots_model_date_key').on(
      t.rankingModelId,
      t.tradingDate,
      t.modelVersion,
    ),
    index('ranking_snapshots_date_idx').on(t.tradingDate.desc()),
  ],
);

export const rankingEntries = pgTable(
  'ranking_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rankingSnapshotId: uuid('ranking_snapshot_id')
      .notNull()
      .references(() => rankingSnapshots.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    /** Null for ineligible entries: they are recorded, with a reason, unranked. */
    rank: integer('rank'),
    previousRank: integer('previous_rank'),
    /** Positive means improvement, i.e. moved toward rank 1. Null for new entrants. */
    rankChange: integer('rank_change'),
    isNewEntrant: boolean('is_new_entrant').notNull().default(false),

    /** Stored at higher precision than displayed; the UI rounds to 1 dp. */
    fundamentalScore: numeric('fundamental_score', { precision: 8, scale: 4 }),
    sentimentScore: numeric('sentiment_score', { precision: 8, scale: 4 }),
    overallScore: numeric('overall_score', { precision: 8, scale: 4 }),

    grade: rankingGradeEnum('grade'),
    marketDemand: marketDemandEnum('market_demand'),
    interpretationCode: interpretationCodeEnum('interpretation_code'),
    interpretationEn: text('interpretation_en'),
    interpretationSw: text('interpretation_sw'),

    liquidityScore: numeric('liquidity_score', { precision: 6, scale: 2 }),
    dataConfidence: numeric('data_confidence', { precision: 6, scale: 2 }),
    /** Which financial period backed this entry's fundamental score. */
    fundamentalPeriod: date('fundamental_period'),

    eligible: boolean('eligible').notNull().default(false),
    exclusionReason: exclusionReasonEnum('exclusion_reason'),
    createdAt,
  },
  (t) => [
    uniqueIndex('ranking_entries_snapshot_instrument_key').on(
      t.rankingSnapshotId,
      t.instrumentId,
    ),
    index('ranking_entries_snapshot_rank_idx').on(t.rankingSnapshotId, t.rank),
    index('ranking_entries_instrument_idx').on(t.instrumentId),
    index('ranking_entries_overall_score_idx').on(t.overallScore),
    index('ranking_entries_grade_idx').on(t.grade),
  ],
);

export const rankingModelsRelations = relations(rankingModels, ({ many }) => ({
  snapshots: many(rankingSnapshots),
}));

export const rankingSnapshotsRelations = relations(
  rankingSnapshots,
  ({ one, many }) => ({
    model: one(rankingModels, {
      fields: [rankingSnapshots.rankingModelId],
      references: [rankingModels.id],
    }),
    entries: many(rankingEntries),
  }),
);

export const rankingEntriesRelations = relations(rankingEntries, ({ one }) => ({
  snapshot: one(rankingSnapshots, {
    fields: [rankingEntries.rankingSnapshotId],
    references: [rankingSnapshots.id],
  }),
  instrument: one(instruments, {
    fields: [rankingEntries.instrumentId],
    references: [instruments.id],
  }),
}));

export const fundamentalScoresRelations = relations(
  fundamentalScores,
  ({ one }) => ({
    instrument: one(instruments, {
      fields: [fundamentalScores.instrumentId],
      references: [instruments.id],
    }),
    fundamentals: one(fundamentals, {
      fields: [fundamentalScores.fundamentalsId],
      references: [fundamentals.id],
    }),
  }),
);

export type RankingModel = typeof rankingModels.$inferSelect;
export type FundamentalScoreRow = typeof fundamentalScores.$inferSelect;
export type NewFundamentalScoreRow = typeof fundamentalScores.$inferInsert;
export type RankingSnapshot = typeof rankingSnapshots.$inferSelect;
export type NewRankingSnapshot = typeof rankingSnapshots.$inferInsert;
export type RankingEntryRow = typeof rankingEntries.$inferSelect;
export type NewRankingEntryRow = typeof rankingEntries.$inferInsert;
export type RankingGrade = (typeof rankingGradeEnum.enumValues)[number];
export type MarketDemand = (typeof marketDemandEnum.enumValues)[number];
export type InterpretationCode = (typeof interpretationCodeEnum.enumValues)[number];
export type ExclusionReason = (typeof exclusionReasonEnum.enumValues)[number];
export type RankingStatus = (typeof rankingStatusEnum.enumValues)[number];
