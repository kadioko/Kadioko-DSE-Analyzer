# Architecture

## Data flow

```
DSE DATA SOURCES
        │
        ▼
SOURCE ADAPTERS            src/lib/providers/
   MarketDataProvider      CsvProvider · DseOfficialProvider · ThirdPartyProvider
        │
        ▼
INGESTION ENGINE           src/lib/ingestion/
   parse → normalize       parse.ts
        │
        ▼
VALIDATION                 src/lib/validation/
   shape (Zod) + rules     market-record.ts
        │
        ├─── rejected ───► ingestion_errors  (reason, raw row, rule code)
        │
        ▼
RAILWAY POSTGRESQL
   market_daily            ← raw observations only
   raw_market_payloads     ← audit trail
        │
        ├─────────────────────────────┐
        ▼                             ▼
ANALYTICS ENGINE              FUNDAMENTALS ENGINE
src/lib/analytics/            fundamentals → valuations
   bo · momentum · liquidity
   pressure · opportunity
   confidence · market
        │                             │
        └──────────┬──────────────────┘
                   ▼
        analytics_daily · market_daily_summary · valuations
                   │
                   ▼
        APPLICATION API        src/app/api/
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
 Dashboard    Stock page      Reports
                   │
                   ▼
        AI EXPLANATION LAYER   (narrates computed values only)
```

## Module boundaries

The brief sketched a `/apps` + `/packages` monorepo. This repository implements
the same boundaries inside one deployable:

| Boundary | Location | May import |
| --- | --- | --- |
| Types | `src/lib/types/` | nothing |
| Numeric helpers | `src/lib/db/num.ts` | nothing |
| Analytics | `src/lib/analytics/` | types, num |
| Validation | `src/lib/validation/` | types, analytics config |
| Ingestion | `src/lib/ingestion/` | types, validation, db |
| Database | `src/lib/db/` | schema, env |
| Providers | `src/lib/providers/` | types |
| API + UI | `src/app/` | everything above |

The dependency arrows only point one way. The analytics engine imports nothing
from `src/app/`; the database layer imports nothing from React. That is what
makes the engine unit-testable without a database or a browser, and it is why
`npm test` runs green on a clean checkout with no `DATABASE_URL`.

## Raw versus derived data

This separation is structural, not a convention.

| | Raw | Derived |
| --- | --- | --- |
| Tables | `market_daily`, `raw_market_payloads` | `analytics_daily`, `market_daily_summary`, `valuations` |
| Written by | ingestion only | analytics engine only |
| Versioned | no — it is what the source said | yes — `model_version` on every row |
| Recomputable | no | yes, from raw data alone |

Consequences:

- Changing a scoring formula never touches an observation.
- A score published last month can be reproduced by re-running that
  `model_version` against unchanged raw rows.
- A bad import can be corrected and analytics regenerated without data loss.

## Money and floating point

PostgreSQL `NUMERIC` columns are read into TypeScript as **strings**, and the
conversion to a JS number is explicit (`src/lib/db/num.ts`). The rule:

- **Summing money** — done in SQL, on `NUMERIC`, so it is exact.
- **Ratios, percentages, scores** — converted to JS numbers, where float64 is
  correct and precision is irrelevant.

Quantities are `bigint`. Prices are `NUMERIC(20,4)`, turnover `NUMERIC(24,4)`,
market capitalisation `NUMERIC(30,4)` (DSE market caps reach 10¹³ TZS).

## Score design

Three ideas are kept separate because conflating them is the most common way a
market dashboard misleads its reader:

| Score | Question it answers | Weights |
| --- | --- | --- |
| **Market Pressure** | Is there more resting demand or supply right now? | `PRESSURE_WEIGHTS` |
| **Opportunity** | Does this look attractive on the available evidence? | `OPPORTUNITY_WEIGHTS` |
| **Data Confidence** | How much should you trust the two above? | `CONFIDENCE_PENALTIES` |

Every composite score returns its components — each with a raw sub-score,
weight, points contributed and a plain-language explanation — and a `coverage`
figure. When coverage falls below the model's threshold the score is withheld
(`null`) rather than published from a fragment of its inputs.

Missing pillars are **excluded and renormalised**, never imputed. An issuer with
no published financials does not receive a neutral 50/100 fundamentals score; the
pillar is removed from the denominator, listed in `missing`, and the confidence
score falls.

## Security posture

| Concern | Mechanism |
| --- | --- |
| Database credentials | `src/lib/env.ts` and `src/lib/db/client.ts` are `server-only`; importing from a client component fails the build |
| Input validation | Zod at every external boundary — CSV rows, query params, API bodies |
| SQL injection | Drizzle parameterised queries; no string-built SQL |
| CSV injection | Leading `=`, `+`, `-`, `@` stripped from text cells on parse |
| Resource exhaustion | 10 MB / 50,000 row parse limits enforced before per-row work |
| Admin surfaces | Server-side authorisation, `no-store`, `noindex` |
| Transport | HSTS, `X-Frame-Options: DENY`, `nosniff`, restrictive `Permissions-Policy` |
| Scheduled ingestion | Bearer `CRON_SECRET` |

## Deployment topology

```
Vercel or Railway          Railway                    Railway Cron
   Next.js app    ────►   PostgreSQL    ◄────    ingestion worker
```

The database is Railway PostgreSQL regardless of where the frontend runs. See
[railway.md](railway.md).
