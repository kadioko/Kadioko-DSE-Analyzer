# Deploying to Vercel

The application already runs on Railway, which also hosts the database. This
describes running the **web application** on Vercel instead, with the database
staying on Railway. That split is normal and works; what follows is what to
watch.

---

## One-time setup

### 1. Sign in to the CLI

The CLI is already at the current version. Authentication is interactive, so run
this yourself — it opens a browser:

```bash
npx vercel login
```

Alternatively, create a token at <https://vercel.com/account/tokens> and put it
in your environment as `VERCEL_TOKEN`. Do not paste a token into a chat window
or commit it.

### 2. Link the project

```bash
npx vercel link
```

### 3. Set the environment variables

`DATABASE_URL` must be the Railway Postgres **public** URL — Vercel cannot
resolve `postgres.railway.internal`, which only exists inside Railway's network.
Copy the values from Railway → Postgres → Variables and Railway → your web
service → Variables.

```bash
npx vercel env add DATABASE_URL production
npx vercel env add ADMIN_EMAIL production
npx vercel env add ADMIN_TOKEN production
npx vercel env add CRON_SECRET production
npx vercel env add DATA_PROVIDER production      # csv
```

Each command prompts for the value, so nothing is written to your shell history.

### 4. Deploy

```bash
npx vercel --prod
```

---

## What changes on Vercel, and why

### Database connections

Every concurrent invocation is its own process with its own connection pool, so
a per-process maximum of ten is really ten multiplied by however many instances
Vercel decides to run — which exhausts the database's connection limit under
exactly the load it is supposed to survive.

`src/lib/db/client.ts` detects the platform and uses **one connection per
instance** with a shorter idle timeout, because a frozen instance still holds a
socket the database counts. Nothing needs configuring.

### Function duration

Three routes do real work and declare `maxDuration: 300`:

| Route | Why it is slow |
| --- | --- |
| `/api/admin/import` | Parses, validates, stores, then rebuilds analytics, valuations and rankings |
| `/api/admin/rankings/recalculate` | The same chain, for every date held |
| `/api/cron/ingest` | Ingestion plus the whole derived chain |

**These need a plan that allows 300-second functions.** On a plan capped at 60
seconds, a single-day import is usually fine and a full recalculate across every
date is not — it will be cut off partway. Nothing is corrupted if that happens,
because each date's rebuild is idempotent and can simply be re-run, but the
request will return an error rather than a result.

The Railway deployment has no such limit, which is a reason to keep it.

### The file-drop provider stops working

`CsvProvider` reads end-of-day files from `INGEST_DIR`. Vercel's filesystem is
read-only and ephemeral, so there is no directory for files to land in. The
provider reports itself unhealthy rather than failing obscurely, and scheduled
runs report `SKIPPED`.

This costs nothing in practice: `npm run sync` uploads over HTTPS to
`/api/admin/import`, which never touches the filesystem. Point `KADIOKO_URL` at
whichever deployment you want to feed.

### The ingestion worker cannot run there

`workers/market-ingestion` is a long-lived process. Vercel has no equivalent, so
that path is Railway-only. It is not currently deployed anywhere, so nothing is
lost today.

---

## Running both deployments at once

They share one database, so both serve identical data and either can accept an
import. Two things to keep straight:

- **Secrets must match.** `ADMIN_TOKEN` and `CRON_SECRET` are read from each
  platform's own environment. If they differ, a session or a cron call that
  works against one is rejected by the other.
- **Only schedule ingestion in one place.** Running it on both is harmless —
  imports are idempotent and the second run reports every row as unchanged — but
  it doubles the load and makes the run log harder to read.

---

## Verifying a deployment

```bash
curl -s https://<your-deployment>/api/health
```

Expect `status: ok` and a `latestTradingDate`. `status: degraded` means the
application is running but the database is unreachable — usually
`DATABASE_URL` still pointing at the internal Railway host.
