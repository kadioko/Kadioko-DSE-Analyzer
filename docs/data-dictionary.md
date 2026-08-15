# Data dictionary

Canonical definition: [`src/lib/db/schema.ts`](../src/lib/db/schema.ts).
Generated SQL: [`drizzle/0000_initial_schema.sql`](../drizzle/0000_initial_schema.sql).

## Conventions

| Kind | Type | Rationale |
| --- | --- | --- |
| Price | `NUMERIC(20,4)` | exact decimal; 4 dp leaves room for adjusted prices |
| Turnover / cash value | `NUMERIC(24,4)` | exact |
| Market capitalisation | `NUMERIC(30,4)` | DSE market caps reach 10¹³ TZS |
| Percentage | `NUMERIC(14,6)` | `127.500000` means +127.5% |
| Unbounded ratio | `NUMERIC(18,6)` | bid/offer, P/E, debt/equity |
| Score | `NUMERIC(6,2)` | 0–100 |
| Quantity | `bigint` | shares, volume, order quantities |
| Identifier | `uuid` | `defaultRandom()` |
| Timestamp | `timestamptz` | always timezone-aware |
| Trading date | `date` | East Africa Time calendar date |

No monetary value is stored as a floating-point type.

---

## Raw data

### `instruments` — security master

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | PK |
| `symbol` | varchar(20) | **unique** |
| `name` | varchar(200) | |
| `security_type` | enum | `EQUITY`, `PREFERENCE_SHARE`, `BOND`, `FUND`, `ETF`, `OTHER` |
| `sector` | varchar(80) | indexed |
| `is_cross_listed` | boolean | cross-listed counters behave differently in breadth |
| `country_of_incorporation` | varchar(2) | default `TZ` |
| `currency` | varchar(3) | default `TZS` |
| `listed_date` | date | |
| `active` | boolean | indexed |
| `shares_outstanding` | bigint | drives the market-cap consistency check |
| `source_identifier` | varchar(80) | upstream id when it differs from symbol |
| `isin` | varchar(12) | |

### `market_daily` — one observation per instrument per session

**Unique:** `(instrument_id, trading_date)` — the idempotency contract.

| Column | Type | Notes |
| --- | --- | --- |
| `instrument_id` | uuid → instruments | |
| `trading_date` | date | |
| `open` `previous_close` `close` `high` `low` | numeric(20,4) | |
| `change_pct` | numeric(14,6) | as reported by the source |
| `turnover_tzs` | numeric(24,4) | |
| `deals` | integer | |
| `volume` | bigint | |
| `outstanding_bid_qty` | bigint | resting demand at the close |
| `outstanding_offer_qty` | bigint | resting supply at the close |
| `market_cap_tzs` | numeric(30,4) | |
| `source_id` | uuid → ingestion_sources | |
| `source_timestamp` | timestamptz | asserted by the source |
| `imported_at` | timestamptz | when we stored it |
| `ingestion_run_id` | uuid → ingestion_runs | full traceability |
| `validation_status` | enum | `VALID`, `WARNING`, `REJECTED` |
| `validation_notes` | jsonb | warning strings attached to an accepted row |

**Indexes:** `(trading_date)`, `(instrument_id, trading_date DESC)`,
`(trading_date, turnover_tzs)`.

`null` means "not reported". It never means zero.

---

## Derived data

Every derived table carries `model_version` and `generated_at`, and is
reproducible from raw data alone.

### `analytics_daily`

**Unique:** `(instrument_id, trading_date, model_version)`

| Group | Columns |
| --- | --- |
| Order book | `bo_ratio`, `bo_state`, `bid_value_tzs`, `offer_value_tzs`, `bid_pct_mcap`, `offer_pct_mcap` |
| Momentum | `avg_bo_5d`, `bo_momentum_pct`, `bo_observations_5d` |
| Volume | `avg_volume_5d`, `avg_volume_20d`, `median_volume_20d`, `volume_ratio`, `turnover_ratio`, `avg_deal_size`, `liquidity_percentile` |
| Returns | `return_1d`, `return_5d`, `return_20d`, `range_pct`, `volatility_20d` |
| Scores | `liquidity_score`, `pressure_score`, `opportunity_score`, `data_confidence_score`, `pressure_signal` |
| Transparency | `pressure_components`, `opportunity_components`, `confidence_factors` (jsonb) |

`bo_ratio` is `null` whenever `bo_state` is `NO_OFFER` or `EMPTY_BOOK`. The two
columns must always be read together.

