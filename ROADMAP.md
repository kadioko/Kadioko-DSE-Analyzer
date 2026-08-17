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

## Phase 2 — Instrument master ✅

- ✅ Seed script for DSE instruments, ingestion sources and scoring models,
  reading `data/instruments.seed.csv`. Creates **no** market data.
- ✅ Instrument repository (upsert by symbol, shares-outstanding maintenance,
  sector listing). Re-running the seed never deletes or deactivates.
- ⬜ Instrument admin UI (add / edit / deactivate)

## Phase 3 — CSV ingestion and validation ✅

- ✅ CSV parser with column-alias mapping, day-first date handling, CSV-injection
  guards, file and row limits
- ✅ Data-quality rule set (negative values, impossible high/low, close outside
  range, unknown symbol, malformed date, market-cap anomaly, extreme move,
  turnover/volume inconsistency, weekend date, …)
- ✅ Idempotent upsert reporting inserted / updated / **unchanged** separately
- ✅ In-file duplicate detection — a repeated symbol/date is rejected rather than
  letting the second row silently overwrite the first
- ✅ Ingestion runs, per-row errors with raw content, raw payload retention
- ✅ `/admin/data` upload → preview → approve workflow; preview writes nothing
- ✅ `/admin/runs/[runId]` error inspector, grouped by rule
- ✅ Admin authorisation: HMAC-signed httpOnly session, allowlist re-checked per
  request, rate-limited sign-in, no client-side authorisation checks anywhere

## Phase 4 — Core analytics ✅

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
- ✅ `analytics/pipeline.ts` — persistence into `analytics_daily` and
  `market_daily_summary`, re-runnable and versioned
- ✅ Fixture tests (CRDB B/O ≈ 3.14, NMB, market B/O ≈ 0.87)
- ✅ 109 unit tests covering analytics, parsing and validation
- ✅ Database integration tests executed against PostgreSQL 17: idempotent
  upsert, exact NUMERIC round-trip, constraint enforcement, pipeline re-runs

## Phase 5 — Dashboard and market table ✅

- ✅ Terminal-style dark-navy theme, layout shell, tabular figures
- ✅ `/` — market totals, pressure with components, movers, most active,
  demand/supply extremes, momentum leaders, unusual volume
- ✅ `/market` — search, sort, sector filter, traded-only, pagination.
  Unavailable values sort last in both directions rather than ranking as zero.
- ✅ First-run setup screen when `DATABASE_URL` is absent, instead of an
  unhandled configuration error

## Phase 6 — Stock detail ✅

- ✅ `/stocks/[symbol]` with Overview, Price, Order Book, Momentum, Fundamentals,
  Valuation, Dividends, Corporate Actions and Methodology tabs
- ✅ Price / volume / turnover / bid-vs-offer / B/O ratio / B/O momentum /
  pressure charts. `connectNulls` is off everywhere, so a gap reads as a gap.
- ✅ 1M · 3M · 6M · 1Y · 3Y · MAX ranges
- ✅ Per-security Methodology tab showing that security's actual component
  contributions and confidence penalties
- ✅ Tabs without a data source say so and state what it costs the scores

## Phase 7 — Sentiment and momentum ✅

- ✅ `/sentiment` — market pressure dashboard, band distribution and counter heatmap
- ✅ `/momentum` — B/O acceleration and deterioration, unusual volume, momentum
  scanner. Each group prints its rule above its matches and the triggering
  values beside each match. A "possible reversal" requires price/book
  disagreement **and** volume confirmation — never price action alone.

## Phase 8 — Comparison ✅

- ✅ `/compare` — any two securities across price, flow, book and scores
- ✅ Returns rebased to 0% at the first session both series SHARE, so differently
  priced shares stay comparable and neither is flattered by an earlier start

## Phase 9 — Reports ✅

- ✅ `/reports/daily/[date]`
- ✅ `/reports/weekly/[year]/[week]` (ISO week, Monday start)
- ✅ `/reports/monthly/[year]/[month]`
- ✅ SQL-side aggregation on NUMERIC; one shared view component so the three
  reports cannot drift apart
- ⬜ Report caching

## Phase 10 — Fundamentals ✅ (scoring) / 🚧 (valuation)

- ✅ Financial-results CSV import (`kind=fundamentals`), separate from the
  market pipeline because the two need different validation
- ✅ `analytics/fundamental.ts` — 0–100 business-quality score with a general
  model and a banking model, selected by the DATA (presence of NPL / capital
  adequacy / cost-income figures), never by sector label or ticker
