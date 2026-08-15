# Methodology

Every formula, weight and threshold used by this platform is published here and
lives in one file: [`src/lib/analytics/config.ts`](../src/lib/analytics/config.ts).
Changing a number there means minting a new model version, so any score stored
in the past can be reproduced.

There are no hidden scores.

---

## 1. Bid / Offer ratio

The DSE publishes outstanding bid and offer quantities: the resting order book
at the close.

```
B/O = outstanding bid quantity ÷ outstanding offer quantity
```

The ratio is undefined when there are no offers. This platform reports that
honestly rather than substituting a large sentinel number:

| Book | State | Ratio |
| --- | --- | --- |
| bid > 0, offer > 0 | `NORMAL` | bid ÷ offer |
| bid = 0, offer > 0 | `NO_BID` | `0` — a real, meaningful zero |
| bid > 0, offer = 0 | `NO_OFFER` | `null` — undefined, not infinite |
| bid = 0, offer = 0 | `EMPTY_BOOK` | `null` |

**Why this matters.** A placeholder such as 999999 for `NO_OFFER` would enter
trailing averages, momentum calculations and scores, and corrupt every figure
downstream. Undefined observations are excluded from averages entirely.

Both the numeric ratio and the state are returned by the API and shown in the UI.

### Order book valued in TZS

```
Bid value   = bid quantity   × close
Offer value = offer quantity × close
```

### Normalised by market capitalisation

```
Bid % market cap   = bid value   ÷ market cap × 100
Offer % market cap = offer value ÷ market cap × 100
```

This is what makes counters comparable. A 435,736-share bid on a 2,600 TZS
counter and an 11,414-share bid on a 17,600 TZS counter are not comparable as
quantities, and only partly comparable as TZS values. As a share of market
capitalisation they are directly comparable.

---

## 2. B/O momentum

```
B/O momentum % = (current B/O ÷ average of previous 5 observations − 1) × 100
```

Requirements, all enforced:

- The current ratio must be defined (`NORMAL` or `NO_BID`).
- At least **3** usable trailing observations must exist (`WINDOWS.boMomentumMinObservations`).
- The trailing average must be non-zero.

If any fails, momentum is `null` and a `reason` string explains which. A
momentum figure computed from one prior observation is noise, and publishing it
would be worse than publishing nothing.

Undefined trailing observations are skipped, not zero-filled. A window
containing `[2.0, NO_OFFER, 1.0, EMPTY_BOOK, 3.0]` averages the three defined
values to 2.0.

---

## 3. Volume and liquidity

| Metric | Definition |
| --- | --- |
| 5-day average volume | mean of the last 5 sessions with data |
| 20-day average volume | mean of the last 20 sessions — requires ≥ 10 observations |
| 20-day **median** volume | median of the same window |
| Volume ratio | current volume ÷ 20-day average |
| Turnover ratio | session turnover ÷ market capitalisation |
| Average deal size | turnover ÷ deals |
| Liquidity percentile | rank of this counter's turnover among all counters that session |

**Why the median is computed alongside the mean.** A single negotiated block
trade on the DSE can be many multiples of a counter's normal daily volume and
will drag the mean far from its typical session. The median is the honest
description of "a normal day" for that counter.

The 20-day statistics are `null` below 10 observations rather than being
computed from a short sample.

### Liquidity score (0–100)

| Component | Weight | Basis |
| --- | --- | --- |
| Turnover | 40 | log₁₀ TZS turnover, 10⁶ → 0, 10¹⁰ → 100 |
| Deals | 25 | log₁₀ deal count, 10⁰ → 0, 10⁴ → 100 |
| Consistency | 20 | share of recent sessions in which the counter traded |
| Book depth | 15 | log₁₀ TZS value of resting orders on both sides |

Log scaling is used because turnover on the DSE spans several orders of
magnitude; a linear scale would compress every counter except the largest into
the bottom of the range.

---

## 4. Market Pressure score (0–100)

**What it measures:** the balance between resting demand and resting supply, and
whether recent flow confirms it.

```
  0  extreme supply-side (sell) pressure
 50  balanced
100  extreme demand-side (buy) pressure
```

**What it does not measure:** whether a security is a good investment. Pressure
is an order-book observation. A high reading is not a buy signal on its own, and
the application never presents it as one.

| Component | Weight | Basis |
| --- | --- | --- |
| Order book | 30 | B/O ratio through log₁₀; 0.1× → 0, 1.0× → 50, 10× → 100 |
| B/O momentum | 22 | change vs 5-session average; ±150% saturates |
| Price | 16 | session change; ±5% saturates |
| Volume | 16 | whether volume confirms the price move |
| Depth | 9 | net (bid − offer) as % of market cap; ±0.5% saturates |
| Liquidity | 7 | order-book reading damped toward neutral when illiquid |

**Why log₁₀ for the ratio.** A linear mapping would treat "twice as many offers"
as much milder than "twice as many bids". In log space 0.5× and 2.0× sit
symmetrically either side of balance, which is how an order book actually
behaves.

**Volume confirmation.** Volume alone has no side. It is signed by the direction
of the price move: above-average volume pushes the score in the direction of the
move, below-average volume pulls it back toward neutral. With no price direction
the component returns the neutral midpoint.

**Liquidity damping.** A thin book is weak evidence in either direction, so the
liquidity component carries the order-book reading scaled toward 50 in
proportion to how illiquid the counter is.

