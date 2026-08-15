/**
 * Whole-market analytics.
 *
 * The market summary is computed from the stored session rows rather than from
 * a headline figure supplied by a source, so the totals on screen always agree
 * with the counters listed beneath them. Where a source-supplied total is also
 * available, the ingestion layer records any discrepancy as a warning rather
 * than overwriting either number.
 */

import type {
  BoState,
  MarketSummary,
  PressureSignal,
} from '@/lib/types/market';
import { boRatio } from './bo';
import { boRatioToScore, pressureSignalFor } from './pressure';
import { clamp, scaleTo } from '@/lib/db/num';

/** One counter's contribution to the market aggregate. */
export interface MarketConstituent {
  instrumentId: string;
  symbol: string;
  close: number | null;
  previousClose: number | null;
  changePct: number | null;
  turnoverTzs: number | null;
  volume: number | null;
  deals: number | null;
  bidQty: number | null;
  offerQty: number | null;
  marketCapTzs: number | null;
  pressureScore: number | null;
}

export interface MarketBreadth {
  gainers: number;
  losers: number;
  unchanged: number;
  countersTraded: number;
  /** (gainers - losers) / (gainers + losers), in the range -1..1. */
  advanceDeclineRatio: number | null;
}

/**
 * Counts advancing, declining and flat counters.
 *
 * A counter with no trade in the session is not counted as "unchanged" - it is
 * not in the breadth statistics at all, because no price was discovered. Only
 * counters that actually traded are classified.
 */
export function computeBreadth(
  constituents: readonly MarketConstituent[],
): MarketBreadth {
  let gainers = 0;
  let losers = 0;
  let unchanged = 0;
  let countersTraded = 0;

  for (const c of constituents) {
    const traded = (c.volume ?? 0) > 0 || (c.deals ?? 0) > 0;
    if (!traded) continue;
    countersTraded += 1;

    const change =
      c.changePct ??
      (c.close !== null && c.previousClose !== null && c.previousClose > 0
        ? (c.close / c.previousClose - 1) * 100
        : null);

    if (change === null) {
      unchanged += 1;
    } else if (change > 0) {
      gainers += 1;
    } else if (change < 0) {
      losers += 1;
    } else {
      unchanged += 1;
    }
  }

  const decisive = gainers + losers;
  return {
    gainers,
    losers,
    unchanged,
    countersTraded,
    advanceDeclineRatio: decisive > 0 ? (gainers - losers) / decisive : null,
  };
}

/**
 * Market-wide bid/offer ratio: total outstanding bid quantity across all
 * counters divided by total outstanding offer quantity.
 *
 * This is a quantity-weighted figure, matching how the DSE publishes market
 * totals. It is not the average of the individual counters' ratios, which would
 * let one thin counter dominate.
 */
export function marketBoRatio(
  constituents: readonly MarketConstituent[],
): { totalBid: number; totalOffer: number; ratio: number | null; state: BoState } {
  let totalBid = 0;
  let totalOffer = 0;
  for (const c of constituents) {
    totalBid += c.bidQty ?? 0;
    totalOffer += c.offerQty ?? 0;
  }
  const { ratio, state } = boRatio(totalBid, totalOffer);
  return { totalBid, totalOffer, ratio, state };
}

export interface MarketPressureResult {
  score: number | null;
  signal: PressureSignal;
  components: Record<string, number | null>;
}

/**
 * Market pressure: the same idea as the per-counter score, applied to the
 * market aggregate.
 *
 *   - book:     the market-wide bid/offer ratio, log-scaled
 *   - breadth:  advancing versus declining counters
 *   - turnoverWeighted: the average of the counters' own pressure scores,
 *     weighted by turnover so that where the money actually traded matters more
 */
export function computeMarketPressure(
  constituents: readonly MarketConstituent[],
  breadth: MarketBreadth,
  book: { ratio: number | null },
): MarketPressureResult {
  const bookScore = boRatioToScore(book.ratio);

  const breadthScore =
    breadth.advanceDeclineRatio === null
      ? null
      : scaleTo(breadth.advanceDeclineRatio, -1, 1, 0, 100);

  let weightSum = 0;
  let weighted = 0;
  for (const c of constituents) {
    if (c.pressureScore === null) continue;
    const w = Math.max(c.turnoverTzs ?? 0, 0);
    if (w <= 0) continue;
    weighted += c.pressureScore * w;
    weightSum += w;
  }
  const turnoverWeighted = weightSum > 0 ? weighted / weightSum : null;

  const parts: Array<{ value: number | null; weight: number }> = [
    { value: bookScore, weight: 45 },
    { value: breadthScore, weight: 30 },
    { value: turnoverWeighted, weight: 25 },
  ];

  let earned = 0;
  let availableWeight = 0;
  let totalWeight = 0;
  for (const p of parts) {
    totalWeight += p.weight;
    if (p.value !== null) {
      earned += clamp(p.value, 0, 100) * p.weight;
      availableWeight += p.weight;
    }
  }

  const coverage = totalWeight > 0 ? (availableWeight / totalWeight) * 100 : 0;
  const score =
    availableWeight > 0 && coverage >= 45
      ? clamp(earned / availableWeight, 0, 100)
      : null;

  return {
    score,
    signal: pressureSignalFor(score, coverage),
    components: {
      orderBook: bookScore,
      breadth: breadthScore,
      turnoverWeightedPressure: turnoverWeighted,
      coverage,
    },
  };
}

/** Sums that the summary table stores. Money totals are also computed in SQL. */
export function computeMarketTotals(constituents: readonly MarketConstituent[]) {
  let totalTurnoverTzs = 0;
  let totalVolume = 0;
  let totalDeals = 0;
  let totalMarketCapTzs = 0;

  for (const c of constituents) {
    totalTurnoverTzs += c.turnoverTzs ?? 0;
    totalVolume += c.volume ?? 0;
    totalDeals += c.deals ?? 0;
    totalMarketCapTzs += c.marketCapTzs ?? 0;
  }

  return { totalTurnoverTzs, totalVolume, totalDeals, totalMarketCapTzs };
}

/** Assembles the full market summary for one trading date. */
export function buildMarketSummary(
  tradingDate: string,
  constituents: readonly MarketConstituent[],
  countersListed: number,
  dataConfidenceScore: number | null,
): MarketSummary {
  const breadth = computeBreadth(constituents);
  const book = marketBoRatio(constituents);
  const totals = computeMarketTotals(constituents);
  const pressure = computeMarketPressure(constituents, breadth, book);

  return {
    tradingDate,
    totalTurnoverTzs: totals.totalTurnoverTzs,
    totalVolume: totals.totalVolume,
    totalDeals: totals.totalDeals,
    countersTraded: breadth.countersTraded,
    countersListed,
    totalBidQty: book.totalBid,
    totalOfferQty: book.totalOffer,
    marketBoRatio: book.ratio,
    marketBoState: book.state,
    totalMarketCapTzs: totals.totalMarketCapTzs,
    gainers: breadth.gainers,
    losers: breadth.losers,
    unchanged: breadth.unchanged,
    marketPressureScore: pressure.score,
    marketPressureSignal: pressure.signal,
    breadthComponents: {
      ...pressure.components,
      advanceDeclineRatio: breadth.advanceDeclineRatio,
    },
    dataConfidenceScore,
  };
}
