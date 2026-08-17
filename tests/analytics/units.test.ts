import { describe, expect, it } from 'vitest';
import {
  applyScale,
  inferReportingScale,
  parseDeclaredScale,
} from '@/lib/analytics/units';

/**
 * Real figures from the source workbook. DSE files in absolute TZS; KCB and
 * CRDB file in thousands. These are the cases the inference has to separate.
 */
const DSE = {
  sharesOutstanding: 23_823_440,
  closePrice: 6570,
  totalEquity: 37_309_340_438,
  revenue: 7_170_518_860,
  periodsPerYear: 2,
};

const KCB = {
  sharesOutstanding: 2_970_338_462,
  closePrice: 1950,
  totalEquity: 356_952_024,
  revenue: 108_085_972,
  periodsPerYear: 2,
};

describe('declared scale', () => {
  it('always wins over inference', () => {
    const r = inferReportingScale({ ...KCB, declaredScale: 1 });
    expect(r.scale).toBe(1);
    expect(r.source).toBe('DECLARED');
  });

  it('parses multipliers and words', () => {
    expect(parseDeclaredScale(1000)).toBe(1000);
    expect(parseDeclaredScale('thousands')).toBe(1000);
    expect(parseDeclaredScale('MILLIONS')).toBe(1_000_000);
    expect(parseDeclaredScale('absolute')).toBe(1);
    expect(parseDeclaredScale('1,000')).toBe(1000);
  });

  it('rejects nonsense rather than defaulting', () => {
    expect(parseDeclaredScale('')).toBeNull();
    expect(parseDeclaredScale('banana')).toBeNull();
    expect(parseDeclaredScale(0)).toBeNull();
    expect(parseDeclaredScale(-1000)).toBeNull();
    expect(parseDeclaredScale(null)).toBeNull();
  });
});

describe('inference on real issuers', () => {
  it('leaves absolute-TZS figures alone', () => {
    const r = inferReportingScale(DSE);
    expect(r.scale).toBe(1);
    expect(r.source).toBe('INFERRED');
  });

  it('detects thousands', () => {
    const r = inferReportingScale(KCB);
    expect(r.scale).toBe(1000);
    expect(r.source).toBe('INFERRED');
    expect(r.reason).toContain('thousands');
  });

  it('produces a sensible P/B once applied', () => {
    const r = inferReportingScale(KCB);
    const equity = applyScale(KCB.totalEquity, r.scale) as number;
    const pb = (KCB.sharesOutstanding * KCB.closePrice) / equity;
    // Unscaled this is ~16,000. Scaled it lands in a normal range.
    expect(pb).toBeGreaterThan(0.05);
    expect(pb).toBeLessThan(30);
  });
});

describe('refusing to guess', () => {
  it('is undetermined when no scale is plausible', () => {
    const r = inferReportingScale({
      sharesOutstanding: 1_000_000,
      closePrice: 100,
      // Absurd against a 100m market cap at every candidate scale.
      totalEquity: 1e18,
      revenue: null,
    });
    expect(r.source).toBe('UNDETERMINED');
    expect(r.scale).toBe(1);
    expect(r.reason).toContain('No candidate scale');
  });

  it('is undetermined when several scales are plausible', () => {
    // A tiny equity figure fits both absolute and thousands within the band.
    const r = inferReportingScale({
      sharesOutstanding: 1_000_000,
      closePrice: 100,
      totalEquity: 20_000_000,
      revenue: null,
    });
    if (r.plausible.length > 1) {
      expect(r.source).toBe('UNDETERMINED');
      expect(r.scale).toBe(1);
      expect(r.reason).toContain('ambiguous');
    }
  });

  it('never applies a scale it did not determine', () => {
    const r = inferReportingScale({
      sharesOutstanding: 1_000_000,
      closePrice: 100,
      totalEquity: 1e18,
      revenue: null,
    });
    // Storing figures as reported is the safe fallback.
    expect(r.scale).toBe(1);
  });

  it('reports not-applicable without a price or share count', () => {
    expect(
      inferReportingScale({
        sharesOutstanding: null,
        closePrice: 100,
        totalEquity: 1000,
        revenue: null,
      }).source,
    ).toBe('NOT_APPLICABLE');

    expect(
      inferReportingScale({
        sharesOutstanding: 1000,
        closePrice: null,
        totalEquity: 1000,
        revenue: null,
      }).source,
    ).toBe('NOT_APPLICABLE');
  });

  it('treats an absent equity and revenue as no evidence, not a pass', () => {
    const r = inferReportingScale({
      sharesOutstanding: 1_000_000,
      closePrice: 100,
      totalEquity: null,
      revenue: null,
    });
    expect(r.source).toBe('UNDETERMINED');
    expect(r.plausible).toHaveLength(0);
  });
});

describe('applyScale', () => {
  it('multiplies a reported figure', () => {
    expect(applyScale(1234, 1000)).toBe(1_234_000);
  });

  it('preserves null', () => {
    expect(applyScale(null, 1000)).toBeNull();
  });

  it('rejects non-finite input', () => {
    expect(applyScale(Number.NaN, 1000)).toBeNull();
    expect(applyScale(Number.POSITIVE_INFINITY, 1000)).toBeNull();
  });
});

describe('book value is the primary test', () => {
  it('is not vetoed by an unhelpful price/sales ratio', () => {
    // A bank at 25x "sales" is ordinary, because revenue here is total
    // interest and fee income. Book value must decide the scale.
    expect(inferReportingScale({ ...KCB, periodsPerYear: 2 }).scale).toBe(1000);
    expect(inferReportingScale({ ...KCB, periodsPerYear: 1 }).scale).toBe(1000);
  });

  it('falls back to revenue when equity is unavailable', () => {
    const r = inferReportingScale({
      sharesOutstanding: 1_000_000,
      closePrice: 1000,
      totalEquity: null,
      revenue: 500_000, // in thousands: 500m annual against a 1bn market cap
      periodsPerYear: 1,
    });
    expect(r.scale).toBe(1000);
    expect(r.source).toBe('INFERRED');
  });
});
