import { describe, expect, it } from 'vitest';
import { runScanner, type SignalCode } from '@/lib/analytics/scanner';
import { SCANNER_THRESHOLDS as T } from '@/lib/analytics/config';
import type { MarketRow } from '@/lib/types/market';

const row = (overrides: Partial<MarketRow> & { symbol: string }): MarketRow => ({
  instrumentId: `id-${overrides.symbol}`,
  name: `${overrides.symbol} Plc`,
  sector: 'Test',
  tradingDate: '2026-08-11',
  close: 1000,
  previousClose: 1000,
  changePct: 0,
  turnoverTzs: 10_000_000,
  volume: 10_000,
  deals: 20,
  bidQty: 1000,
  offerQty: 1000,
  marketCapTzs: 1e11,
  boRatio: 1,
  boState: 'NORMAL',
  boMomentumPct: null,
  volumeRatio: null,
  pressureScore: 50,
  pressureSignal: 'BALANCED',
  liquidityScore: 50,
  opportunityScore: null,
  dataConfidenceScore: 80,
  ...overrides,
});

const symbolsIn = (groups: ReturnType<typeof runScanner>, code: SignalCode) =>
  groups.find((g) => g.code === code)?.matches.map((m) => m.row.symbol) ?? [];

describe('scanner rules', () => {
  it('flags B/O acceleration at or above the threshold', () => {
    const groups = runScanner([
      row({ symbol: 'FAST', boMomentumPct: T.boAccelerationPct }),
      row({ symbol: 'SLOW', boMomentumPct: T.boAccelerationPct - 0.1 }),
    ]);
    expect(symbolsIn(groups, 'BO_ACCELERATION')).toEqual(['FAST']);
  });

  it('flags B/O deterioration at or below the threshold', () => {
    const groups = runScanner([
      row({ symbol: 'DROP', boMomentumPct: T.boDeteriorationPct }),
      row({ symbol: 'MILD', boMomentumPct: T.boDeteriorationPct + 0.1 }),
    ]);
    expect(symbolsIn(groups, 'BO_DETERIORATION')).toEqual(['DROP']);
  });

  it('flags unusual volume only when the ratio is known', () => {
    const groups = runScanner([
      row({ symbol: 'BUSY', volumeRatio: T.unusualVolumeRatio }),
      row({ symbol: 'QUIET', volumeRatio: 1.1 }),
      // Null ratio means the 20-day window had too little history. A missing
      // value must never be treated as satisfying a threshold.
      row({ symbol: 'NEW', volumeRatio: null }),
    ]);
    expect(symbolsIn(groups, 'UNUSUAL_VOLUME')).toEqual(['BUSY']);
  });

  it('never matches a rule on a null input', () => {
    const groups = runScanner([
      row({ symbol: 'EMPTY', boMomentumPct: null, volumeRatio: null, changePct: null }),
    ]);
    for (const group of groups) {
      expect(group.matches).toHaveLength(0);
    }
  });

  it('uses the supplied 5-day returns for price momentum', () => {
    const rows = [row({ symbol: 'UP' }), row({ symbol: 'DOWN' })];
    const returns = new Map([
      ['id-UP', T.momentumReturnPct + 1],
      ['id-DOWN', -T.momentumReturnPct - 1],
    ]);
    const groups = runScanner(rows, returns);
    expect(symbolsIn(groups, 'POSITIVE_MOMENTUM')).toEqual(['UP']);
    expect(symbolsIn(groups, 'NEGATIVE_MOMENTUM')).toEqual(['DOWN']);
  });
});

describe('reversal rules require all three conditions', () => {
  const base = {
    changePct: -(T.reversalReturnPct + 1),
    boMomentumPct: T.reversalBoPct + 10,
    volumeRatio: T.reversalVolumeRatio + 0.2,
  };

  it('matches when price falls, the book strengthens and volume confirms', () => {
    const groups = runScanner([row({ symbol: 'REV', ...base })]);
    expect(symbolsIn(groups, 'POSSIBLE_UPWARD_REVERSAL')).toEqual(['REV']);
  });

  it('does not match on price action alone', () => {
    const groups = runScanner([
      row({ symbol: 'PRICE_ONLY', changePct: base.changePct, boMomentumPct: 0, volumeRatio: 2 }),
    ]);
    expect(symbolsIn(groups, 'POSSIBLE_UPWARD_REVERSAL')).toEqual([]);
  });

  it('does not match without volume confirmation', () => {
    const groups = runScanner([
      row({ symbol: 'THIN', ...base, volumeRatio: T.reversalVolumeRatio - 0.1 }),
    ]);
    expect(symbolsIn(groups, 'POSSIBLE_UPWARD_REVERSAL')).toEqual([]);
  });

  it('does not match when price and book agree', () => {
    // Price down AND book weakening is a continuation, not a reversal.
    const groups = runScanner([
      row({ symbol: 'CONT', changePct: base.changePct, boMomentumPct: -80, volumeRatio: 2 }),
    ]);
    expect(symbolsIn(groups, 'POSSIBLE_UPWARD_REVERSAL')).toEqual([]);
    expect(symbolsIn(groups, 'POSSIBLE_DOWNWARD_REVERSAL')).toEqual([]);
  });

  it('detects the downward case symmetrically', () => {
    const groups = runScanner([
      row({
        symbol: 'DOWN_REV',
        changePct: T.reversalReturnPct + 1,
        boMomentumPct: -(T.reversalBoPct + 10),
        volumeRatio: T.reversalVolumeRatio + 0.2,
      }),
    ]);
    expect(symbolsIn(groups, 'POSSIBLE_DOWNWARD_REVERSAL')).toEqual(['DOWN_REV']);
  });
});

describe('scanner output', () => {
  it('states a rule and attaches evidence to every match', () => {
    const groups = runScanner([row({ symbol: 'X', boMomentumPct: 90, volumeRatio: 3 })]);
    for (const group of groups) {
      expect(group.rule.length).toBeGreaterThan(20);
      for (const match of group.matches) {
        expect(match.evidence.length).toBeGreaterThan(0);
        for (const e of match.evidence) {
          expect(e.label).toBeTruthy();
          expect(e.value).toBeTruthy();
        }
      }
    }
  });
});
