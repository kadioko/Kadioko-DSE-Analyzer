# Project status

Last updated: 24 August 2026 (evening)

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
| Migrations | 5 applied |
| Instruments | 30 |
| Ingestion sources | 3 (one usable, two declared-only) |
| Scoring models | 4 |
| Market observations | 174 rows, 6 sessions (2026-08-10 → 08-14, and 08-24) |
| Financial periods | 54 rows → 23 fundamental scores |
| Ranking snapshots | 5, one per session |

**There is a hole in the series: 17–21 August is missing.** The 24 August
session was taken from the exchange's own published board, which is same-day
data and therefore not Historical Data under the Market Data Policy. The
sessions in between are older than 24 hours and so are the licensed product;
they have been left alone. Reports for 19, 20 and 21 August are published and
would close the gap once a licence is in place.

**The 2 rejected rows are correct, not a failure.** JATU on 2026-08-12 and SWIS
on 2026-08-14 both report a close outside their own high/low, with high equal to
low. Those rows are inconsistent at source and are recorded in
`ingestion_errors` with the reason.

### Two findings from the 24 August load

**NMB has been rebased, and the platform refuses to guess by how much.** Its
close moved from 17,700 on 14 August to 1,850 on 24 August, while the exchange's
own market capitalisation for it stayed near 9 trillion TZS — which is only
consistent with roughly ten times the 500,000,000 shares outstanding we hold. A
ten-for-one split fits every number, but no announcement confirms it, so no
corporate action has been recorded. The `MARKET_CAP_ANOMALY` warning fired and
says exactly this. **This needs confirming with the exchange or NMB's registrar
before any per-share history spanning the two dates can be trusted.**

**A gap in stored history was being published as a one-day move.** Returns were
computed from the previous stored *row*, with no notion of the calendar, so with
17–21 August absent the previous row was ten days old. NMB was shown as
−89.55% for a session in which it actually rose 4.52%. Returns and volatility
now take the session dates and withhold any window whose reference session is
too far back to be the session it claims to be. On 24 August all 28 one-day
returns are therefore withheld; 14 August is unaffected. The guard applies to
every future gap, not just this one.

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

## Keeping data current

Everything downstream of ingestion already runs itself. The step that needed a
person was moving a file from a computer to the deployed platform, and that is
now `npm run sync`.

| | |
| --- | --- |
| Daily, by hand | Save the file into `data/incoming/`, double-click **UPDATE-DATA.bat**, or run `npm run sync` |
| Daily, unattended | `npm run schedule` — weekdays at 18:00 EAT via Task Scheduler or `cron` |
| Check the schedule | `npm run schedule -- --status` |
| Re-send a corrected file | `npm run sync -- --all` |

Verified end to end against production: a re-sent 14 Aug file reported
`0 new, 29 unchanged, 1 rejected` — idempotent, and the known bad SWIS row still
correctly refused.

### A quiet day is not a failure

A session with no published file is recorded as `SKIPPED`, not `FAILED`. This
needed a new value in the `ingestion_status` enum (migration `0004`) and a
`NoDataAvailableError` the providers raise. The reason it matters: a scheduled
job that reports a fault every morning is a job whose alerts stop being read.
Real faults — an unreadable file, a missing directory, an unreachable database,
a rejected row — are still reported in full, and only those are retried.

### What is deliberately not automated

Nothing fetches from the DSE by itself. The Market Data Policy makes anything
older than 24 hours a licensed product, so obtaining the file remains a
deliberate human act. When a licence is in place, `DATA_PROVIDER=dse_official`
moves that last step inside the schedule with no other change — the provider
interface, the scheduler, the retry rules and the skip semantics are already
built and tested against it.

---

## What is left

### Blocked on something other than code

| Item | Blocker |
| --- | --- |
| **17–21 Aug 2026 sessions** | Published as daily market reports, but older than 24 hours and therefore the licensed Historical Data product. Loading them closes the gap and restores the withheld returns. |
| **NMB share count** | The exchange's market cap implies roughly ten times the shares outstanding on record, consistent with an unconfirmed split. Needs confirmation before per-share history spanning 14–24 August is meaningful. |
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
- **The ingestion worker is not deployed as a Railway service.** It is not
  needed for the current automation, which runs on the operator's machine and
  pushes over HTTPS. A Railway-side worker only becomes worthwhile with a
  licensed feed, since a server-side schedule has no files to read; it would
  then need its own service, a Volume for `INGEST_DIR`, and its config path
  pointed at `railway.worker.json`.
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
| `npm run verify` | 282 tests, typecheck and lint clean |
| Production build | Clean |
| CI | GitHub Actions runs typecheck, lint, the full suite against a real PostgreSQL service, the build, and a worker smoke test |
| Deployed routes | 8 pages and the ranking APIs return 200 against live data |

**The ranking model has not been backtested.** Snapshots are stored so that
score-versus-future-return, rank stability and top-decile performance can be
evaluated later. Until that work is done, no claim is made that the ranking
predicts anything. It is a transparent ordering under a stated model, and it is
not investment advice.
