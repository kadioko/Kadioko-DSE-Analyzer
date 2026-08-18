# Quick start

For someone who has not used this project before. No prior knowledge assumed.

---

## What you need first

| | |
| --- | --- |
| **Node.js 20 or newer** | Free. Download the **LTS** version from [nodejs.org](https://nodejs.org) and install it. |
| **A PostgreSQL database** | Free tier is fine. Instructions below. |
| **DSE market data** | A CSV of end-of-day prices. See [Getting data](#getting-data). |

---

## Step 1 — Get a database

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project**, then **Add PostgreSQL**
3. Click the Postgres box, open the **Variables** tab
4. Copy the value of **`DATABASE_PUBLIC_URL`** — it starts with `postgresql://`

Keep that on your clipboard for the next step.

---

## Step 2 — Run setup

Open a terminal in this folder and run:

```bash
npm run setup
```

It checks your machine, creates a `.env` configuration file, generates your
passwords automatically, creates the database tables, and loads the list of
DSE-listed securities.

When it asks for `DATABASE_URL`, open the file named **`.env`** in this folder
and paste what you copied in Step 1 after `DATABASE_URL=`. Then run
`npm run setup` again.

Also set your own email in that file:

```
ADMIN_EMAIL=your.name@example.com
```

---

## Step 3 — Start it

```bash
npm run dev
```

Open **http://localhost:3000**

You will see **no market figures**. That is deliberate — the platform never
invents data. It only shows numbers that came from a file you imported.

---

## Step 4 — Put data in

1. Go to **http://localhost:3000/admin/data**
2. Sign in:
   - **Email** — the `ADMIN_EMAIL` from your `.env`
   - **Token** — the long `ADMIN_TOKEN` value from your `.env`
3. Choose your CSV and click **Validate and preview**
4. Read the preview. It tells you exactly what will be stored and what will be
   rejected, and why
5. Click **Approve and import**

Everything else — dashboard, rankings, reports, charts — fills in automatically.

### What a market CSV looks like

```csv
Date,Symbol,Close,Turnover,Deals,Volume,Outstanding Bid,Outstanding Offer,Market Cap
2026-08-14,CRDB,2700,7453641800,1739,2869227,129405,58236,7051959999900
```

Column names are flexible — `Ticker` works as well as `Symbol`, `Turnover TZS`
as well as `Turnover`. Only `Date` and `Symbol` are required.

An empty cell means "not reported". It is never read as zero.

---

## Getting data

**The DSE charges for historical market data.** Their Market Data Policy
(section 16) defines anything older than 24 hours as Historical Data and
requires a one-off fee plus a completed order form. Downloading it in bulk from
their website without that is against their stated terms.

To obtain it properly:

1. Email **data@dse.co.tz** and ask for the *Market Data Evaluation Form*
2. State the date range you want and that it is for **internal use**
3. Pay the one-off historical data fee
4. Import the file they send you using Step 4 above

Reference documents:
- [Market Data Policy](https://dse.co.tz/storage/extras/Data%20Vending%20Policy%20EN%201.2-1.pdf)
- [Market Data Price List 2026](https://dse.co.tz/storage/data_services/DSE%20MARKET%20DATA%20PRODUCT%20PRICELIST%20-%202026.pdf)
- [DSE data portal](https://data.dse.co.tz/console/register)

Without a licence you can still use the platform with data you already hold —
for example the daily reports the DSE publishes publicly, or your own records.

---

## Other things you can do

| Task | Command |
| --- | --- |
| Import financial results | `/admin/data`, choose kind **fundamentals** |
| Import dividends and splits | `/admin/data`, choose kind **corporate actions** |
| Load many days at once | Put dated CSVs in `data/incoming/`, then `npm run ingest -- --from=2026-06-01 --to=2026-08-14` |
| Check everything still works | `npm run verify` |

---

## If something goes wrong

| Message | What it means |
| --- | --- |
| `DATABASE_URL is not set` | Step 1 and 2 above — paste the database address into `.env` |
| `relation "instruments" does not exist` | Run `npm run db:migrate` |
| `UNKNOWN_SYMBOL` on import | That ticker is not in the securities list. Add it to `data/instruments.seed.csv` and run `npm run db:seed` |
| `ECONNREFUSED` | You used Railway's internal URL. Use `DATABASE_PUBLIC_URL` instead |
| Admin sign-in fails | `ADMIN_EMAIL` in `.env` must match exactly what you type |
| Page shows dashes everywhere | Normal with only a few days of data. Metrics needing 20 days stay blank until you have 20 days |

---

## Why so many blanks?

This platform will not show you a number it cannot stand behind. A dash (—)
always means *we do not have this*, never *this is zero*. A company that paid no
dividend and one whose dividend has not been loaded are different facts, and the
platform keeps them different.

Every score explains itself on the [Methodology](http://localhost:3000/methodology)
page, and each security's own Methodology tab shows the exact numbers behind its
scores.
