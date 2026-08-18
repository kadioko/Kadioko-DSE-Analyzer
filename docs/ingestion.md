# Ingestion

## Provider contract

Every data source implements one interface, so nothing downstream knows where
data came from:

```ts
interface MarketDataProvider {
  readonly id: string;
  readonly displayName: string;
  readonly licensed: boolean;
  fetchDaily(date: Date): Promise<NormalizedMarketRecord[]>;
  healthCheck(): Promise<ProviderStatus>;
}
```

| Provider | Status | Notes |
| --- | --- | --- |
| `CsvProvider` | **implemented** | Watches `INGEST_DIR` for end-of-day files. Used by the worker and the cron endpoint. |
| `DseOfficialProvider` | declared, not implemented | `fetchDaily` throws; `healthCheck` reports unhealthy with the reason. Awaits a data licence and endpoint specification. |
| `ThirdPartyProvider` | declared, not implemented | Same. Awaits vendor selection. |

## Scheduled ingestion

Two entry points, both running the identical pipeline:

```bash
npm run ingest -- --date=2026-08-14
```

```bash
curl -X POST "https://<host>/api/cron/ingest?date=2026-08-14"   -H "Authorization: Bearer $CRON_SECRET"
```

The flow:

```
provider.fetchDaily -> validate -> store -> analytics -> valuations -> ranking
```

A scheduled file is held to exactly the same data-quality rules as a manual
upload; arriving on a schedule earns it no leniency.

Behaviour worth knowing:

- **Weekends are skipped and say so.** The result carries `status: "SKIPPED"`
  with a reason, rather than failing or silently doing nothing.
- **East Africa Time.** The default date is today in EAT (UTC+3), not the
  server's local date. A UTC host running an evening job would otherwise ingest
  the wrong session.
- **Retries are for transient failures only.** A missing file or unreachable
  provider is retried with linear backoff. A validation failure is not:
  retrying a malformed file just produces the same rejections again.
- **The HTTP endpoint returns 200 with `status: "FAILED"`** when the run fails.
  The request was handled; the ingestion was not. Alert on the status field,
  not the HTTP code.
- **Idempotent.** Re-running a date updates the same rows and records a fresh
  ingestion run.

Worker options:

| Flag | Meaning |
| --- | --- |
| `--date=YYYY-MM-DD` | one session |
| `--from=` / `--to=` | an inclusive range, useful for backfill |
| `--provider=` | override `DATA_PROVIDER` |
| `--attempts=` / `--delayMs=` | retry behaviour |

The worker exits non-zero when any date fails, so a scheduler surfaces it.

Unimplemented providers report `healthy: false` with an explanatory message.
They are **not** stubbed with fabricated responses — a provider that appears to
work but returns invented data is worse than one that plainly reports it is not
configured.

### On scraping

A development-only parser may exist behind `ENABLE_DEV_PARSERS=true`, and is
hard-disabled when `NODE_ENV=production` (`devParsersEnabled()` in
`src/lib/env.ts`). It exists for local testing only. Obtaining an appropriate
data licence from the DSE is a prerequisite for production operation.

---

## CSV workflow

```
upload → parse → normalize → validate → preview → approve → upsert
                                   ↓                          ↓
                            ingestion_errors          analytics recalculation
                                                              ↓
                                                      market summary rebuild
```

Nothing is written to `market_daily` until an operator approves the preview.

### Recognised columns

Header spellings are matched case-insensitively with punctuation removed, so
`Previous Close`, `previous_close` and `PrevClose` all map to the same field.

| Canonical field | Accepted headers |
| --- | --- |
| `symbol` | Symbol, Ticker, Code, Security, Counter |
| `companyName` | Company, Name, Issuer, Security Name |
| `tradingDate` | Date, Trading Date, Trade Date, Session Date |
| `open` | Open, Open Price, Opening Price |
| `previousClose` | Previous Close, Prev Close, Previous Price |
| `close` | Close, Close Price, Closing Price, Last Price, Price |
| `high` / `low` | High / Low, Day High / Day Low |
| `changePct` | Change, Change %, Pct Change |
| `turnoverTzs` | Turnover, Value, Traded Value |
| `deals` | Deals, Trades, Number of Deals, Transactions |
| `volume` | Volume, Shares, Shares Traded, Quantity |
| `outstandingBidQty` | Outstanding Bid, Bid, Bid Qty |
| `outstandingOfferQty` | Outstanding Offer, Offer, Ask, Offer Qty |
| `marketCapTzs` | Market Cap, Market Capitalisation, MCap |

`symbol` and `tradingDate` are required. Everything else is optional and becomes
`null` when absent.

### Number parsing

Handles thousands separators, currency prefixes (`TZS`, `TShs`), trailing `%`,
and parenthesised negatives `(1,234)`.

An empty cell, `-`, `–`, `N/A`, `nil` or `null` becomes **`null`, never `0`**.
"Did not trade" and "traded zero" are different facts and are never conflated.

### Date parsing

Accepted: `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY`, `DD-MMM-YYYY`.

Ambiguous numeric dates are read **day-first**, the convention in Tanzanian
publications. A value that can only be month-first (`03/25/2026`) is rejected
rather than silently reinterpreted.

### Safety limits

| Limit | Value |
| --- | --- |
| File size | 10 MB |
| Row count | 50,000 |
| Text cell length | 200 characters |

A leading `=`, `+`, `-` or `@` is stripped from text cells so a crafted CSV
cannot become a formula if the data is later exported and opened in a
spreadsheet.

---

## Data-quality rules

Two severities:

