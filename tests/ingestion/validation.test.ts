import { describe, expect, it } from 'vitest';
import {
  checkQuality,
  hasBlockingIssue,
  normalizedMarketRecordSchema,
} from '@/lib/validation/market-record';
import type { NormalizedMarketRecord } from '@/lib/types/market';
import { CRDB_FIXTURE } from '../fixtures/dse-2026-08-11';

const TODAY = new Date('2026-08-13T00:00:00Z');
const KNOWN = new Set(['CRDB', 'NMB']);

const record = (
  overrides: Partial<NormalizedMarketRecord> = {},
): NormalizedMarketRecord => ({
  symbol: 'CRDB',
  tradingDate: '2026-08-11',
  open: null,
  previousClose: 2580,
  close: 2600,
  high: null,
  low: null,
  changePct: null,
  turnoverTzs: 1000,
  deals: 10,
  volume: 100,
  outstandingBidQty: 500,
  outstandingOfferQty: 200,
  marketCapTzs: 1_000_000_000,
  sourceTimestamp: null,
  ...overrides,
});

const codes = (r: NormalizedMarketRecord, ctx = {}) =>
  checkQuality(r, { knownSymbols: KNOWN, today: TODAY, ...ctx }).map((i) => i.code);

describe('shape validation', () => {
  it('accepts the CRDB fixture', () => {
    expect(normalizedMarketRecordSchema.safeParse(CRDB_FIXTURE).success).toBe(true);
  });

  it('rejects negative prices, volume and turnover', () => {
    expect(normalizedMarketRecordSchema.safeParse(record({ close: -1 })).success).toBe(false);
    expect(normalizedMarketRecordSchema.safeParse(record({ volume: -5 })).success).toBe(false);
    expect(normalizedMarketRecordSchema.safeParse(record({ turnoverTzs: -100 })).success).toBe(false);
    expect(normalizedMarketRecordSchema.safeParse(record({ outstandingBidQty: -1 })).success).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(normalizedMarketRecordSchema.safeParse(record({ tradingDate: '11/08/2026' })).success).toBe(false);
  });

  it('rejects an empty or malformed symbol', () => {
    expect(normalizedMarketRecordSchema.safeParse(record({ symbol: '' })).success).toBe(false);
    expect(normalizedMarketRecordSchema.safeParse(record({ symbol: 'crdb bank' })).success).toBe(false);
  });

  it('allows a negative change percentage', () => {
    expect(normalizedMarketRecordSchema.safeParse(record({ changePct: -3.2 })).success).toBe(true);
  });
});

describe('errors that block storage', () => {
  it('rejects an unknown symbol', () => {
    expect(codes(record({ symbol: 'NOPE' }))).toContain('UNKNOWN_SYMBOL');
    expect(hasBlockingIssue(checkQuality(record({ symbol: 'NOPE' }), {
      knownSymbols: KNOWN, today: TODAY,
    }))).toBe(true);
  });

  it('rejects a future trading date', () => {
    expect(codes(record({ tradingDate: '2027-01-04' }))).toContain('FUTURE_TRADING_DATE');
  });

  it('rejects an implausibly old trading date', () => {
    expect(codes(record({ tradingDate: '1990-01-02' }))).toContain('IMPLAUSIBLE_TRADING_DATE');
  });

  it('rejects high below low', () => {
    expect(codes(record({ high: 100, low: 200 }))).toContain('HIGH_BELOW_LOW');
  });

  it('rejects a close outside the session range', () => {
    expect(codes(record({ close: 300, high: 200, low: 100 }))).toContain('CLOSE_OUTSIDE_HIGH_LOW');
    expect(codes(record({ close: 50, high: 200, low: 100 }))).toContain('CLOSE_OUTSIDE_HIGH_LOW');
  });

  it('rejects an open outside the session range', () => {
    expect(codes(record({ open: 300, close: 150, high: 200, low: 100 }))).toContain('OPEN_OUTSIDE_HIGH_LOW');
  });

  it('rejects a row with no price at all', () => {
    expect(codes(record({ close: null, previousClose: null }))).toContain('MISSING_PRICE');
  });

  it('accepts a clean row with no blocking issues', () => {
    const issues = checkQuality(record({ marketCapTzs: 1e9 }), {
      knownSymbols: KNOWN,
      today: TODAY,
    });
    expect(hasBlockingIssue(issues)).toBe(false);
  });
});