### Signal bands

| Score | Signal |
| --- | --- |
| < 25 | Strong supply pressure |
| 25 – 42 | Supply pressure |
| 42 – 58 | Balanced |
| 58 – 75 | Demand pressure |
| > 75 | Strong demand pressure |

Below **45% coverage** the score is withheld and the signal is
`INSUFFICIENT_DATA`.

### Example API response

```json
{
  "pressureScore": 74,
  "coverage": 100,
  "modelVersion": "pressure-v1",
  "components": {
    "orderBook":  { "raw": 74.9, "weight": 30, "contribution": 22.5, "available": true },
    "boMomentum": { "raw": 92.5, "weight": 22, "contribution": 20.4, "available": true },
    "price":      { "raw": 62.0, "weight": 16, "contribution":  9.9, "available": true },
    "volume":     { "raw": 65.8, "weight": 16, "contribution": 10.5, "available": true },
    "depth":      { "raw": 58.0, "weight":  9, "contribution":  5.2, "available": true },
    "liquidity":  { "raw": 67.4, "weight":  7, "contribution":  4.7, "available": true }
  }
}
```

Every component carries an `explanation` string in the live API.

---

## 5. Opportunity score (0–100)

A **different** score from Market Pressure, displayed separately everywhere.

| Pillar | Weight | Inputs |
| --- | --- | --- |
| Fundamentals | 30 | ROE, net margin, EPS growth |
| Valuation | 20 | P/E, P/B |
| Momentum | 15 | 20-day and 5-day returns |
| Liquidity | 10 | liquidity score |
| Market Pressure | 10 | pressure score |
| Dividend | 10 | trailing dividend yield |
| Risk | 5 | realised volatility, debt-to-equity |

Market Pressure contributes only 10% — order-book imbalance is a short-horizon
signal, not an investment case.

### Missing data

A pillar with no data is **excluded from the denominator**, listed in `missing`,
and the data-confidence score falls. It is never filled with a neutral value.

An issuer that has published no financial results shows:

> Fundamental data unavailable

and the remaining pillars are renormalised over the weight that was available.
Below **40% coverage** no score is published at all.

Negative earnings produce no valuation sub-score rather than a flattering one: a
negative P/E is not "cheap", it is not meaningful.

---

## 6. Data Confidence score (0–100)

Confidence answers a different question from every other score: not *what does
the data say* but *how much should you trust what it says*.

It starts at 100 and subtracts named penalties.

| Code | Penalty | Trigger |
| --- | --- | --- |
| `MISSING_CORE_FIELD` | 12 each, capped 40 | required market field absent |
| `MISSING_MARKET_CAP` | 10 | depth cannot be normalised |
| `SEVERELY_INSUFFICIENT_HISTORY` | 30 | fewer than 5 sessions |
| `INSUFFICIENT_HISTORY` | 15 | fewer than 20 sessions |
| `STALE_DATA` | 20 | latest observation older than 5 days |
| `NO_TRADE_IN_SESSION` | 10 | counter did not trade |
| `LOW_LIQUIDITY` | 12 | turnover below 5,000,000 TZS |
| `VALIDATION_WARNING` | 15 | row stored with data-quality warnings |
| `UNLICENSED_SOURCE` | 10 | manual or unlicensed source |
| `NO_FUNDAMENTALS` | 8 | no financial results on file |
| `UNVERIFIED_FUNDAMENTALS` | 5 | financials not checked against the filing |

Each applied penalty is returned with a plain-language detail string, so a low
confidence figure always arrives with its reason attached. Every
investment-oriented score in the application is displayed together with its
confidence.

| Score | Label |
| --- | --- |
| ≥ 80 | High |
| 60 – 79 | Moderate |
| 40 – 59 | Low |
| < 40 | Very low |

---

## 7. Market-wide metrics

**Market B/O ratio** is quantity-weighted:

```
market B/O = Σ outstanding bid ÷ Σ outstanding offer
```

not the average of individual counters' ratios — which would let one thin
counter with a lopsided book dominate the whole market's reading.

**Breadth.** Only counters that actually traded are classified. A counter with
no trade is *not* counted as "unchanged"; no price was discovered, so it is
absent from breadth entirely.

**Market pressure** blends the market-wide book (45%), advance/decline breadth
(30%) and the turnover-weighted average of individual pressure scores (25%).
Turnover weighting means the reading reflects where money actually traded.

---

## 8. Unusual activity detection

| Signal | Rule |
| --- | --- |
| Unusual volume | volume ratio > 2.0 |
| B/O acceleration | momentum > +50% |
| B/O deterioration | momentum < −40% |
| Positive momentum | 5-day return > +5% |
| Negative momentum | 5-day return < −5% |

**Possible reversal** requires *all* of:

1. price direction and B/O direction disagree,
2. the B/O move exceeds ±60%,
3. volume ratio above 1.3 (volume confirmation).

Nothing is labelled a reversal on price action alone.

---

## 9. What the AI layer may and may not do

The quantitative engine calculates. The AI narrates.

Given:

```
CRDB
B/O 3.14 · 5D avg 1.38 · momentum +127.5% · volume ratio 1.63
```

it may produce:

> CRDB's outstanding bid-to-offer balance has risen sharply relative to its
> recent history, indicating increased near-term demand pressure. Volume is also
> above its recent average.

It may **not**: introduce a number absent from the fact block, invent
fundamentals, invent market news, or issue a recommendation.