- **ERROR** — the row is rejected, never stored, and recorded in
  `ingestion_errors` with its raw content.
- **WARNING** — the row is stored with `validation_status = 'WARNING'` and its
  notes attached, and its data-confidence score is reduced.

### Errors

| Code | Condition |
| --- | --- |
| `MISSING_PRICE` | neither close nor previous close present |
| `FUTURE_TRADING_DATE` | trading date is in the future |
| `IMPLAUSIBLE_TRADING_DATE` | predates 1998-01-01 |
| `UNKNOWN_SYMBOL` | symbol is not in the instrument master |
| `HIGH_BELOW_LOW` | high < low |
| `CLOSE_OUTSIDE_HIGH_LOW` | close above high or below low |
| `OPEN_OUTSIDE_HIGH_LOW` | open above high or below low |

Negative prices, volumes and turnover are rejected at the Zod shape layer before
these rules run.

### Warnings

| Code | Condition |
| --- | --- |
| `WEEKEND_TRADING_DATE` | date falls on a Saturday or Sunday |
| `ZERO_CLOSE` | close price is zero |
| `VOLUME_WITHOUT_TURNOVER` | volume > 0 with zero turnover |
| `TURNOVER_WITHOUT_VOLUME` | turnover > 0 with zero volume |
| `DEALS_WITHOUT_VOLUME` | deals > 0 with zero volume |
| `IMPLIED_PRICE_OUT_OF_RANGE` | turnover ÷ volume falls outside the session range ±25% |
| `EXTREME_PRICE_MOVEMENT` | absolute change > 30% |
| `CHANGE_PCT_MISMATCH` | reported change disagrees with close ÷ previous close by > 0.6pp |
| `MARKET_CAP_ANOMALY` | market cap deviates > 5% from close × shares outstanding |
| `MISSING_MARKET_CAP` | no market cap supplied |

`EXTREME_PRICE_MOVEMENT` is a warning rather than an error because a 30%+ move
can be genuine — an unrecorded corporate action, a re-listing, a very thin
counter. It is flagged for a human to confirm, not discarded.

`MARKET_CAP_ANOMALY` usually means shares outstanding are stale in the
instrument master, or a corporate action has not been recorded.

---

## Idempotency

Imports are safe to repeat. The `(instrument_id, trading_date)` unique
constraint on `market_daily` means a re-upload updates the same rows rather than
duplicating them.

Each run records: records received, inserted, updated, unchanged, rejected,
warnings, status, and a SHA-256 checksum of the payload — so re-uploading a
byte-identical file is recognised as such.

Every stored observation carries `ingestion_run_id` and `source_id`, so any
number on screen can be traced back to the file and run that produced it.

---

## Audit trail

`raw_market_payloads` stores the payload as received, with its checksum and byte
size. It is never served publicly. It is what allows a derived figure to be
traced back to the bytes it came from, and what makes a disputed number
resolvable.

---

## Recalculation

After a successful import, for every affected trading date:

1. `analytics_daily` is regenerated for each affected instrument
2. `market_daily_summary` is rebuilt for the date

Both are keyed by `model_version`, so a formula change produces new rows rather
than overwriting the old ones. Raw observations are never touched by
recalculation.

---

## Data licensing: what the DSE actually permits

Checked directly against the exchange's published
[Market Data Policy](https://dse.co.tz/storage/extras/Data%20Vending%20Policy%20EN%201.2-1.pdf)
(June 2024, 48 pages).

**Section 16 — Historical Data Policy**

| Clause | What it says |
| --- | --- |
| 16.2 | Historical Data is **all market data older than 24 hours** |
| 16.3.3(i) | A person, **whether a Contracted User or not**, must pay a once-off historical data fee based on type, range and intended use |
| 16.3.3(ii) | The requester must first complete the **DSE Historical Data Order form** / Market Data Evaluation Form and email it to `data@dse.co.tz` |
| 16.3.3(iii) | The user **may not redistribute** market data without express prior written permission; Redistribution Licence Fees apply separately |

The practical consequence for this project:

- **Bulk-harvesting historical prices from the DSE website is against the
  exchange's stated terms**, even though `robots.txt` permits crawling. The
  absence of a technical block is not a licence.
- Redistribution — including exposing the data through this platform's public
  API or the Kadioko DSE Sheet to anyone outside your organisation — needs a
  **separate** licence beyond the historical data fee.
- Section 20 governs **Derived Data**. The scores this platform computes
  (pressure, liquidity, opportunity, ranking) are derived data, and their
  distribution is covered by that section.

**The supported route**

1. Email `data@dse.co.tz` requesting the Market Data Evaluation Form
2. State the date range and whether the use is *internal* or *external
   distribution* — the fees differ
3. Pay the one-off historical data fee
4. Import the delivered file through `/admin/data`

Registration portal: <https://data.dse.co.tz/console/register>
Price list: [DSE Market Data Product Price List 2026](https://dse.co.tz/storage/data_services/DSE%20MARKET%20DATA%20PRODUCT%20PRICELIST%20-%202026.pdf)
(published as scanned images; fees are not machine-readable)

**Why no scraper ships in this repository**

Non-negotiable rule 7 of this project says unauthorised scraping must never
become the production architecture. The exchange's own policy makes bulk
historical collection a paid, form-gated process. Building a harvester would
put the platform in breach of the terms of the data it depends on, so
`DseOfficialProvider` remains declared-and-unimplemented until a licence exists.
Nothing about the platform changes when one does: the provider interface, the
ingestion pipeline and the analytics engine are already in place, and only that
one file needs writing.
