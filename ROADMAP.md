# Kadioko DSE Analyzer — Roadmap

Status legend: ✅ done · 🚧 in progress · ⬜ not started

Each phase ends with `npm run verify` (typecheck + lint + test) passing and the
README updated. A phase is not marked done while any of those fail.

---

## Phase 1 — Foundation ✅

Repository, Next.js 16 app, Railway PostgreSQL schema, migrations.

- ✅ Next.js 16 / React 19 / TypeScript / Tailwind 4 scaffold
- ✅ ESLint, Vitest, `npm run verify` pipeline
- ✅ `server-only` boundary for env and database access
- ✅ Drizzle schema — 16 tables:
  `instruments`, `market_daily`, `analytics_daily`, `market_daily_summary`,
  `fundamentals`, `valuations`, `corporate_actions`, `ingestion_sources`,
  `ingestion_runs`, `ingestion_errors`, `raw_market_payloads`, `scoring_models`,
  `users`, `watchlists`, `watchlist_items`, `alerts`
- ✅ Generated SQL migration `drizzle/0000_initial_schema.sql`
- ✅ Idempotency constraints — `(instrument_id, trading_date)` on `market_daily`,
  `(instrument_id, trading_date, model_version)` on `analytics_daily`
- ✅ Indexes for market-table, stock-history and report lookups
- ✅ NUMERIC money columns with an explicit JS conversion boundary (`src/lib/db/num.ts`)
- ✅ `.env.example`, migration runner

## Phase 2 — Instrument master 🚧

- 🚧 Seed script for DSE instruments, ingestion sources and scoring models
- ⬜ Instrument admin (add / edit / deactivate, shares outstanding maintenance)

## Phase 3 — CSV ingestion and validation 🚧

- ✅ CSV parser with column-alias mapping, day-first date handling, CSV-injection
  guards, file and row limits
- ✅ Data-quality rule set (negative values, impossible high/low, close outside
  range, unknown symbol, malformed date, market-cap anomaly, extreme move,
  turnover/volume inconsistency, weekend date, …)
- 🚧 Idempotent upsert pipeline with ingestion-run and ingestion-error recording
- ⬜ `/admin/data` upload → preview → approve workflow
- ⬜ Raw payload retention

## Phase 4 — Core analytics ✅ (engine) / 🚧 (persistence)

- ✅ `analytics/bo.ts` — ratio with explicit `NORMAL` / `NO_BID` / `NO_OFFER` /
  `EMPTY_BOOK` states, TZS book values, depth as % of market cap
- ✅ `analytics/momentum.ts` — B/O momentum vs trailing average with a minimum
  observation requirement, returns, realised volatility
- ✅ `analytics/liquidity.ts` — volume mean/median, volume ratio, turnover ratio,
  average deal size, liquidity percentile, weighted liquidity score
- ✅ `analytics/pressure.ts` — 0–100 Market Pressure with six exposed components
- ✅ `analytics/opportunity.ts` — separate composite score; missing pillars are
  excluded and reported, never imputed
- ✅ `analytics/confidence.ts` — 0–100 confidence from named penalties
- ✅ `analytics/market.ts` — breadth, market B/O, market pressure
- 🚧 Persistence into `analytics_daily` and `market_daily_summary`
- 🚧 Fixture tests (CRDB B/O ≈ 3.14, NMB, market B/O ≈ 0.87)

## Phase 5 — Dashboard and market table ⬜

- ⬜ Terminal-style dark-navy theme and layout shell
- ⬜ `/` — market totals, movers, most active, demand/supply extremes, momentum
  leaders, unusual volume
- ⬜ `/market` — full table with search, sort, sector filter, pagination, mobile layout

## Phase 6 — Stock detail ⬜

- ⬜ `/stocks/[symbol]` with Overview, Price, Order Book, Momentum, Fundamentals,
  Valuation, Dividends, Financials, Corporate Actions, Methodology tabs
- ⬜ Price / volume / turnover / bid-vs-offer / B/O / pressure charts
- ⬜ 1M · 3M · 6M · 1Y · 3Y · MAX ranges

## Phase 7 — Sentiment and momentum ⬜

- ⬜ `/sentiment` — market pressure dashboard and heatmap
- ⬜ `/momentum` — B/O acceleration and deterioration, unusual volume, momentum
  scanner. A "possible reversal" requires price/book disagreement **and** volume
  confirmation — never price action alone.

## Phase 8 — Comparison ⬜

- ⬜ `/compare` — any two securities across price, flow, book and fundamentals
- ⬜ Percentage-normalised return charts so differently priced shares are comparable

## Phase 9 — Reports ⬜

- ⬜ `/reports/daily/[date]`
- ⬜ `/reports/weekly/[year]/[week]` (ISO week)
- ⬜ `/reports/monthly/[year]/[month]`
- ⬜ SQL-side aggregation and report caching

## Phase 10 — Fundamentals ⬜

- ⬜ Fundamentals ingestion and admin entry, including banking-specific fields
  (NPL ratio, capital adequacy, cost/income, loan-to-deposit)
- ⬜ Valuation derivation (P/E, P/B, dividend yield, earnings yield, EV metrics)
- ⬜ Corporate actions timeline

## Phase 11 — Authentication and watchlists ⬜

- ⬜ Session auth, roles (`VIEWER` / `ANALYST` / `ADMIN`)
- ⬜ `/watchlist`
- ⬜ Alert definitions (schema already in place)

## Phase 12 — Automated data providers ⬜

- ⬜ `MarketDataProvider` implementations: `CsvProvider` (real),
  `DseOfficialProvider` and `ThirdPartyProvider` (declared, not faked — they
  report `healthy: false` until credentials and a specification exist)
- ⬜ Railway scheduled worker: fetch → validate → store → analytics → summary
- ⬜ Retry with backoff, run recording, duplicate prevention

## Phase 13 — AI explanation layer ⬜

- ⬜ Narration of computed values only. The AI receives a fixed fact block and
  may not introduce a number that is not in it, invent fundamentals, or invent
  market news.

## Phase 14 — Testing, security, performance ⬜

- ⬜ Unit, analytics, ingestion, database, API and critical UI tests
- ⬜ Rate limiting, admin authorisation, security headers (headers already set)
- ⬜ Query plans, report caching, lazy chart loading

## Phase 15 — Production polish ⬜

- ⬜ English / Kiswahili internationalisation
- ⬜ `/methodology` published from the live scoring config
- ⬜ `GET /api/export/daily?date=YYYY-MM-DD` and historical CSV export for the
  Kadioko DSE Sheet
- ⬜ Backups, retention, monitoring

---

## Deliberately deferred

| Item | Reason |
| --- | --- |
| Licensed real-time / delayed DSE feed | Requires a data licence. The adapter interface is built; the implementation waits on a specification and credentials. Nothing will be stubbed to look functional. |
| Intraday data | The database is EOD-shaped. Intraday needs a separate tick table and is out of scope until a feed exists. |
| Portfolio tracking | Adjacent product. Watchlists first. |

## Relationship with the Kadioko DSE Sheet

The Sheet is intended to become a **consumer** of this platform rather than
maintaining an independent market database:

```
Railway PostgreSQL → Kadioko API → ┬→ Web app
                                   └→ Google Sheet
```

The export endpoints in Phase 15 are the interface for that.
