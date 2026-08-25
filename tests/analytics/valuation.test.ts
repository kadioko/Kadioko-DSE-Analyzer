import { describe, expect, it } from 'vitest';
import { computeValuation } from '@/lib/analytics/valuation';
import { isInterim, periodsPerYear } from '@/lib/analytics/period';
import { splitFactorSince } from '@/lib/services/corporate-actions-service';

const base = {
  closePrice: 100,
  sharesOutstanding: 1_000_000,
  marketCapTzs: 100_000_000,
  eps: null,
  dps: null,
  bookValuePerShare: null,
  netIncome: null,
  totalEquity: null,
  revenue: null,
  totalDebt: null,
  cashAndEquivalents: null,
  periodType: 'FY' as const,
};

describe('reporting periods', () => {
  it('knows how many periods make a year', () => {
    expect(periodsPerYear('FY')).toBe(1);
    expect(periodsPerYear('H1')).toBe(2);
    expect(periodsPerYear('Q3')).toBe(4);
  });

  it('does not guess for an unlabelled interim period', () => {
    // Could be a quarter or a half; multiplying by the wrong factor would be
    // worse than not annualising.
    expect(periodsPerYear('INTERIM')).toBe(1);
    expect(periodsPerYear(null)).toBe(1);
  });

  it('identifies part-year periods', () => {
    expect(isInterim('H1')).toBe(true);
    expect(isInterim('FY')).toBe(false);
  });
});

describe('price/earnings', () => {
  it('computes P/E from a reported full-year EPS', () => {
    const v = computeValuation({ ...base, eps: 10 });
    expect(v.peRatio).toBeCloseTo(10, 10);
    expect(v.earningsYield).toBeCloseTo(10, 10);
    expect(v.notes).not.toContain('ANNUALISED_FROM_INTERIM');
  });

  it('derives EPS from net income and shares, and says so', () => {
    const v = computeValuation({ ...base, netIncome: 10_000_000 });
    expect(v.epsUsed).toBeCloseTo(10, 10);
    expect(v.peRatio).toBeCloseTo(10, 10);
    expect(v.notes).toContain('EPS_DERIVED_FROM_NET_INCOME');
  });

  it('annualises interim earnings by the reporting cadence, and flags it', () => {
    // A half-year EPS of 5 annualises to 10, so P/E is 10, not 20.
    const v = computeValuation({ ...base, eps: 5, periodType: 'H1' });
    expect(v.epsAnnualised).toBeCloseTo(10, 10);
    expect(v.peRatio).toBeCloseTo(10, 10);
    expect(v.notes).toContain('ANNUALISED_FROM_INTERIM');
  });

  it('annualises quarterly earnings by four', () => {
    const v = computeValuation({ ...base, eps: 2.5, periodType: 'Q2' });
    expect(v.peRatio).toBeCloseTo(10, 10);
  });

  it('withholds P/E on negative earnings rather than showing a cheap-looking number', () => {
    const v = computeValuation({ ...base, eps: -4 });
    expect(v.peRatio).toBeNull();
    expect(v.earningsYield).toBeNull();
    expect(v.notes).toContain('NEGATIVE_OR_ZERO_EPS');
  });

  it('withholds P/E on zero earnings', () => {
    expect(computeValuation({ ...base, eps: 0 }).peRatio).toBeNull();
  });

  it('reports a missing share count rather than silently omitting EPS', () => {
    const v = computeValuation({
      ...base,
      sharesOutstanding: null,
      marketCapTzs: null,
      netIncome: 10_000_000,
    });
    expect(v.peRatio).toBeNull();
    expect(v.notes).toContain('NO_SHARE_COUNT');
  });
});

describe('price/book', () => {
  it('derives book value per share from equity', () => {
    const v = computeValuation({ ...base, totalEquity: 50_000_000 });
    expect(v.bookValuePerShareUsed).toBeCloseTo(50, 10);
    expect(v.pbRatio).toBeCloseTo(2, 10);
    expect(v.notes).toContain('BOOK_VALUE_DERIVED_FROM_EQUITY');
  });

  it('prefers a reported book value over a derived one', () => {
    const v = computeValuation({
      ...base,
      bookValuePerShare: 25,
      totalEquity: 50_000_000,
    });
    expect(v.pbRatio).toBeCloseTo(4, 10);
    expect(v.notes).not.toContain('BOOK_VALUE_DERIVED_FROM_EQUITY');
  });

  it('withholds P/B on negative book value', () => {
    const v = computeValuation({ ...base, totalEquity: -10_000_000 });
    expect(v.pbRatio).toBeNull();
    expect(v.notes).toContain('NEGATIVE_OR_ZERO_BOOK_VALUE');
  });

  it('does not annualise book value, which is a point-in-time figure', () => {
    const annual = computeValuation({ ...base, totalEquity: 50_000_000 });
    const interim = computeValuation({
      ...base,
      totalEquity: 50_000_000,
      periodType: 'H1',
    });
    expect(interim.pbRatio).toBeCloseTo(annual.pbRatio as number, 10);
  });
});

