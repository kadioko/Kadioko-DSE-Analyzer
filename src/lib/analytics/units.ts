/**
 * Reporting-scale detection for financial statements.
 *
 * DSE issuers file in inconsistent units: some report absolute TZS, most report
 * thousands, occasionally millions. Ratios (ROE, margins, growth) are immune
 * because the scale cancels. Per-share figures are not: dividing a
 * thousands-denominated profit by an absolute share count understates EPS
 * roughly a thousandfold and inflates the P/E by the same factor.
 *
 * The rule this module follows: a scale is ACCEPTED only when exactly one
 * candidate produces a plausible result. If none fit, or several do, the scale
 * is left undetermined and the figures are stored exactly as reported. Guessing
 * between two plausible scales would silently move a company's earnings by a
 * factor of a thousand, which is far worse than declining to decide.
 *
 * A declared scale from the source always wins over inference.
 */

/** Multipliers that convert a reported figure to absolute currency units. */
export const CANDIDATE_SCALES = [1, 1_000, 1_000_000] as const;

export type ScaleSource =
  | 'DECLARED'
  | 'INFERRED'
  | 'UNDETERMINED'
  | 'NOT_APPLICABLE';

/**
 * Plausible bands used to test a candidate scale.
 *
 * Deliberately wide. The purpose is to separate a correct scale from one that
 * is wrong by a factor of 1,000, not to judge whether a company is expensive.
 * A genuine P/B of 12 and a genuine P/B of 0.3 must both pass.
 */
export const PLAUSIBLE_BANDS = {
  priceToBookMin: 0.05,
  priceToBookMax: 30,
  priceToSalesMin: 0.02,
  priceToSalesMax: 40,
} as const;

export interface ScaleInferenceInput {
  /** Multiplier declared by the source, if any. */
  declaredScale?: number | null;
  sharesOutstanding: number | null;
  closePrice: number | null;
  totalEquity: number | null;
  revenue: number | null;
  /** Periods per year, so revenue is annualised before the price/sales test. */
  periodsPerYear?: number;
}

export interface ScaleInferenceResult {
  scale: number;
  source: ScaleSource;
  /** Scales that produced a plausible result. */
  plausible: number[];
  reason: string;
}

/**
 * Determines the multiplier that converts reported figures to absolute TZS.
 *
 * Tests each candidate against price/book and, when revenue exists,
 * price/sales. A candidate is plausible only if every available test passes.
 */
export function inferReportingScale(
  input: ScaleInferenceInput,
): ScaleInferenceResult {
  if (
    input.declaredScale !== null &&
    input.declaredScale !== undefined &&
    Number.isFinite(input.declaredScale) &&
    input.declaredScale > 0
  ) {
    return {
      scale: input.declaredScale,
      source: 'DECLARED',
      plausible: [input.declaredScale],
      reason: `The source declared a reporting scale of ${input.declaredScale.toLocaleString()}.`,
    };
  }

  const shares = input.sharesOutstanding;
  const price = input.closePrice;

  if (!shares || shares <= 0 || !price || price <= 0) {
    return {
      scale: 1,
      source: 'NOT_APPLICABLE',
      plausible: [],
      reason:
        'Shares outstanding or a close price is missing, so the reporting scale cannot be tested. Figures are stored exactly as reported.',
    };
  }

  const marketCap = shares * price;
  const factor = input.periodsPerYear ?? 1;
  const annualRevenue = input.revenue !== null ? input.revenue * factor : null;

  const hasEquity = input.totalEquity !== null && input.totalEquity > 0;
  const hasRevenue = annualRevenue !== null && annualRevenue > 0;

  const passesBook = (scale: number) => {
    const pb = marketCap / ((input.totalEquity as number) * scale);
    return (
      pb >= PLAUSIBLE_BANDS.priceToBookMin &&
      pb <= PLAUSIBLE_BANDS.priceToBookMax
    );
  };

  const passesSales = (scale: number) => {
    const ps = marketCap / ((annualRevenue as number) * scale);
    return (
      ps >= PLAUSIBLE_BANDS.priceToSalesMin &&
      ps <= PLAUSIBLE_BANDS.priceToSalesMax
    );
  };

  /*
   * Book value is the primary test and revenue is only a tie-breaker.
   *
   * Equity is a balance-sheet total that scales cleanly against market
   * capitalisation for any issuer. "Revenue" for a bank is total interest and
   * fee income, against which a price/sales ratio carries little meaning — a
   * perfectly normal bank can sit at 25x. Letting that veto a scale which book
   * value accepts would reject the correct answer, which is precisely what an
   * earlier version of this function did.
   */
  let plausible: number[] = [];

  if (hasEquity) {
    plausible = CANDIDATE_SCALES.filter(passesBook);
    // Narrow with revenue only when book value alone leaves it ambiguous.
    if (plausible.length > 1 && hasRevenue) {
      const narrowed = plausible.filter(passesSales);
      if (narrowed.length === 1) plausible = narrowed;
    }
  } else if (hasRevenue) {
    plausible = CANDIDATE_SCALES.filter(passesSales);
  }

  if (plausible.length === 1) {
    const scale = plausible[0] as number;
    return {
      scale,
      source: 'INFERRED',
      plausible,
      reason:
        scale === 1
          ? 'Reported figures are already in absolute currency units.'
          : `Figures appear to be reported in ${scale === 1_000 ? 'thousands' : 'millions'}: only that scale places price/book and price/sales in a plausible range.`,
    };
  }

  return {
    scale: 1,
    source: 'UNDETERMINED',
    plausible,
    reason:
      plausible.length === 0
        ? 'No candidate scale produced a plausible price/book or price/sales ratio. Figures are stored exactly as reported and per-share metrics are withheld.'
        : `More than one scale (${plausible.map((s) => s.toLocaleString()).join(', ')}) is plausible, so the scale is ambiguous. Figures are stored exactly as reported rather than guessed.`,
  };
}

