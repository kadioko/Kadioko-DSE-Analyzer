# Railway setup

The database is **Railway PostgreSQL** regardless of where the frontend is
deployed.

---

## 1. Create the project

1. Sign in at [railway.app](https://railway.app)
2. **New Project** → **Empty Project**
3. Name it `kadioko-dse-analyzer`

## 2. Provision PostgreSQL

1. In the project: **+ New** → **Database** → **Add PostgreSQL**
2. Wait for the service to finish deploying

## 3. Obtain DATABASE_URL

Open the Postgres service → **Variables**. Two URLs are exposed:

| Variable | Use |
| --- | --- |
| `DATABASE_URL` | internal — for services deployed **inside** this Railway project |
| `DATABASE_PUBLIC_URL` | external — for local development and Vercel |

Copy the appropriate one into your `.env`:

```
DATABASE_URL=postgresql://postgres:<password>@<host>.proxy.rlwy.net:<port>/railway
```

The public proxy terminates TLS, so `ssl: 'require'` is set automatically for
any non-localhost URL (`src/lib/db/client.ts`).

## 4. Environment variables

For the **web service**:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | reference the Postgres service: `${{Postgres.DATABASE_URL}}` |
| `ADMIN_EMAIL` | yes | comma-separated allowlist for `/admin/*` |
| `CRON_SECRET` | yes | bearer token for the scheduled ingestion endpoint |
| `DATA_PROVIDER` | yes | `csv` until a licensed feed is in place |
| `DSE_API_URL` / `DSE_API_KEY` | no | licensed feed, when available |
| `AI_API_KEY` / `AI_MODEL` | no | AI explanation layer |
| `ENABLE_DEV_PARSERS` | no | leave unset in production; hard-disabled anyway |

Generate `CRON_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use Railway's `${{Postgres.DATABASE_URL}}` reference syntax rather than pasting
the connection string, so credential rotation propagates automatically.

## 5. Run migrations

Locally, against the public URL:

```bash
npm run db:migrate
```

Migrations are idempotent — Drizzle records applied migrations in
`drizzle.__drizzle_migrations` and skips them on subsequent runs.

To run inside Railway instead:

```bash
railway run npm run db:migrate
```

## 6. Seed instruments

```bash
npm run db:seed
```

This creates the DSE instrument master, the ingestion source records and the
scoring model registry. It creates **no market data** — market data only ever
enters through the ingestion pipeline.

## 7. Deploy the web service

**Option A — Railway**

1. **+ New** → **GitHub Repo** → select the repository
2. Railway detects Next.js and builds with `npm run build` / `npm start`
3. Add the environment variables from step 4
4. **Settings** → **Networking** → **Generate Domain**

**Option B — Vercel**

1. Import the repository at [vercel.com](https://vercel.com)
2. Add the same environment variables, using `DATABASE_PUBLIC_URL` as
   `DATABASE_URL`
3. Deploy

The database stays on Railway either way.

## 8. Deploy the ingestion worker

1. **+ New** → **GitHub Repo** → same repository
2. **Settings** → **Deploy** → set the start command:

```bash
npm run ingest
```

3. Add `DATABASE_URL` (internal reference), `DATA_PROVIDER=csv`, and
   `INGEST_DIR` pointing at a mounted volume

The CSV provider reads end-of-day files from `INGEST_DIR`. On Railway, attach a
**Volume** to the worker and set `INGEST_DIR` to its mount path, otherwise files
dropped into an ephemeral container filesystem disappear on redeploy.

The worker ingests today's session in East Africa Time by default. To backfill:

```bash
railway run npm run ingest -- --from=2026-06-01 --to=2026-08-14
```

## 9. Configure the scheduled job

On the worker service: **Settings** → **Cron Schedule**.

The DSE closes at 16:00 EAT (UTC+3). Railway cron runs in UTC, so 17:30 EAT is
`30 14`:

```
30 14 * * 1-5
```

Weekdays only. The worker is idempotent: a re-run for a date already imported
updates the same rows via the `(instrument_id, trading_date)` unique constraint
and records a new `ingestion_runs` entry.

Alternatively, trigger the HTTP endpoint from any scheduler:

```bash
curl -X POST https://<your-domain>/api/ingest/scheduled \
  -H "Authorization: Bearer $CRON_SECRET"
```

## 10. Verify

```bash
railway run node -e "const p=require('postgres');const s=p(process.env.DATABASE_URL,{ssl:'require'});s\`select count(*) from instruments\`.then(r=>{console.log(r);return s.end()})"
```

Or open `/api/health`:

```json
{ "status": "ok",
  "database": { "configured": true, "reachable": true, "latencyMs": 7 },
  "data": { "latestTradingDate": "2026-08-14" },
  "features": { "adminRoutes": true, "scheduledIngestion": true } }
```

`status` is one of `ok`, `degraded` or `not_configured`. It is unauthenticated,
so it never returns the connection string, the host, or driver error text — a
database failure reports *that* it failed, not why. The detail is logged
server-side and shown to a signed-in administrator on `/admin/data`.

It always returns HTTP 200, including when degraded. A platform health check
that flaps to 503 on a transient database blip would restart a container that is
otherwise serving fine, so **alert on the `status` field, not the HTTP code**.

`features` tells you at a glance whether `ADMIN_EMAIL`/`ADMIN_TOKEN` and
`CRON_SECRET` are actually set, without revealing their values. If
`adminRoutes` is `false` you will not be able to sign in to import data.

### Config as code

`railway.json` at the repo root sets the web service's build command, start
command and healthcheck automatically, so the Web service needs no manual
build configuration.

For the **worker** service, Railway reads `railway.json` by default too, which
is the wrong config for it. Point it at the worker file instead:
**Settings → Config-as-code → path** = `railway.worker.json`. Without that
step the worker will try to run the web server.

## 11. Backups and retention

Railway PostgreSQL takes automatic daily snapshots on paid plans. Configure
retention under the Postgres service → **Backups**.

Recommended additions for a financial dataset:

- **Weekly logical dump** to off-platform storage:

```bash
pg_dump "$DATABASE_PUBLIC_URL" --format=custom --file=kadioko-$(date +%F).dump
```

- **Retain `raw_market_payloads`** — it is the audit trail that allows every
  derived number to be traced back to the bytes that produced it. Derived tables
  (`analytics_daily`, `market_daily_summary`, `valuations`) are reproducible
  from raw data and need no separate retention policy.
- **Restore drill** at least once before going live. An untested backup is not a
  backup.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ECONNREFUSED` locally | using the internal `DATABASE_URL`; switch to `DATABASE_PUBLIC_URL` |
| `self signed certificate` | `ssl: 'require'` is set for non-localhost URLs — check the URL is not `localhost` |
| `relation "instruments" does not exist` | migrations not applied — run `npm run db:migrate` |
| `Invalid environment configuration` | a required variable is missing; the error lists exactly which |
| Slow first query | Railway proxy cold start; the pool warms after one request |