describe('dividend yield', () => {
  it('is null with a stated reason when no dividend is on file', () => {
    const v = computeValuation({ ...base, eps: 10 });
    expect(v.dividendYield).toBeNull();
    expect(v.notes).toContain('NO_DIVIDEND_DATA');
  });

  it('distinguishes a reported zero dividend from an absent one', () => {
    // A company that declared no dividend genuinely yields 0%.
    const declaredZero = computeValuation({ ...base, dps: 0 });
    expect(declaredZero.dividendYield).toBe(0);
    expect(declaredZero.notes).not.toContain('NO_DIVIDEND_DATA');
  });

  it('computes yield from a reported dividend', () => {
    expect(computeValuation({ ...base, dps: 5 }).dividendYield).toBeCloseTo(5, 10);
  });

  it('annualises an interim dividend', () => {
    const v = computeValuation({ ...base, dps: 2.5, periodType: 'H1' });
    expect(v.dividendYield).toBeCloseTo(5, 10);
  });
});

describe('sales and enterprise value', () => {
  it('computes price/sales against annualised revenue', () => {
    const v = computeValuation({
      ...base,
      revenue: 50_000_000,
      periodType: 'H1',
    });
    // 100m market cap over 100m annualised revenue.
    expect(v.priceToSales).toBeCloseTo(1, 10);
  });

  it('computes enterprise value as market cap plus debt less cash', () => {
    const v = computeValuation({
      ...base,
      totalDebt: 20_000_000,
      cashAndEquivalents: 5_000_000,
    });
    expect(v.enterpriseValueTzs).toBeCloseTo(115_000_000, 10);
  });

  it('reports missing revenue rather than assuming zero', () => {
    expect(computeValuation({ ...base }).notes).toContain('NO_REVENUE');
  });
});

