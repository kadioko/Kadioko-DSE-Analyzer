/**
 * Opportunity Score.
 *
 * A composite investment-context score, deliberately separate from Market
 * Pressure. Pressure describes the order book right now; Opportunity attempts
 * to describe whether the security looks attractive on the evidence available.
 *
 * The rule that matters most here: a pillar with no data is EXCLUDED, never
 * imputed. If an issuer has published no financial results, the fundamentals
 * pillar does not quietly become 50/100 - it is reported in `missing`, removed
 * from the denominator, and the data-confidence score falls to reflect it. If
 * too little of the model is covered, no score is published at all.
 */

import type { OpportunityResult, ScoreComponent } from '@/lib/types/market';
import {
  OPPORTUNITY_MODEL_VERSION,
  OPPORTUNITY_THRESHOLDS as T,
  OPPORTUNITY_WEIGHTS as W,
} from './config';
import { clamp, scaleTo } from '@/lib/db/num';

export interface OpportunityInput {
  /** From the fundamentals table. Null when the issuer has published nothing. */
  roePct: number | null;
  netMarginPct: number | null;
  debtToEquity: number | null;
  epsGrowthPct: number | null;

  /** From the valuations table. */
  peRatio: number | null;
  pbRatio: number | null;
  dividendYieldPct: number | null;

  /** From analytics_daily. */
  return20dPct: number | null;
  return5dPct: number | null;
  liquidityScore: number | null;
  pressureScore: number | null;
  volatility20dPct: number | null;
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

/** Averages the sub-signals that exist; returns null if none do. */
function blend(parts: readonly (number | null)[]): number | null {
  const present = parts.filter((p): p is number => p !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

/** Lower is better: maps [attractive, expensive] onto [100, 0]. */
function inverseBand(
  value: number | null,
  attractive: number,
  expensive: number,
): number | null {
  if (value === null) return null;
  // A negative or zero multiple is not "cheap", it is not meaningful.
  if (value <= 0) return null;
  return scaleTo(value, attractive, expensive, 100, 0);
}

export function computeOpportunity(input: OpportunityInput): OpportunityResult {
  const missing: string[] = [];

  /* -- Fundamentals: profitability and balance-sheet quality -------------- */
  const fundamentalsRaw = blend([
    input.roePct === null
      ? null
      : scaleTo(input.roePct, T.roeMinPct, T.roeMaxPct, 0, 100),
    input.netMarginPct === null
      ? null
      : scaleTo(input.netMarginPct, T.netMarginMinPct, T.netMarginMaxPct, 0, 100),
    input.epsGrowthPct === null
      ? null
      : scaleTo(input.epsGrowthPct, -25, 25, 0, 100),
  ]);
  if (fundamentalsRaw === null) missing.push('Fundamental data unavailable');

  /* -- Valuation: cheap relative to earnings and book value --------------- */
  const valuationRaw = blend([
    inverseBand(input.peRatio, T.peAttractive, T.peExpensive),
    inverseBand(input.pbRatio, T.pbAttractive, T.pbExpensive),
  ]);
  if (valuationRaw === null) missing.push('Valuation multiples unavailable');

  /* -- Momentum ----------------------------------------------------------- */
  const momentumRaw = blend([
    input.return20dPct === null
      ? null
      : scaleTo(input.return20dPct, T.return20dMinPct, T.return20dMaxPct, 0, 100),
    input.return5dPct === null ? null : scaleTo(input.return5dPct, -10, 10, 0, 100),
  ]);
  if (momentumRaw === null) missing.push('Price history unavailable');

  /* -- Liquidity ---------------------------------------------------------- */
  const liquidityRaw = input.liquidityScore;
  if (liquidityRaw === null) missing.push('Liquidity data unavailable');

  /* -- Market pressure ---------------------------------------------------- */
  const pressureRaw = input.pressureScore;
  if (pressureRaw === null) missing.push('Order-book pressure unavailable');

  /* -- Dividend ----------------------------------------------------------- */
  const dividendRaw =
    input.dividendYieldPct === null
      ? null
      : scaleTo(
          input.dividendYieldPct,
          T.dividendYieldMinPct,
          T.dividendYieldMaxPct,
          0,
          100,
        );
  if (dividendRaw === null) missing.push('Dividend data unavailable');

  /* -- Risk: lower volatility and lower gearing score higher -------------- */
  const riskRaw = blend([
    input.volatility20dPct === null
      ? null
      : scaleTo(
          input.volatility20dPct,
          T.volatilityLowPct,
          T.volatilityHighPct,
          100,
          0,
        ),
    input.debtToEquity === null
      ? null
      : scaleTo(input.debtToEquity, 0, T.debtToEquityMax, 100, 0),
  ]);
  if (riskRaw === null) missing.push('Risk inputs unavailable');

  const components: Record<string, ScoreComponent> = {
    fundamentals: component(
      fundamentalsRaw,
      W.fundamentals,
      'Return on equity, net margin and EPS growth from published financial results. Excluded entirely when the issuer has published nothing.',
    ),
    valuation: component(
      valuationRaw,
      W.valuation,
      `Price/earnings and price/book. P/E of ${T.peAttractive} scores 100, ${T.peExpensive} scores 0. Negative earnings produce no score rather than a flattering one.`,
    ),
    momentum: component(
      momentumRaw,
      W.momentum,
      `20-day and 5-day price returns; +${T.return20dMaxPct}% over 20 days saturates.`,
    ),
    liquidity: component(
      liquidityRaw,
      W.liquidity,
      'The liquidity score, carried through unchanged.',
    ),
    marketPressure: component(
      pressureRaw,
      W.marketPressure,
      'The market pressure score, contributing only 10% - order-book imbalance is a short-horizon signal, not an investment case.',
    ),
    dividend: component(
      dividendRaw,
      W.dividend,
      `Trailing dividend yield; ${T.dividendYieldMaxPct}% saturates.`,
    ),
    risk: component(
      riskRaw,
      W.risk,
      'Lower realised volatility and lower debt-to-equity score higher.',
    ),
  };

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

  const coverage = totalWeight > 0 ? (availableWeight / totalWeight) * 100 : 0;
  const opportunityScore =
    availableWeight > 0 && coverage >= T.minCoverage
      ? clamp((earned / availableWeight) * 100, 0, 100)
      : null;

  return {
    opportunityScore,
    components,
    coverage,
    missing,
    modelVersion: OPPORTUNITY_MODEL_VERSION,
  };
}
