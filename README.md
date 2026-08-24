# Kadioko DSE Analyzer

Equity analytics platform for securities listed on the **Dar es Salaam Stock Exchange (DSE)**.

It maintains a historical DSE market database, ingests new observations, derives
transparent quantitative metrics from them, and presents market, security and
report views on top. It is a financial-data platform, not a web rendering of a
spreadsheet.

> **Status:** under active construction. See [ROADMAP.md](ROADMAP.md) for what is
> built, what is in progress and what is planned. Nothing in this repository
> should be treated as production-ready until the roadmap says so and the test
> suite is green.

---

## What it does

| Capability | Description |
| --- | --- |
| Historical market data | One immutable observation per instrument per trading date, in PostgreSQL |
| Ingestion | Adapter-based. CSV importer first; licensed feeds are the production target |
| Validation | 20+ named data-quality rules; rejected rows are stored with reasons |
| Order-book analytics | Bid/offer ratio, B/O momentum, depth normalised by market capitalisation |
| Flow analytics | Volume ratios, medians, turnover ratio, average deal size, liquidity percentile |
| Market Pressure | Transparent 0–100 order-book imbalance score with every component exposed |
| Opportunity Score | Separate composite investment-context score; missing pillars are excluded, never invented |
| Data Confidence | Every investment-oriented score carries a 0–100 confidence with named penalties |
| Reports | Daily, ISO-weekly and calendar-monthly market reports built from SQL aggregation |
| Export | API and CSV export so the Kadioko DSE Sheet can consume this database |

---

## Non-negotiable rules this codebase follows

These are enforced in code, not just documented.

1. **DSE data is never fabricated.** No placeholder prices, no demo securities in
   production paths, no synthetic history.
2. **Missing data is never silently substituted.** A value that cannot be
   computed is `null`, and the reason is returned alongside it.
3. **AI never performs calculations.** The quantitative engine produces the
   numbers; the AI layer only narrates numbers it was handed.
4. **Order-book pressure is not a buy signal.** Market Pressure and Opportunity
   Score are separate, differently weighted, and displayed separately.
5. **No instrument-specific logic.** There is no branch anywhere keyed on a
   ticker symbol. CRDB and NMB appear only in test fixtures.
6. **Database credentials never reach the client.** `src/lib/env.ts` and
   `src/lib/db/client.ts` are `server-only`; importing them from a client
   component is a build error.
7. **Unauthorised scraping is not the architecture.** A development-only parser
   may exist behind `ENABLE_DEV_PARSERS`, hard-disabled in production. Licensed
   feeds are the production target.
8. **Scoring formulas are public.** Every weight and threshold lives in
   [`src/lib/analytics/config.ts`](src/lib/analytics/config.ts) and is published
   verbatim on `/methodology`.
9. **Raw and derived data are separate tables.** `market_daily` is what a source
   reported. `analytics_daily`, `valuations` and `market_daily_summary` are
   derived, versioned and reproducible.
10. **No production-readiness claim while tests fail.**

---

## Technology

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS 4** + shadcn-style primitives
- **Drizzle ORM 0.45** with real SQL migrations
- **PostgreSQL on Railway** (the permanent database, regardless of where the
  frontend is deployed)
- **Zod 4** for every external input boundary
- **Recharts** for charting
- **Vitest** for unit, analytics and ingestion tests

### Why a single app instead of `/apps` + `/packages`

The brief sketched a monorepo. This repository implements the same boundaries
without the monorepo tooling:

| Sketched package | Implemented as |
| --- | --- |
| `packages/database` | `src/lib/db/` |
| `packages/analytics` | `src/lib/analytics/` |
| `packages/types` | `src/lib/types/` |
| `packages/validation` | `src/lib/validation/` |
| `apps/web` | `src/app/` |
| `workers/market-ingestion` | `workers/market-ingestion/` |

There is one deployable unit and one dependency graph, so npm workspaces would
add build complexity and cross-package version drift without buying isolation
that anything here needs. The module boundaries are what matter, and they are
real: the analytics engine imports nothing from `src/app/`, and the database
layer imports nothing from React. If a second deployable ever appears, the
directories lift into packages unchanged.

---

## Getting started

**Never used this before? Do not open a terminal.**

