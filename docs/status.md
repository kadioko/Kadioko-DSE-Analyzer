# Project status

Last updated: 24 August 2026

A single place to see what is deployed, what it is serving, and what is left.
For phase-by-phase detail see [ROADMAP.md](../ROADMAP.md).

---

## Live deployment

| | |
| --- | --- |
| **URL** | <https://kadioko-dse-analyzer-production.up.railway.app> |
| Health | `/api/health` — `status: ok` |
| Railway project | Kadioko DSE analyzer · environment `production` |
| Web service | `Kadioko-DSE-Analyzer` |
| Database | `Postgres` (Railway, with volume) |
| Admin email | `godfreymariki@gmail.com` |

### Environment variables set on the web service

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Railway reference to the Postgres service, so credential rotation propagates |
| `ADMIN_EMAIL` | `godfreymariki@gmail.com` |
| `ADMIN_TOKEN` | 64-character generated secret — **read it in Railway → Variables**, it is deliberately never printed anywhere |
| `CRON_SECRET` | 64-character generated secret, separate from `ADMIN_TOKEN` so a compromised scheduler cannot reach admin routes |
| `DATA_PROVIDER` | `csv` |

### Database contents

| | |
| --- | --- |
| Migrations | 4 applied |
| Instruments | 30 |
| Ingestion sources | 3 (one usable, two declared-only) |
| Scoring models | 4 |
| Market observations | 146 of 148 rows, 5 sessions (2026-08-10 → 08-14) |
| Financial periods | 54 rows → 23 fundamental scores |
| Ranking snapshots | 5, one per session |

**The 2 rejected rows are correct, not a failure.** JATU on 2026-08-12 and SWIS
on 2026-08-14 both report a close outside their own high/low, with high equal to
low. Those rows are inconsistent at source and are recorded in
`ingestion_errors` with the reason.

### Live ranking, 14 Aug 2026

```
#1  DSE        F 75.5   S 68.4   O 73.4   NZURI SANA
#2  NICO       F 70.3   S 80.2   O 73.2   NZURI SANA
#3  KCB        F 68.8   S 44.9   O 61.6   NZURI
#4  AFRIPRISE  F 70.5   S 35.5   O 60.0   NZURI
#5  MKCB       F 72.0   S 25.0   O 57.9   WASTANI
```

12 of 30 securities ranked. The other 18 are listed with an exclusion reason
rather than dropped, so the table never presents a partial market as the whole
one.

---

## How to operate it

### Sign in
`/admin/data` with the admin email and the `ADMIN_TOKEN` from Railway.

### Add market data
Either upload a CSV at `/admin/data`, or drop dated files into `data/incoming/`
and run:

```bash
npm run ingest -- --from=2026-08-10 --to=2026-08-14
```

To load into Railway rather than a local database, prefix that command with the
Postgres service's `DATABASE_PUBLIC_URL`.

### Add financial results or corporate actions
`/admin/data`, selecting kind `fundamentals` or `corporate_actions`.

### Rebuild derived data
`POST /api/admin/rankings/recalculate` with `{"all": true}`. This runs the whole
chain in dependency order: fundamentals → valuations → analytics → ranking.

---

## What is left

### Blocked on something other than code

| Item | Blocker |
| --- | --- |
| **Historical market data** | DSE Market Data Policy s.16 makes anything older than 24 hours a paid, order-form-gated product, and forbids redistribution without a further licence. Email `data@dse.co.tz` for the Market Data Evaluation Form. The backfill command is built and tested; it needs a licensed file. |
| **Dividend yield** | No dividend-per-share data exists in any source held. The pipeline is verified end to end; it needs data. |
| **Cross-listed valuations** | EABL, KCB, KA, NMG, JHL, USL report in KES and trade in TZS. Any per-share multiple mixing the two is wrong by the exchange rate. Needs a TZS/KES series, which is a decision rather than a code gap. |
| **Backtesting** | Needs forward returns. With 5 sessions there is no 1-month return to test against, so the harness would honestly report insufficient history for every metric. |

### Buildable now

| Priority | Item | Why it matters |
| --- | --- | --- |
| High | Statement units declared at source | Normalisation infers them today. A `reporting_scale` column in the source file would remove the inference entirely. |
| High | API and UI tests | 270 tests cover analytics, ingestion, ranking and the database. No test covers an HTTP route or a rendered page. |
| Medium | Instrument admin UI | Adding or deactivating a security still means editing `data/instruments.seed.csv` and re-seeding. |
| Medium | Authentication and watchlists | `users`, `watchlists` and `alerts` tables exist and are unused. Admin token is the only auth. |
| Medium | Alert evaluation | Schema is in place; nothing evaluates it. |
| Low | AI narration | `AI_API_KEY` is unused. The layer would narrate computed values only, never introduce a number. |
| Low | English / Kiswahili i18n | Ranking carries Kiswahili strings; the rest of the UI is English-only, with no i18n framework. |
| Low | Report caching | Reports recompute per request. Fine at this size. |

### Housekeeping

- **`railway.json` is deprecated.** Railway now prefers `.railway/railway.ts`.
  Existing files keep working until **2026-12-01**. Migrate with
  `railway config migrate`.
- **The ingestion worker is not deployed.** Daily automation needs its own
  Railway service, a Volume for `INGEST_DIR`, and its config path pointed at
  `railway.worker.json` — otherwise Railway reads `railway.json` and the worker
  starts a web server instead.
- **Backups.** Railway snapshots daily on paid plans. A restore has not been
  drill-tested, and an untested backup is not a backup.

---

## Why the site shows so many dashes

With 5 sessions of data, every metric needing a 20-day window is unavailable:
volume ratio, 20-day return, realised volatility. That cascades — those feed the
Opportunity score's momentum and risk pillars, so 18 of 30 securities fall below
the coverage threshold and are excluded.

This is the platform working as designed. A dash means *we do not have this*,
never *this is zero*. Loading three to six months of licensed history would
resolve most of it with no code change.

---

## Verification state

| Check | Result |
| --- | --- |
| `npm run verify` | 270 tests, typecheck and lint clean |
| Production build | Clean |
| CI | GitHub Actions runs typecheck, lint, the full suite against a real PostgreSQL service, the build, and a worker smoke test |
| Deployed routes | 8 pages and the ranking APIs return 200 against live data |

**The ranking model has not been backtested.** Snapshots are stored so that
score-versus-future-return, rank stability and top-decile performance can be
evaluated later. Until that work is done, no claim is made that the ranking
predicts anything. It is a transparent ordering under a stated model, and it is
not investment advice.
