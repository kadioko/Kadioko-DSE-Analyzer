/**
 * Valuation multiples.
 *
 * Derives P/E, P/B, earnings yield, price/sales and dividend yield from a
 * close price and a set of reported financial figures.
 *
 * Two rules govern everything here, and both exist because a valuation
 * multiple is unusually easy to render misleading:
 *
 *  1. A multiple that is not meaningful is `null` with a stated reason, never a
 *     number. A negative P/E is not "cheap"; a negative book value does not
 *     make a share a bargain. Those cases produce no score at all.
 *
 *  2. Interim earnings are annualised by the issuer's own reporting cadence,
 *     and the result is LABELLED as annualised. A half-year profit compared
 *     against a full share price without annualising would double the apparent
 *     P/E, which is a much worse error than declining to publish one.
 */

import type { PeriodType } from './period';
import { periodsPerYear } from './period';

export const VALUATION_MODEL_VERSION = 'valuation-v1';

/** Machine-readable explanations for an absent or qualified multiple. */
export type ValuationNote =
  | 'NO_FUNDAMENTALS'
  | 'NEGATIVE_OR_ZERO_EPS'
  | 'NEGATIVE_OR_ZERO_BOOK_VALUE'
  | 'NO_DIVIDEND_DATA'
  | 'NO_SHARE_COUNT'
  | 'NO_PRICE'
  | 'NO_REVENUE'
  | 'ANNUALISED_FROM_INTERIM'
  | 'IMPLAUSIBLE_MULTIPLE_UNIT_MISMATCH'
  | 'REPORTING_CURRENCY_MISMATCH'
  | 'EPS_DERIVED_FROM_NET_INCOME'
  | 'BOOK_VALUE_DERIVED_FROM_EQUITY'
  | 'SPLIT_BETWEEN_PERIOD_AND_PRICE';

export const VALUATION_NOTE_LABELS: Record<ValuationNote, string> = {
  NO_FUNDAMENTALS:
    'No published financial results are on file, so no multiple can be computed.',
  NEGATIVE_OR_ZERO_EPS:
    'Earnings per share are zero or negative, so a price/earnings ratio is not meaningful. A negative P/E is not a cheap valuation.',
  NEGATIVE_OR_ZERO_BOOK_VALUE:
    'Book value per share is zero or negative, so a price/book ratio is not meaningful.',
  SPLIT_BETWEEN_PERIOD_AND_PRICE:
    'A share split or bonus issue took effect after these results were reported, so their per-share figures are on a different share count from today’s price. Any multiple mixing the two would be wrong by the split ratio, so none is published.',
  NO_DIVIDEND_DATA:
    'No dividend per share is on file, so dividend yield cannot be computed. This is an absence of data, not a dividend of zero.',
  NO_SHARE_COUNT:
    'Shares outstanding are unknown, so per-share figures cannot be derived.',
  NO_PRICE: 'No closing price is available for this date.',
  NO_REVENUE: 'No revenue figure is on file, so price/sales cannot be computed.',
  REPORTING_CURRENCY_MISMATCH:
    'This security is cross-listed and reports its financial statements in a different currency from the one it trades in. Per-share multiples would be wrong by the exchange rate, and no FX series is held, so they are withheld rather than computed.',
  IMPLAUSIBLE_MULTIPLE_UNIT_MISMATCH:
    'The computed multiple is far outside any plausible range, which almost always means the financial statements are reported in a different unit (thousands or millions) from the share price and share count. The multiple is withheld rather than published, and the source figures need checking.',
  ANNUALISED_FROM_INTERIM:
    'Earnings come from an interim period and have been annualised by the issuer reporting cadence. This assumes the remaining periods resemble the reported one.',
  EPS_DERIVED_FROM_NET_INCOME:
    'Earnings per share were derived as net income divided by shares outstanding, because the issuer did not report a per-share figure.',
  BOOK_VALUE_DERIVED_FROM_EQUITY:
    'Book value per share was derived as total equity divided by shares outstanding.',
};

/**
 * Bounds beyond which a multiple is treated as a unit error rather than a
 * valuation.
 *
 * No listed equity trades at 500x earnings or 100x book value in any normal
 * market. When statements are filed in thousands while price and share count
 * are absolute, the derived multiple inflates by roughly 1,000x, landing far
 * outside these bounds. Withholding is the honest response: the platform does
 * not silently rescale figures it cannot verify, and it does not publish a
 * number it can tell is wrong.
 */