describe('warnings that are stored but flagged', () => {
  it('warns on a weekend trading date', () => {
    // 2026-08-08 is a Saturday.
    expect(codes(record({ tradingDate: '2026-08-08' }))).toContain('WEEKEND_TRADING_DATE');
  });

  it('warns when volume is reported with no turnover', () => {
    expect(codes(record({ volume: 100, turnoverTzs: 0 }))).toContain('VOLUME_WITHOUT_TURNOVER');
  });

  it('warns when turnover is reported with no volume', () => {
    expect(codes(record({ volume: 0, turnoverTzs: 5000 }))).toContain('TURNOVER_WITHOUT_VOLUME');
  });

  it('warns when the implied average price is outside the session range', () => {
    // 1,000,000 turnover over 100 shares implies 10,000 against a 100-200 range.
    const found = codes(record({
      turnoverTzs: 1_000_000, volume: 100, high: 200, low: 100, close: 150,
    }));
    expect(found).toContain('IMPLIED_PRICE_OUT_OF_RANGE');
  });

  it('warns on an extreme price movement without rejecting it', () => {
    // A 40% move can be genuine - a corporate action, a thin counter - so it is
    // flagged for a human rather than discarded.
    const r = record({ close: 3612, previousClose: 2580 });
    expect(codes(r)).toContain('EXTREME_PRICE_MOVEMENT');
    expect(hasBlockingIssue(checkQuality(r, { knownSymbols: KNOWN, today: TODAY }))).toBe(false);
  });

  it('warns when a reported change disagrees with the prices in the same row', () => {
    expect(codes(record({ close: 2600, previousClose: 2580, changePct: 5 })))
      .toContain('CHANGE_PCT_MISMATCH');
  });

  it('accepts a reported change that agrees with the prices', () => {
    expect(codes(record({ close: 2600, previousClose: 2580, changePct: 0.775 })))
      .not.toContain('CHANGE_PCT_MISMATCH');
  });

  it('warns when market cap disagrees with close x shares outstanding', () => {
    const found = codes(record({ close: 2600, marketCapTzs: 1_000_000_000 }), {
      sharesOutstanding: new Map([['CRDB', 2_612_000_000]]),
    });
    expect(found).toContain('MARKET_CAP_ANOMALY');
  });

  it('does not warn when market cap agrees with shares outstanding', () => {
    const shares = 2_612_000_000;
    const found = codes(record({ close: 2600, marketCapTzs: 2600 * shares }), {
      sharesOutstanding: new Map([['CRDB', shares]]),
    });
    expect(found).not.toContain('MARKET_CAP_ANOMALY');
  });

  it('warns when market cap is absent', () => {
    expect(codes(record({ marketCapTzs: null }))).toContain('MISSING_MARKET_CAP');
  });

  it('warns on a zero close', () => {
    expect(codes(record({ close: 0, high: 0, low: 0 }))).toContain('ZERO_CLOSE');
  });
});

describe('every issue carries an actionable message', () => {
  it('produces a code, a severity and a human-readable message', () => {
    const issues = checkQuality(
      record({ symbol: 'NOPE', close: 300, high: 200, low: 100 }),
      { knownSymbols: KNOWN, today: TODAY },
    );
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.code).toMatch(/^[A-Z_]+$/);
      expect(['ERROR', 'WARNING']).toContain(issue.severity);
      expect(issue.message.length).toBeGreaterThan(15);
    }
  });
});