- ✅ `fundamental_scores` table, versioned by methodology
- ✅ `analytics/valuation.ts` + `valuations` table — P/E, P/B, earnings yield,
  price/sales, enterprise value. Interim earnings are annualised by the issuer
  reporting cadence and LABELLED as annualised. Negative earnings or book value
  produce no multiple rather than a flattering one.
- ✅ EPS and book value per share derived from reported totals and the share
  count where the issuer published no per-share figure
- ✅ Plausibility bounds: a multiple far outside any credible range is withheld
  as a suspected unit mismatch rather than published. Nothing is silently
  rescaled.
- ✅ Reporting-scale normalisation (`analytics/units.ts`). DSE issuers file in
  inconsistent units; ratios are immune but per-share figures are not. A scale
  is accepted only when exactly one candidate is plausible, tested primarily
  against book value. Declared scales always win. Ambiguous or implausible
  evidence leaves figures exactly as reported.
- ✅ Cross-listed issuers report in a foreign currency, so scale inference would
  absorb the exchange rate. Inference is skipped and multiples are withheld with
  `REPORTING_CURRENCY_MISMATCH` rather than computed against a TZS price.
- ✅ Growth is refused across a reporting-scale change, which would otherwise
  read as ~99,900% growth.
- ✅ Corporate-actions import (`kind=corporate_actions`): dividends, splits,
  bonus and rights issues, AGMs, suspensions. A dividend without an amount is
  rejected rather than recorded as a zero payment.
- ✅ Dividend yield from dividends DECLARED in the trailing twelve months, not
  from annualising a single interim payment. A company that declared one
  interim dividend has not committed to a second.
- ✅ Corporate-action timeline on the stock page, with ex-date and payment date
- ⬜ **No dividend data exists in any current source**, so the pillar is still
  excluded in practice. The pipeline is verified end to end; it needs data.

## Ranking engine ✅

- ✅ `ranking_models`, `fundamental_scores`, `ranking_snapshots`,
  `ranking_entries` + migration `0001_ranking_engine.sql`
- ✅ `analytics/ranking.ts` — Overall = Fundamental × 0.70 + Sentiment × 0.30,
  grades, market-demand bands, five interpretation rules, eligibility, sorting
  with full tie-breaking, rank movement
- ✅ Sentiment is the EXISTING market-pressure score, reused not recomputed
- ✅ No look-ahead: a ranking may only use results whose period ended and which
  were published on or before the ranking date
- ✅ `/rankings` with hero, research-terminal table, mobile cards, filters,
  historical date selector served from stored snapshots
- ✅ `/api/rankings`, `/api/rankings/latest`, `/api/rankings/[symbol]`,
  `/api/rankings/[symbol]/history`, `POST /api/admin/rankings/recalculate`,
  `/api/export/rankings`
- ✅ Ranking section on the stock page, top-5 on the dashboard
- ✅ Ranking refreshes automatically after market ingestion and after new
  financial results are imported
- ✅ 81 ranking unit tests, including all supplied fixtures
- ⬜ Backtesting. Snapshots are stored so score-versus-future-return, rank
  stability and top-decile performance can be evaluated later. **No claim is
  made that this model predicts anything until that work is done.**

## Phase 11 — Authentication and watchlists ⬜

- ⬜ Session auth, roles (`VIEWER` / `ANALYST` / `ADMIN`)
- ⬜ `/watchlist`
- ⬜ Alert definitions (schema already in place)

## Phase 12 — Automated data providers ✅

- ✅ `CsvProvider` — watches `INGEST_DIR`, matches a file to a session by ISO or
  compact date, most recent modification wins
- ✅ `DseOfficialProvider` / `ThirdPartyProvider` — declared, NOT faked. They
  throw on fetch and report `healthy: false` with the reason.
- ✅ `workers/market-ingestion` — `npm run ingest`, with `--date`, `--from/--to`
  backfill, `--provider` and retry flags. Exits non-zero on failure.
- ✅ `POST /api/cron/ingest` authorised by `CRON_SECRET`, separate from
  `ADMIN_TOKEN` so a compromised scheduler cannot reach admin surfaces
- ✅ Retry with linear backoff for transient failures only; a validation failure
  is returned immediately rather than retried
- ✅ East Africa Time session dates, weekend skip reported as `SKIPPED`
- ✅ Same data-quality rules as manual upload; full run and error recording

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
