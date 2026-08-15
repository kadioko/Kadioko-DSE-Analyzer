/**
 * Momentum analytics: how today's order book and price compare with the
 * counter's own recent history.
 *
 * Everything here refuses to produce a number when the sample is too small.
 * A "momentum" figure computed from one prior observation is not momentum, it
 * is noise, and publishing it would be worse than publishing nothing.
 */

import type { BoMomentumResult, BoState, ReturnsProfile } from '@/lib/types/market';
import { isUsableForAverage } from './bo';
import { WINDOWS } from './config';
import { mean, pctChange, stdDev } from '@/lib/db/num';

export interface BoObservation {
  ratio: number | null;
  state: BoState;
}

/**
 * B/O momentum: current bid/offer ratio versus its trailing average.
 *
 *   momentum% = (current / avg(previous N) - 1) x 100
 *
 * `trailing` must contain the observations BEFORE the current one, most recent
 * first or last - order does not matter, only membership.
 *
 * Returns null (with a reason) when:
 *   - the current ratio is undefined (NO_OFFER / EMPTY_BOOK),
 *   - fewer than `minObservations` usable trailing values exist,
 *   - the trailing average is zero, which would make the ratio meaningless.
 */
export function boMomentum(
  current: BoObservation,
  trailing: readonly BoObservation[],
  window: number = WINDOWS.boMomentum,
  minObservations: number = WINDOWS.boMomentumMinObservations,
): BoMomentumResult {
  const usable = trailing
    .slice(0, window)
    .filter((o) => isUsableForAverage(o.ratio, o.state))
    .map((o) => o.ratio as number);

  const base: BoMomentumResult = {
    momentumPct: null,
    avgBo: null,
    observations: usable.length,
    requiredObservations: minObservations,
    reason: null,
  };

  if (!isUsableForAverage(current.ratio, current.state)) {
    return {
      ...base,
      avgBo: mean(usable),
      reason:
        current.state === 'NO_OFFER'
          ? 'Current bid/offer ratio is undefined: there are no offers on the board.'
          : 'Current bid/offer ratio is undefined: the order book is empty.',
    };
  }

  if (usable.length < minObservations) {
    return {
      ...base,
      avgBo: mean(usable),
      reason: `Not enough history: ${usable.length} usable trailing observation(s), ${minObservations} required.`,
    };
  }

  const avgBo = mean(usable);
  if (avgBo === null || avgBo === 0) {
    return {
      ...base,
      avgBo,
      reason:
        'Trailing average bid/offer ratio is zero, so a percentage change is undefined.',
    };
  }

  return {
    momentumPct: (current.ratio / avgBo - 1) * 100,
    avgBo,
    observations: usable.length,
    requiredObservations: minObservations,
    reason: null,
  };
}

/**
 * Trailing average B/O over the window, ignoring undefined observations.
 * Exposed separately because the stock page shows it next to the current ratio.
 */
export function averageBo(
  observations: readonly BoObservation[],
  window: number = WINDOWS.boMomentum,
): { avg: number | null; observations: number } {
  const usable = observations
    .slice(0, window)
    .filter((o) => isUsableForAverage(o.ratio, o.state))
    .map((o) => o.ratio as number);
  return { avg: mean(usable), observations: usable.length };
}

/**
 * Price returns over standard windows.
 *
 * `closes` is ordered most-recent-first: closes[0] is the current session,
 * closes[1] the previous session, and so on. Nulls (non-trading sessions with
 * no close) are skipped when locating the reference price, so a counter that
 * did not trade for two sessions still gets a correct 5-day return.
 */
export function computeReturns(
  closes: readonly (number | null)[],
  high: number | null,
  low: number | null,
): ReturnsProfile {
  const current = closes[0] ?? null;

  const priceNSessionsBack = (n: number): number | null => {
    // Walk back through the array collecting non-null closes.
    let seen = 0;
    for (let i = 1; i < closes.length; i += 1) {
      const c = closes[i];
      if (c === null || c === undefined) continue;
      seen += 1;
      if (seen === n) return c;
    }
    return null;
  };

  const rangePct =
    high !== null && low !== null && low > 0 ? ((high - low) / low) * 100 : null;

  return {
    return1d: pctChange(current, priceNSessionsBack(1)),
    return5d: pctChange(current, priceNSessionsBack(WINDOWS.returnsShort)),
    return20d: pctChange(current, priceNSessionsBack(WINDOWS.returnsLong)),
    rangePct,
    volatility20d: dailyReturnVolatility(closes, WINDOWS.volatility),
  };
}

/**
 * Standard deviation of daily percentage returns over the window, in percent.
 * Not annualised - it is presented as "typical daily move", which is the
 * honest description of what it measures on a market with frequent no-trade
 * sessions.
 */
export function dailyReturnVolatility(
  closes: readonly (number | null)[],
  window: number = WINDOWS.volatility,
): number | null {
  const series = closes
    .slice(0, window + 1)
    .filter((c): c is number => c !== null && c !== undefined && c > 0);

  if (series.length < 3) return null;

  const returns: number[] = [];
  for (let i = 0; i < series.length - 1; i += 1) {
    const newer = series[i] as number;
    const older = series[i + 1] as number;
    returns.push((newer / older - 1) * 100);
  }

  return stdDev(returns);
}
