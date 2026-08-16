/**
 * Fundamental scoring.
 *
 * Turns reported financial results (the `fundamentals` table) into a 0-100
 * score describing business quality. This is the 70% input to the Overall
 * ranking, and it is deliberately independent of price, order book and
 * sentiment: nothing about how a share is trading may enter this number.
 *
 * The rule that governs everything here: a pillar with no data is EXCLUDED and
 * the score renormalised over what remained, and `dataCompleteness` reports how
 * much of the model was actually covered. Below a floor, no score is produced
 * at all — an issuer with one reported figure does not get a fundamental score.
 *
 * Banking issuers are scored on banking-specific ratios where present. That is
 * a property of the DATA (the presence of NPL / capital adequacy figures), not
 * a branch keyed on a ticker symbol.
 */

import { clamp, scaleTo } from '@/lib/db/num';
import type { ScoreComponent } from '@/lib/types/market';

export const FUNDAMENTAL_METHODOLOGY_VERSION = 'fundamental-v1';

/**
 * Weights for the general (non-financial) model. Published on /methodology.
 */
export const FUNDAMENTAL_WEIGHTS = {
  /** Return on equity — how well capital is converted into profit. */
  profitability: 26,
  /** Net and gross margin — how much of revenue survives to the bottom line. */
  margins: 18,
  /** Revenue and earnings growth. */
  growth: 18,
  /** Leverage and balance-sheet strength. */
  balanceSheet: 16,
  /** Cash conversion — profit that is actually cash. */
  cashFlow: 12,
  /** Dividend track record. */
  shareholderReturn: 10,
} as const;

/**
 * Banking issuers replace `margins` and `cashFlow` with sector ratios that
 * actually describe a bank. Net margin on a bank is not comparable with net
 * margin on a brewer, and operating cash flow for a bank is dominated by
 * deposit flows rather than trading performance.
 */
export const BANKING_WEIGHTS = {
  profitability: 24,
  assetQuality: 20, // NPL ratio
  capitalStrength: 18, // capital adequacy / tier 1
  efficiency: 14, // cost-to-income
  growth: 14,
  shareholderReturn: 10,
} as const;

export const FUNDAMENTAL_THRESHOLDS = {
  roeMinPct: 0,
  roeMaxPct: 30,
  netMarginMinPct: 0,
  netMarginMaxPct: 30,
  grossMarginMinPct: 0,
  grossMarginMaxPct: 60,
  revenueGrowthMinPct: -10,
  revenueGrowthMaxPct: 25,
  epsGrowthMinPct: -25,
  epsGrowthMaxPct: 25,
  /** Debt/equity at or above this scores zero for balance-sheet strength. */
  debtToEquityMax: 3,
  /** Operating cash flow ÷ net income; 1.0 or better is healthy. */
  cashConversionMin: 0,
  cashConversionMax: 1.5,
  payoutMinPct: 0,
  payoutMaxPct: 70,
  /** Banking: lower NPL is better. */
  nplBestPct: 2,
  nplWorstPct: 15,
  /** Banking: Bank of Tanzania minimum total capital adequacy is 12%. */
  carMinPct: 12,
  carStrongPct: 22,
  /** Banking: lower cost-to-income is better. */
  costIncomeBestPct: 40,
  costIncomeWorstPct: 85,
  /** Below this coverage no fundamental score is published at all. */
  minCompleteness: 45,
} as const;

/** The subset of a fundamentals row this engine reads. */
export interface FundamentalInput {
  roePct: number | null;
  netMarginPct: number | null;
  grossMarginPct: number | null;
  debtToEquity: number | null;
  operatingCashFlow: number | null;
  netIncome: number | null;
  payoutRatioPct: number | null;
  dps: number | null;
  /** Period-on-period growth, computed against the prior comparable period. */
  revenueGrowthPct: number | null;
  epsGrowthPct: number | null;
  /** Banking-specific. Their presence is what selects the banking model. */
  nplRatioPct: number | null;
  capitalAdequacyPct: number | null;
  costToIncomePct: number | null;
}

export interface FundamentalScoreResult {
  /** Null when too little of the model had data. Never zero as a stand-in. */
  score: number | null;
  /** Percentage of model weight that had data behind it. */
  dataCompleteness: number;
  components: Record<string, ScoreComponent>;
  /** Which weighting was applied. */
  model: 'GENERAL' | 'BANKING';
  missing: string[];
  methodologyVersion: string;
}

function component(
  raw: number | null,
  weight: number,
  explanation: string,
): ScoreComponent {
  const available = raw !== null;
  return {
    raw,
    weight,
    contribution: available ? (clamp(raw, 0, 100) / 100) * weight : 0,
    explanation,
    available,
  };
}