/**
 * Applies a scale to a reported monetary figure.
 * Ratios, per-share figures and percentages must NOT be passed through here.
 */
export function applyScale(
  value: number | null,
  scale: number,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value * scale;
}

/** Parses a scale declared in a CSV: a multiplier or a word. */
export function parseDeclaredScale(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }

  let text = String(raw).trim().toLowerCase();
  if (text === '') return null;

  // Statements rarely write the bare unit. They write "in TZS'000", "Figures in
  // thousands of shillings", "Amounts are stated in TZS millions". Strip the
  // framing and the currency, and what remains is the unit itself.
  text = text
    // Curly apostrophes and full stops both appear in TZS.000 / TZS’000.
    .replace(/[.‘’ʼ']/g, "'")
    .replace(
      /^(all\s+)?(amounts?|figures?|values?|numbers?)\s+(are\s+)?(stated|expressed|shown|presented|reported)?\s*/,
      '',
    )
    .replace(/^in\s+/, '')
    .replace(/\s*of\s+(tanzanian\s+)?(shillings?|tzs|tsh|shs?)\b/g, '')
    .replace(/\b(tzs|tsh|shs?|shillings?)\b/g, ' ')
    .replace(/[,\s]+/g, ' ')
    .trim();

  const words: Record<string, number> = {
    // Everything was framing: "in TZS" alone means absolute figures.
    '': 1,
    absolute: 1,
    unit: 1,
    units: 1,
    one: 1,
    ones: 1,
    actual: 1,
    actuals: 1,
    full: 1,
    thousand: 1_000,
    thousands: 1_000,
    "'000": 1_000,
    '000': 1_000,
    k: 1_000,
    million: 1_000_000,
    millions: 1_000_000,
    "'000'000": 1_000_000,
    "'000000": 1_000_000,
    '000000': 1_000_000,
    m: 1_000_000,
    mn: 1_000_000,
    mio: 1_000_000,
  };
  if (text in words) return words[text] as number;

  // A bare number is taken at face value: "1000" means figures are in thousands.
  const numeric = Number(text.replace(/['\s]/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export const SCALE_SOURCE_LABELS: Record<ScaleSource, string> = {
  DECLARED: 'Declared by the source file.',
  INFERRED:
    'Inferred from the reported figures: exactly one scale placed price/book and price/sales in a plausible range.',
  UNDETERMINED:
    'Could not be determined. Figures are stored exactly as reported, and per-share metrics derived from them are withheld.',
  NOT_APPLICABLE:
    'Not testable: shares outstanding or a close price was unavailable.',
};