| Your computer | Double-click this file |
| --- | --- |
| Windows | **`START-HERE.bat`** |
| macOS | **`start-here.command`** |
| Linux | **`start-here.command`** (choose *Run in Terminal*) |

It checks whether Node.js is installed and sends you to the download page if
not, then prepares everything and tells you what to do next. Plain-language
walkthrough: **[QUICKSTART.md](QUICKSTART.md)**.

If you are comfortable with a terminal, the same thing is:

```bash
npm run setup
```

It writes a `.env` with freshly generated secrets, creates the database tables
and loads the securities list. It never overwrites an existing `.env`.

The manual route follows.

### 1. Install

```bash
npm install
```

### 2. Provision Railway PostgreSQL

Full instructions: [docs/railway.md](docs/railway.md). In short:

1. Create a Railway project
2. Add a **PostgreSQL** service
3. Copy `DATABASE_URL` from the service's Variables tab (public URL for local dev)

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in `DATABASE_URL` at minimum. Never commit `.env`.

### 4. Migrate and seed

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

The seed creates the DSE instrument master and the ingestion source records. It
creates **no market data** — market data only ever enters through ingestion.

### 5. Run

```bash
npm run dev
```

---

## Importing market data

1. Go to `/admin/data` (requires an email in `ADMIN_EMAIL`)
2. Upload a DSE end-of-day CSV
3. Review the **preview**: accepted rows, rejected rows with reasons, warnings
4. Approve the import
5. Analytics and the market summary are recalculated for the affected dates

Imports are **idempotent**: re-uploading the same file updates the same rows via
the `(instrument_id, trading_date)` unique constraint and never duplicates.

Recognised CSV columns (spelling variants are mapped automatically — see
[`src/lib/ingestion/parse.ts`](src/lib/ingestion/parse.ts)):

```
Date, Symbol, Company, Open, Previous Close, Close, High, Low, Change,
Turnover, Deals, Outstanding Bid, Outstanding Offer, Volume, Market Cap
```

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run setup` | **One-command setup for a new machine** |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm run test` | Vitest suite |
| `npm run verify` | typecheck + lint + test |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Seed instruments, sources and scoring models |
| `npm run ingest` | Run the ingestion worker (`-- --date=` / `--from= --to=`) |

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | System design, data flow, module boundaries |
| [docs/methodology.md](docs/methodology.md) | Every formula, weight and threshold |
| [docs/data-dictionary.md](docs/data-dictionary.md) | Every table and column |
| [docs/ingestion.md](docs/ingestion.md) | Import workflow, validation rules, provider contract |
| [docs/railway.md](docs/railway.md) | Railway setup, deployment, scheduled jobs, backups |
| [QUICKSTART.md](QUICKSTART.md) | Plain-language setup, no prior knowledge assumed |
| [ROADMAP.md](ROADMAP.md) | Build phases and current status |

---

## Data sourcing and licensing

**The DSE charges for historical market data.** Its published Market Data
Policy (section 16) defines anything older than 24 hours as Historical Data and
requires a one-off fee plus a completed order form sent to `data@dse.co.tz`.
Redistribution needs a further licence. Bulk-harvesting it from the website is
against those terms even though `robots.txt` permits crawling — the absence of a
technical block is not a licence. Full detail and the supported route:
[docs/ingestion.md](docs/ingestion.md#data-licensing-what-the-dse-actually-permits).

This platform is built to consume **authorised** market data. The provider
interface (`MarketDataProvider`) exists so that the CSV importer used during
development can be replaced by a licensed DSE feed without touching the
analytics engine, the database or the UI.

Provider status today:

| Provider | State |
| --- | --- |
| `csv` | **Implemented.** Watches `INGEST_DIR`; drives the worker and the cron endpoint. |
| `dse_official` | Declared only. Reports unhealthy and refuses to fetch until a licence and endpoint specification exist. |
| `third_party` | Declared only. Awaiting vendor selection. |

The unimplemented providers are not stubbed with plausible-looking data. A feed
that appears to work while returning fiction is the worst failure this project
could have, so they state their true condition instead.

A development-only parser may be enabled with `ENABLE_DEV_PARSERS=true`, and is
hard-disabled when `NODE_ENV=production`. It exists for local testing only and
must not be relied on commercially. Obtaining an appropriate data licence from
the DSE is a prerequisite for production operation.

---

## Licence

Not yet determined. All rights reserved pending a decision.