export const PLAUSIBILITY_BOUNDS = {
  maxPeRatio: 500,
  maxPbRatio: 100,
  maxPriceToSales: 100,
} as const;

export interface ValuationInput {
  closePrice: number | null;
  sharesOutstanding: number | null;
  marketCapTzs: number | null;

  /**
   * Cumulative share-count multiplier from splits and bonus issues that took
   * effect AFTER the reporting period and on or before the valuation date.
   * 1 (or null) means nothing intervened.
   */
  splitFactorSincePeriod?: number | null;

  /** Reported per-share figures, when the issuer published them. */
  eps: number | null;
  dps: number | null;
  bookValuePerShare: number | null;

  /** Statement totals, used to derive per-share figures when absent. */
  netIncome: number | null;
  totalEquity: number | null;
  revenue: number | null;
  totalDebt: number | null;
  cashAndEquivalents: number | null;

  /** Drives annualisation of interim earnings. */
  periodType: PeriodType | null;

  /**
   * True when the statements are denominated in a currency other than the
   * trading currency. No multiple is computed in that case.
   */
  foreignReportingCurrency?: boolean;

  /**
   * True when `dps` is already a trailing twelve-month total (summed from
   * declared dividends) and must NOT be annualised again.
   */
  dividendIsTrailingTwelveMonths?: boolean;
}

export interface ValuationResult {
  peRatio: number | null;
  pbRatio: number | null;
  priceToSales: number | null;
  earningsYield: number | null;
  dividendYield: number | null;
  enterpriseValueTzs: number | null;
  evToSales: number | null;

  /** The per-share figures actually used, so a reader can check the maths. */
  epsUsed: number | null;
  epsAnnualised: number | null;
  bookValuePerShareUsed: number | null;

  notes: ValuationNote[];
  modelVersion: string;
}

/**
 * Computes every multiple that the supplied data supports.
 *
 * Derivation is preferred over omission, but only where the arithmetic is
 * unambiguous: EPS from net income and share count is a definition, not an
 * estimate. Annualisation, which IS an assumption, is always flagged.
 */