The three jsonb columns hold every component's raw sub-score, weight, points
contributed and explanation — this is what makes the scores inspectable.

### `market_daily_summary`

**Unique:** `(trading_date, model_version)`

`total_turnover_tzs`, `total_volume`, `total_deals`, `counters_traded`,
`counters_listed`, `total_bid_qty`, `total_offer_qty`, `market_bo_ratio`,
`market_bo_state`, `total_market_cap_tzs`, `gainers`, `losers`, `unchanged`,
`market_pressure_score`, `market_pressure_signal`, `breadth_components`,
`data_confidence_score`.

### `valuations`

**Unique:** `(instrument_id, trading_date, model_version)`

`pe_ratio`, `pb_ratio`, `price_to_sales`, `dividend_yield`, `earnings_yield`,
`enterprise_value_tzs`, `ev_to_ebitda`, `ev_to_sales`, plus `fundamentals_id`
recording which financial period the multiples were computed against.

`notes` (jsonb) explains any null — e.g. `NEGATIVE_EPS`, `NO_FUNDAMENTALS`.

---

## Fundamentals

### `fundamentals`

**Unique:** `(instrument_id, period_end, period_type)`

| Group | Columns |
| --- | --- |
| Period | `period_end`, `period_type` (`FY`/`H1`/`Q1`…), `fiscal_year`, `currency` |
| Income | `revenue`, `gross_profit`, `operating_income`, `profit_before_tax`, `net_income` |
| Balance sheet | `total_assets`, `total_equity`, `total_liabilities`, `total_debt`, `cash_and_equivalents` |
| Cash flow | `operating_cash_flow`, `capital_expenditure`, `free_cash_flow` |
| Per share | `eps`, `dps`, `book_value_per_share`, `shares_outstanding`, `weighted_avg_shares` |
| Ratios | `roa`, `roe`, `gross_margin`, `net_margin`, `debt_to_equity`, `payout_ratio` |
| Banking | `loans_and_advances`, `customer_deposits`, `net_interest_income`, `net_interest_margin`, `npl_ratio`, `capital_adequacy_ratio`, `tier1_capital_ratio`, `cost_to_income_ratio`, `loan_to_deposit_ratio` |
| Provenance | `source`, `source_url`, `verified`, `verified_by`, `published_at` |

Banking columns are `null` for non-financial issuers. `verified` is true only
after a human has checked the figures against the published filing; unverified
figures reduce data confidence.

### `corporate_actions`

`type` (`DIVIDEND`, `STOCK_SPLIT`, `BONUS_ISSUE`, `RIGHTS_ISSUE`, `AGM`, `EGM`,
`EARNINGS_ANNOUNCEMENT`, `SUSPENSION`, `RESUMPTION`, `DELISTING`, `OTHER`),
`announced_date`, `ex_date`, `record_date`, `payment_date`, `effective_date`,
`amount_per_share`, `ratio_from`/`ratio_to`, `subscription_price`, provenance.

---

## Ingestion

### `ingestion_sources`

`name` (unique), `type`, `endpoint`, `enabled`, `priority` (lower wins when two
sources report the same instrument/date), `configuration` (jsonb),
`credentials_env_key`, `is_licensed`, health-check fields.

**Secrets are never stored here.** Credentials live in environment variables;
this table records only the variable *name*.

### `ingestion_runs`

`source_id`, `trading_date`, `started_at`, `completed_at`, `records_received`,
`inserted`, `updated`, `unchanged`, `rejected`, `warnings`, `status`
(`RUNNING`, `PREVIEW`, `SUCCESS`, `PARTIAL`, `FAILED`, `CANCELLED`),
`error_summary`, `payload_checksum` (SHA-256), `file_name`, `triggered_by`.

### `ingestion_errors`

`row_number`, `symbol`, `trading_date_raw`, `severity`, `code`, `message`,
`field`, `raw_row` (jsonb) — the offending row exactly as it arrived.

### `raw_market_payloads`

`checksum`, `byte_size`, `content_type`, `payload`. Never served publicly.

### `scoring_models`

`version` (unique), `family`, `description`, `weights` (jsonb), `parameters`
(jsonb), `active`. Published verbatim on `/methodology`.

---

## Users

`users` (`email` unique, `role` ∈ `VIEWER`/`ANALYST`/`ADMIN`, `password_hash`,
`locale`), `watchlists`, `watchlist_items`, `alerts` (`type`, `comparator`,
`threshold`, `parameters`, `last_triggered_at`).

`alerts` is schema-complete ahead of the evaluation engine (Phase 11).
