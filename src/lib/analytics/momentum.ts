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
 * The widest calendar span in which `n` trading sessions can plausibly occur.
 *
 * Five trading days fill seven calendar days, and three days of slack absorbs
 * public holidays and a long weekend. Anything wider means the stored history
 * has a hole in it.
 */
export function maxCalendarSpan(sessions: number): number {
  return Math.ceil(sessions * 1.4) + 3;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(later: string, earlier: string): number | null {
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / MS_PER_DAY);
}

/**
 * Price returns over standard windows.
 *
 * `closes` is ordered most-recent-first: closes[0] is the current session,
 * closes[1] the previous session, and so on. Nulls (non-trading sessions with
 * no close) are skipped when locating the reference price, so a counter that
 * did not trade for two sessions still gets a correct 5-day return.
 *
 * `dates` is the matching trading date for each entry, most-recent-first. When
 * supplied, a window is only reported if its reference session is close enough
 * in the calendar to be the session it claims to be. Without this a gap in the
 * stored history is silently mislabelled: loading 24 August on top of 14 August
 * makes the previous stored row ten days old, and the "1-day return" computed
 * from it is a ten-day return wearing the wrong name. Returning null is the
 * honest answer - the platform shows a dash, meaning we do not have this,
 * rather than a confident and wrong number.
 */
export function computeReturns(
  closes: readonly (number | null)[],
  high: number | null,
  low: number | null,
  dates?: readonly string[],
): ReturnsProfile {
  const current = closes[0] ?? null;

  const priceNSessionsBack = (n: number): number | null => {
    // Walk back through the array collecting non-null closes.
    let seen = 0;
    for (let i = 1; i < closes.length; i += 1) {
      const c = closes[i];
      if (c === null || c === undefined) continue;
      seen += 1;
      if (seen !== n) continue;

      if (dates && dates[0] && dates[i]) {
        const span = daysBetween(dates[0] as string, dates[i] as string);
        if (span !== null && span > maxCalendarSpan(n)) return null;
      }
      return c;
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
    volatility20d: dailyReturnVolatility(closes, WINDOWS.volatility, dates),
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
  dates?: readonly string[],
): number | null {
  // Keep each close paired with its date so a pair spanning a hole in the
  // history can be dropped rather than counted as a one-session move.
  const series: Array<{ close: number; date: string | null }> = [];
  for (let i = 0; i < Math.min(closes.length, window + 1); i += 1) {
    const c = closes[i];
    if (c === null || c === undefined || c <= 0) continue;
    series.push({ close: c, date: dates?.[i] ?? null });
  }

  if (series.length < 3) return null;

  const returns: number[] = [];
  for (let i = 0; i < series.length - 1; i += 1) {
    const newer = series[i];
    const older = series[i + 1];
    if (!newer || !older) continue;

    // A move measured across a gap is not a daily move. Including it would
    // inflate volatility with a jump that never happened in one session.
    if (newer.date && older.date) {
      const span = daysBetween(newer.date, older.date);
      if (span !== null && span > maxCalendarSpan(1)) continue;
    }

    returns.push((newer.close / older.close - 1) * 100);
  }

  if (returns.length < 2) return null;

  return stdDev(returns);
}