/** Averages the sub-signals that exist; null when none do. */
function blend(parts: readonly (number | null)[]): number | null {
  const present = parts.filter((p): p is number => p !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

/**
 * True when the row carries banking-specific ratios.
 *
 * Selecting the model from the DATA rather than from a sector string means a
 * newly listed bank is handled correctly the moment its figures arrive, and
 * there is no per-symbol branch anywhere.
 */
export function isBankingProfile(input: FundamentalInput): boolean {
  return (
    input.nplRatioPct !== null ||
    input.capitalAdequacyPct !== null ||
    input.costToIncomePct !== null
  );
}

export function computeFundamentalScore(
  input: FundamentalInput,
): FundamentalScoreResult {
  const banking = isBankingProfile(input);
  const missing: string[] = [];

  const profitability =
    input.roePct === null
      ? null
      : scaleTo(
          input.roePct,
          FUNDAMENTAL_THRESHOLDS.roeMinPct,
          FUNDAMENTAL_THRESHOLDS.roeMaxPct,
          0,
          100,
        );
  if (profitability === null) missing.push('Return on equity');

  const growth = blend([
    input.revenueGrowthPct === null
      ? null
      : scaleTo(
          input.revenueGrowthPct,
          FUNDAMENTAL_THRESHOLDS.revenueGrowthMinPct,
          FUNDAMENTAL_THRESHOLDS.revenueGrowthMaxPct,
          0,
          100,
        ),
    input.epsGrowthPct === null
      ? null
      : scaleTo(
          input.epsGrowthPct,
          FUNDAMENTAL_THRESHOLDS.epsGrowthMinPct,
          FUNDAMENTAL_THRESHOLDS.epsGrowthMaxPct,
          0,
          100,
        ),
  ]);
  if (growth === null) missing.push('Growth');

  const shareholderReturn =
    input.payoutRatioPct !== null
      ? // A very high payout is not automatically better: it can mean the
        // business is distributing more than it can sustain.
        scaleTo(
          Math.min(input.payoutRatioPct, FUNDAMENTAL_THRESHOLDS.payoutMaxPct),
          FUNDAMENTAL_THRESHOLDS.payoutMinPct,
          FUNDAMENTAL_THRESHOLDS.payoutMaxPct,
          0,
          100,
        )
      : input.dps !== null
        ? input.dps > 0
          ? 60
          : 0
        : null;
  if (shareholderReturn === null) missing.push('Dividend record');

  const components: Record<string, ScoreComponent> = {};

  if (banking) {
    const assetQuality =
      input.nplRatioPct === null
        ? null
        : scaleTo(
            input.nplRatioPct,
            FUNDAMENTAL_THRESHOLDS.nplBestPct,
            FUNDAMENTAL_THRESHOLDS.nplWorstPct,
            100,
            0,
          );
    if (assetQuality === null) missing.push('Non-performing loan ratio');

    const capitalStrength =
      input.capitalAdequacyPct === null
        ? null
        : scaleTo(
            input.capitalAdequacyPct,
            FUNDAMENTAL_THRESHOLDS.carMinPct,
            FUNDAMENTAL_THRESHOLDS.carStrongPct,
            0,
            100,
          );
    if (capitalStrength === null) missing.push('Capital adequacy');

    const efficiency =
      input.costToIncomePct === null
        ? null
        : scaleTo(
            input.costToIncomePct,
            FUNDAMENTAL_THRESHOLDS.costIncomeBestPct,
            FUNDAMENTAL_THRESHOLDS.costIncomeWorstPct,
            100,
            0,
          );
    if (efficiency === null) missing.push('Cost-to-income ratio');

    components.profitability = component(
      profitability,
      BANKING_WEIGHTS.profitability,
      `Return on equity; ${FUNDAMENTAL_THRESHOLDS.roeMaxPct}% saturates.`,
    );
    components.assetQuality = component(
      assetQuality,
      BANKING_WEIGHTS.assetQuality,
      `Non-performing loan ratio; ${FUNDAMENTAL_THRESHOLDS.nplBestPct}% scores 100, ${FUNDAMENTAL_THRESHOLDS.nplWorstPct}% scores 0.`,
    );
    components.capitalStrength = component(
      capitalStrength,
      BANKING_WEIGHTS.capitalStrength,
      `Capital adequacy ratio; the ${FUNDAMENTAL_THRESHOLDS.carMinPct}% regulatory minimum scores 0 and ${FUNDAMENTAL_THRESHOLDS.carStrongPct}% scores 100.`,
    );
    components.efficiency = component(
      efficiency,
      BANKING_WEIGHTS.efficiency,
      `Cost-to-income ratio; ${FUNDAMENTAL_THRESHOLDS.costIncomeBestPct}% scores 100, ${FUNDAMENTAL_THRESHOLDS.costIncomeWorstPct}% scores 0.`,
    );
    components.growth = component(
      growth,
      BANKING_WEIGHTS.growth,
      'Revenue and earnings per share growth versus the prior comparable period.',
    );
    components.shareholderReturn = component(
      shareholderReturn,
      BANKING_WEIGHTS.shareholderReturn,
      'Dividend payout record.',
    );
  } else {
    const margins = blend([
      input.netMarginPct === null
        ? null
        : scaleTo(
            input.netMarginPct,
            FUNDAMENTAL_THRESHOLDS.netMarginMinPct,
            FUNDAMENTAL_THRESHOLDS.netMarginMaxPct,
            0,
            100,
          ),
      input.grossMarginPct === null
        ? null
        : scaleTo(
            input.grossMarginPct,
            FUNDAMENTAL_THRESHOLDS.grossMarginMinPct,
            FUNDAMENTAL_THRESHOLDS.grossMarginMaxPct,
            0,
            100,
          ),
    ]);
    if (margins === null) missing.push('Margins');

    const balanceSheet =
      input.debtToEquity === null
        ? null
        : scaleTo(
            input.debtToEquity,
            0,
            FUNDAMENTAL_THRESHOLDS.debtToEquityMax,
            100,
            0,
          );
    if (balanceSheet === null) missing.push('Leverage');

    // Cash conversion is only meaningful against positive earnings. A negative
    // denominator would invert the ratio and reward loss-making businesses.
    const cashConversion =
      input.operatingCashFlow !== null &&
      input.netIncome !== null &&
      input.netIncome > 0
        ? scaleTo(
            input.operatingCashFlow / input.netIncome,
            FUNDAMENTAL_THRESHOLDS.cashConversionMin,
            FUNDAMENTAL_THRESHOLDS.cashConversionMax,
            0,
            100,
          )
        : null;
    if (cashConversion === null) missing.push('Cash conversion');

    components.profitability = component(
      profitability,
      FUNDAMENTAL_WEIGHTS.profitability,
      `Return on equity; ${FUNDAMENTAL_THRESHOLDS.roeMaxPct}% saturates.`,
    );
    components.margins = component(
      margins,
      FUNDAMENTAL_WEIGHTS.margins,
      `Net margin (${FUNDAMENTAL_THRESHOLDS.netMarginMaxPct}% saturates) and gross margin.`,
    );
    components.growth = component(
      growth,
      FUNDAMENTAL_WEIGHTS.growth,
      'Revenue and earnings per share growth versus the prior comparable period.',
    );
    components.balanceSheet = component(
      balanceSheet,
      FUNDAMENTAL_WEIGHTS.balanceSheet,
      `Debt-to-equity; 0 scores 100 and ${FUNDAMENTAL_THRESHOLDS.debtToEquityMax} scores 0.`,
    );
    components.cashFlow = component(
      cashConversion,
      FUNDAMENTAL_WEIGHTS.cashFlow,
      'Operating cash flow ÷ net income. Not scored against negative earnings, where the ratio would be misleading.',
    );
    components.shareholderReturn = component(
      shareholderReturn,
      FUNDAMENTAL_WEIGHTS.shareholderReturn,
      'Dividend payout record.',
    );
  }

  let earned = 0;
  let availableWeight = 0;
  let totalWeight = 0;
  for (const c of Object.values(components)) {
    totalWeight += c.weight;
    if (c.available) {
      earned += c.contribution;
      availableWeight += c.weight;
    }
  }

  const dataCompleteness =
    totalWeight > 0 ? (availableWeight / totalWeight) * 100 : 0;

  const score =
    availableWeight > 0 &&
    dataCompleteness >= FUNDAMENTAL_THRESHOLDS.minCompleteness
      ? clamp((earned / availableWeight) * 100, 0, 100)
      : null;

  return {
    score,
    dataCompleteness,
    components,
    model: banking ? 'BANKING' : 'GENERAL',
    missing,
    methodologyVersion: FUNDAMENTAL_METHODOLOGY_VERSION,
  };
}

/** Flattens components for storage in the jsonb column. */
export function serializeFundamentalComponents(
  components: Record<string, ScoreComponent>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [name, c] of Object.entries(components)) {
    out[name] = c.available ? Number(c.contribution.toFixed(4)) : null;
    out[`${name}_raw`] = c.raw === null ? null : Number(c.raw.toFixed(4));
    out[`${name}_weight`] = c.weight;
  }
  return out;
}