export function computeValuation(input: ValuationInput): ValuationResult {
  const notes: ValuationNote[] = [];

  const empty: ValuationResult = {
    peRatio: null,
    pbRatio: null,
    priceToSales: null,
    earningsYield: null,
    dividendYield: null,
    enterpriseValueTzs: null,
    evToSales: null,
    epsUsed: null,
    epsAnnualised: null,
    bookValuePerShareUsed: null,
    notes,
    modelVersion: VALUATION_MODEL_VERSION,
  };

  const price = input.closePrice;
  if (price === null || price <= 0) {
    notes.push('NO_PRICE');
    return empty;
  }

  // A TZS market capitalisation over a KES book value is not a price/book
  // ratio, it is a currency error. Without an FX series this cannot be fixed,
  // so nothing is published.
  if (input.foreignReportingCurrency) {
    notes.push('REPORTING_CURRENCY_MISMATCH');
    return empty;
  }

  // A split rebases the share count, so per-share figures reported before it
  // are not on the same basis as a price quoted after it. NMB's 1-for-10 split
  // on 24 August 2026 is the worked example: EPS of 811.53 against a post-split
  // price of 1,850 gives a P/E of 2.3 when the truth is nearer 22.8.
  //
  // Rebasing them correctly needs a point-in-time share count for every figure,
  // which is a larger piece of work. Until that exists, nothing is published,
  // because a multiple wrong by the split ratio is far worse than a dash.
  const splitFactor = input.splitFactorSincePeriod ?? 1;
  if (splitFactor !== 1 && splitFactor > 0) {
    notes.push('SPLIT_BETWEEN_PERIOD_AND_PRICE');
    return empty;
  }

  const shares =
    input.sharesOutstanding !== null && input.sharesOutstanding > 0
      ? input.sharesOutstanding
      : null;

  /* -- Per-share earnings --------------------------------------------------- */
  let eps = input.eps;
  if (eps === null && input.netIncome !== null && shares !== null) {
    eps = input.netIncome / shares;
    notes.push('EPS_DERIVED_FROM_NET_INCOME');
  }
  if (eps === null && input.netIncome !== null && shares === null) {
    notes.push('NO_SHARE_COUNT');
  }

  // Annualise interim earnings by the issuer's own cadence, and say so.
  const factor = periodsPerYear(input.periodType);
  let epsAnnualised = eps;
  if (eps !== null && factor > 1) {
    epsAnnualised = eps * factor;
    notes.push('ANNUALISED_FROM_INTERIM');
  }

  /* -- Per-share book value ------------------------------------------------- */
  let bvps = input.bookValuePerShare;
  if (bvps === null && input.totalEquity !== null && shares !== null) {
    bvps = input.totalEquity / shares;
    notes.push('BOOK_VALUE_DERIVED_FROM_EQUITY');
  }

  /* -- Multiples ------------------------------------------------------------ */
  let peRatio: number | null = null;
  let earningsYield: number | null = null;
  if (epsAnnualised === null) {
    if (!notes.includes('NO_SHARE_COUNT')) notes.push('NO_FUNDAMENTALS');
  } else if (epsAnnualised <= 0) {
    // Deliberately not published. A negative multiple would sort as "cheap".
    notes.push('NEGATIVE_OR_ZERO_EPS');
  } else {
    const candidate = price / epsAnnualised;
    if (candidate > PLAUSIBILITY_BOUNDS.maxPeRatio) {
      notes.push('IMPLAUSIBLE_MULTIPLE_UNIT_MISMATCH');
    } else {
      peRatio = candidate;
      earningsYield = (epsAnnualised / price) * 100;
    }
  }

  let pbRatio: number | null = null;
  if (bvps !== null) {
    if (bvps <= 0) {
      notes.push('NEGATIVE_OR_ZERO_BOOK_VALUE');
    } else {
      const candidate = price / bvps;
      if (candidate > PLAUSIBILITY_BOUNDS.maxPbRatio) {
        notes.push('IMPLAUSIBLE_MULTIPLE_UNIT_MISMATCH');
      } else {
        pbRatio = candidate;
      }
    }
  }

  /* -- Dividend ------------------------------------------------------------- */
  let dividendYield: number | null = null;
  if (input.dps === null) {
    notes.push('NO_DIVIDEND_DATA');
  } else if (input.dps >= 0) {
    // A reported zero dividend IS a real observation and yields 0%.
    // A trailing-twelve-month total is already annual; annualising it again
    // would double or quadruple the yield.
    const annualDps =
      input.dividendIsTrailingTwelveMonths || factor === 1
        ? input.dps
        : input.dps * factor;
    dividendYield = (annualDps / price) * 100;
  }

  /* -- Sales-based ---------------------------------------------------------- */
  const marketCap =
    input.marketCapTzs ?? (shares !== null ? price * shares : null);

  const annualRevenue =
    input.revenue !== null && factor > 1 ? input.revenue * factor : input.revenue;

  let priceToSales: number | null = null;
  if (annualRevenue === null) {
    notes.push('NO_REVENUE');
  } else if (annualRevenue > 0 && marketCap !== null) {
    const candidate = marketCap / annualRevenue;
    if (candidate > PLAUSIBILITY_BOUNDS.maxPriceToSales) {
      notes.push('IMPLAUSIBLE_MULTIPLE_UNIT_MISMATCH');
    } else {
      priceToSales = candidate;
    }
  }

  /* -- Enterprise value ----------------------------------------------------- */
  let enterpriseValueTzs: number | null = null;
  let evToSales: number | null = null;
  if (marketCap !== null && input.totalDebt !== null) {
    enterpriseValueTzs =
      marketCap + input.totalDebt - (input.cashAndEquivalents ?? 0);
    if (annualRevenue !== null && annualRevenue > 0) {
      evToSales = enterpriseValueTzs / annualRevenue;
    }
  }

  return {
    peRatio,
    pbRatio,
    priceToSales,
    earningsYield,
    dividendYield,
    enterpriseValueTzs,
    evToSales,
    epsUsed: eps,
    epsAnnualised,
    bookValuePerShareUsed: bvps,
    // De-duplicated: a note explains a condition once.
    notes: [...new Set(notes)],
    modelVersion: VALUATION_MODEL_VERSION,
  };
}