describe('guards', () => {
  it('returns nothing at all without a price', () => {
    const v = computeValuation({ ...base, closePrice: null, eps: 10 });
    expect(v.peRatio).toBeNull();
    expect(v.pbRatio).toBeNull();
    expect(v.notes).toContain('NO_PRICE');
  });

  it('treats a zero price as unusable', () => {
    expect(computeValuation({ ...base, closePrice: 0, eps: 10 }).peRatio).toBeNull();
  });

  it('never repeats a note', () => {
    const v = computeValuation({
      ...base,
      netIncome: 10_000_000,
      totalEquity: 50_000_000,
      periodType: 'H1',
    });
    expect(new Set(v.notes).size).toBe(v.notes.length);
  });

  it('never emits a non-finite multiple', () => {
    const cases = [
      { ...base, eps: 1e-12 },
      { ...base, totalEquity: 1e-12 },
      { ...base, revenue: 1e-12 },
    ];
    for (const c of cases) {
      const v = computeValuation(c);
      for (const value of [v.peRatio, v.pbRatio, v.priceToSales, v.earningsYield]) {
        if (value !== null) expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe('plausibility bounds', () => {
  it('withholds a multiple that is certainly a unit error', () => {
    // Statements filed in thousands against an absolute price and share count
    // inflate the multiple by roughly 1,000x.
    const v = computeValuation({
      ...base,
      closePrice: 1950,
      sharesOutstanding: 2_970_338_462,
      netIncome: 36_866_109, // reported in thousands
      totalEquity: 356_952_024,
    });
    expect(v.peRatio).toBeNull();
    expect(v.pbRatio).toBeNull();
    expect(v.notes).toContain('IMPLAUSIBLE_MULTIPLE_UNIT_MISMATCH');
  });

  it('publishes a multiple from consistently scaled figures', () => {
    // Same issuer shape, but statements in absolute TZS.
    const v = computeValuation({
      ...base,
      closePrice: 6570,
      sharesOutstanding: 23_823_440,
      netIncome: 2_966_447_082,
      totalEquity: 37_309_340_438,
      periodType: 'H1',
    });
    expect(v.peRatio).not.toBeNull();
    expect(v.peRatio as number).toBeCloseTo(26.38, 1);
    expect(v.notes).not.toContain('IMPLAUSIBLE_MULTIPLE_UNIT_MISMATCH');
  });

  it('does not rescale anything on its own', () => {
    // The engine never invents a scale factor: a withheld multiple stays null.
    const v = computeValuation({
      ...base,
      closePrice: 10_000,
      sharesOutstanding: 1_000_000_000,
      netIncome: 1_000,
    });
    expect(v.peRatio).toBeNull();
    expect(v.epsUsed).toBeCloseTo(0.000001, 10);
  });
});

describe('trailing twelve-month dividends', () => {
  it('does not annualise a figure that is already annual', () => {
    // Declared dividends summed over 12 months are already a yearly total.
    // Annualising an H1 period again would double the yield.
    const v = computeValuation({
      ...base,
      closePrice: 2700,
      dps: 65, // 45 final + 20 interim, both declared
      periodType: 'H1',
      dividendIsTrailingTwelveMonths: true,
    });
    expect(v.dividendYield).toBeCloseTo((65 / 2700) * 100, 6);
  });

  it('still annualises a per-period figure from the accounts', () => {
    const v = computeValuation({
      ...base,
      closePrice: 2700,
      dps: 65,
      periodType: 'H1',
      dividendIsTrailingTwelveMonths: false,
    });
    expect(v.dividendYield).toBeCloseTo((130 / 2700) * 100, 6);
  });

  it('withholds every multiple for a foreign-currency reporter', () => {
    // A TZS price over KES book value is a currency error, not a ratio.
    const v = computeValuation({
      ...base,
      netIncome: 10_000_000,
      totalEquity: 50_000_000,
      dps: 5,
      foreignReportingCurrency: true,
    });
    expect(v.peRatio).toBeNull();
    expect(v.pbRatio).toBeNull();
    expect(v.dividendYield).toBeNull();
    expect(v.notes).toContain('REPORTING_CURRENCY_MISMATCH');
  });
});

describe('splits between the reporting period and the price', () => {
  /*
   * NMB's 1-for-10 split, effective 24 August 2026, is the worked example.
   * Its June 2026 results report EPS of 811.53 on 500,000,000 shares. After the
   * split the price is 1,850 on 5,000,000,000 shares. Dividing one by the other
   * gives a P/E of 2.3 when the truth is nearer 22.8 - cheap-looking, and wrong
   * by exactly the split ratio.
   */
  it('withholds every multiple when a split intervened', () => {
    const v = computeValuation({
      ...base,
      closePrice: 1850,
      sharesOutstanding: 500_000_000,
      eps: 811.532,
      bookValuePerShare: 4000,
      splitFactorSincePeriod: 10,
    });

    expect(v.peRatio).toBeNull();
    expect(v.pbRatio).toBeNull();
    expect(v.notes).toContain('SPLIT_BETWEEN_PERIOD_AND_PRICE');
  });

  it('publishes normally when nothing intervened', () => {
    const withFactor = computeValuation({ ...base, eps: 10, splitFactorSincePeriod: 1 });
    const withNull = computeValuation({ ...base, eps: 10, splitFactorSincePeriod: null });
    const omitted = computeValuation({ ...base, eps: 10 });

    expect(withFactor.peRatio).toBeCloseTo(10, 10);
    expect(withNull.peRatio).toBeCloseTo(10, 10);
    expect(omitted.peRatio).toBeCloseTo(10, 10);
    expect(withFactor.notes).not.toContain('SPLIT_BETWEEN_PERIOD_AND_PRICE');
  });
});

describe('folding share-count events into a factor', () => {
  it('counts only events after the period end', () => {
    const events = [
      { effectiveDate: '2026-06-30', factor: 2 }, // on the period end: belongs to it
      { effectiveDate: '2026-08-24', factor: 10 },
    ];
    expect(splitFactorSince(events, '2026-06-30')).toBe(10);
  });

  it('compounds several events', () => {
    const events = [
      { effectiveDate: '2026-07-01', factor: 2 },
      { effectiveDate: '2026-08-24', factor: 10 },
    ];
    expect(splitFactorSince(events, '2026-06-30')).toBe(20);
  });

  it('is 1 when there is nothing to apply', () => {
    expect(splitFactorSince([], '2026-06-30')).toBe(1);
    expect(splitFactorSince(undefined, '2026-06-30')).toBe(1);
    // Without a period end there is no window, so nothing can be applied.
    expect(splitFactorSince([{ effectiveDate: '2026-08-24', factor: 10 }], null)).toBe(1);
  });
});
