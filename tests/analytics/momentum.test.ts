import { describe, expect, it } from 'vitest';
import {
  averageBo,
  boMomentum,
  computeReturns,
  dailyReturnVolatility,
} from '@/lib/analytics/momentum';
import type { BoObservation } from '@/lib/analytics/momentum';

const normal = (ratio: number): BoObservation => ({ ratio, state: 'NORMAL' });

describe('B/O momentum', () => {
  it('computes (current / trailing average - 1) x 100', () => {
    const trailing = [normal(1.0), normal(1.5), normal(1.2), normal(1.4), normal(1.3)];
    // average = 1.28
    const result = boMomentum(normal(3.14), trailing);
    expect(result.avgBo).toBeCloseTo(1.28, 10);
    expect(result.momentumPct).toBeCloseTo((3.14 / 1.28 - 1) * 100, 10);
    expect(result.observations).toBe(5);
    expect(result.reason).toBeNull();
  });

  it('reproduces the documented CRDB-style example', () => {
    // current 3.14 against a 5-day average of 1.38 -> approximately +127.5%
    const trailing = [normal(1.38), normal(1.38), normal(1.38), normal(1.38), normal(1.38)];
    const result = boMomentum(normal(3.14), trailing);
    expect(result.momentumPct).toBeCloseTo(127.536, 2);
  });

  it('withholds momentum when there is not enough history', () => {
    const result = boMomentum(normal(3.14), [normal(1.2), normal(1.3)]);
    expect(result.momentumPct).toBeNull();
    expect(result.observations).toBe(2);
    expect(result.requiredObservations).toBe(3);
    expect(result.reason).toContain('Not enough history');
  });

  it('withholds momentum when the current book has no offers', () => {
    const trailing = [normal(1.2), normal(1.3), normal(1.4), normal(1.1)];
    const result = boMomentum({ ratio: null, state: 'NO_OFFER' }, trailing);
    expect(result.momentumPct).toBeNull();
    expect(result.reason).toContain('no offers');
  });

  it('excludes undefined trailing observations from the average', () => {
    const trailing: BoObservation[] = [
      normal(2.0),
      { ratio: null, state: 'NO_OFFER' },
      normal(1.0),
      { ratio: null, state: 'EMPTY_BOOK' },
      normal(3.0),
    ];
    const result = boMomentum(normal(2.0), trailing);
    expect(result.observations).toBe(3);
    expect(result.avgBo).toBeCloseTo(2.0, 10);
    expect(result.momentumPct).toBeCloseTo(0, 10);
  });

  it('withholds momentum when the trailing average is zero', () => {
    const trailing: BoObservation[] = [
      { ratio: 0, state: 'NO_BID' },
      { ratio: 0, state: 'NO_BID' },
      { ratio: 0, state: 'NO_BID' },
    ];
    const result = boMomentum(normal(1.5), trailing);
    expect(result.momentumPct).toBeNull();
    expect(result.reason).toContain('zero');
  });

  it('respects the window and ignores observations beyond it', () => {
    const trailing = [
      normal(1.0), normal(1.0), normal(1.0), normal(1.0), normal(1.0),
      normal(99), normal(99),
    ];
    const result = boMomentum(normal(2.0), trailing, 5);
    expect(result.avgBo).toBeCloseTo(1.0, 10);
    expect(result.momentumPct).toBeCloseTo(100, 10);
  });
});

describe('averageBo', () => {
  it('returns null with zero observations rather than 0', () => {
    const result = averageBo([]);
    expect(result.avg).toBeNull();
    expect(result.observations).toBe(0);
  });
});

describe('returns', () => {
  it('computes 1d, 5d and 20d returns from a most-recent-first series', () => {
    // 22 sessions, each 1% above the previous.
    const closes = Array.from({ length: 22 }, (_, i) => 100 * 1.01 ** (21 - i));
    const r = computeReturns(closes, null, null);
    expect(r.return1d).toBeCloseTo(1, 6);
    expect(r.return5d).toBeCloseTo((1.01 ** 5 - 1) * 100, 6);
    expect(r.return20d).toBeCloseTo((1.01 ** 20 - 1) * 100, 6);
  });

  it('skips non-trading sessions when locating the reference price', () => {
    // Current 110, then two sessions with no close, then 100.
    const r = computeReturns([110, null, null, 100], null, null);
    expect(r.return1d).toBeCloseTo(10, 10);
  });

  it('returns null when history is too short instead of extrapolating', () => {
    // Most-recent-first: current 100 against a previous close of 99.
    const r = computeReturns([100, 99], null, null);
    expect(r.return1d).toBeCloseTo(1.0101, 3);
    expect(r.return5d).toBeNull();
    expect(r.return20d).toBeNull();
  });

  it('computes the session range as a percentage of the low', () => {
    const r = computeReturns([105], 110, 100);
    expect(r.rangePct).toBeCloseTo(10, 10);
  });

  it('withholds the range when high or low is missing', () => {
    expect(computeReturns([105], null, 100).rangePct).toBeNull();
    expect(computeReturns([105], 110, null).rangePct).toBeNull();
  });
});

describe('volatility', () => {
  it('is zero for a perfectly flat series', () => {
    expect(dailyReturnVolatility([100, 100, 100, 100, 100])).toBeCloseTo(0, 10);
  });

  it('is null when there are too few observations', () => {
    expect(dailyReturnVolatility([100, 101])).toBeNull();
  });

  it('is larger for a more volatile series', () => {
    const calm = dailyReturnVolatility([100, 101, 100, 101, 100, 101]) as number;
    const wild = dailyReturnVolatility([100, 120, 90, 130, 85, 125]) as number;
    expect(wild).toBeGreaterThan(calm);
  });
});
