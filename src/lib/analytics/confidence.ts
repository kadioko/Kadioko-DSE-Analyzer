/**
 * Data Confidence score.
 *
 * Confidence answers a different question from every other score on this
 * platform: not "what does the data say?" but "how much should you trust what
 * the data says?".
 *
 * It starts at 100 and subtracts named penalties. Each penalty is returned with
 * its code, size and a plain-language explanation, so a low confidence figure
 * always comes with the reason attached. Every investment-oriented score in the
 * application is displayed together with its confidence.
 */

import type { ConfidenceResult } from '@/lib/types/market';
import {
  CONFIDENCE_MODEL_VERSION,
  CONFIDENCE_PENALTIES as P,
  CONFIDENCE_THRESHOLDS as T,
} from './config';
import { clamp } from '@/lib/db/num';

export interface ConfidenceInput {
  /** Names of required market fields that were missing from the source row. */
  missingFields?: string[];
  marketCapTzs: number | null;
  /** Number of trailing sessions available for this instrument. */
  historySessions: number;
  /** Calendar days between the observation date and "today". */
  ageInDays: number | null;
  /** Whether the counter actually traded in the session being scored. */
  traded: boolean;
  turnoverTzs: number | null;
  /** True when the stored row carries WARNING-level validation notes. */
  hasValidationWarnings: boolean;
  /** Whether the originating source is licensed for commercial use. */
  sourceLicensed: boolean;
  /** Whether any fundamentals exist for the instrument. */
  hasFundamentals?: boolean;
  /** Whether the most recent fundamentals have been human-verified. */
  fundamentalsVerified?: boolean;
}

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const factors: ConfidenceResult['factors'] = [];

  const missing = input.missingFields ?? [];
  if (missing.length > 0) {
    // One penalty per missing field, capped so a broken row still reports a
    // usable (very low) number rather than going negative.
    const penalty = Math.min(P.missingCoreField * missing.length, 40);
    factors.push({
      code: 'MISSING_CORE_FIELD',
      penalty,
      detail: `Missing required field(s): ${missing.join(', ')}.`,
    });
  }

  if (input.marketCapTzs === null || input.marketCapTzs <= 0) {
    factors.push({
      code: 'MISSING_MARKET_CAP',
      penalty: P.missingMarketCap,
      detail:
        'No market capitalisation on file, so order-book depth cannot be normalised across counters.',
    });
  }

  if (input.historySessions < T.severeHistorySessions) {
    factors.push({
      code: 'SEVERELY_INSUFFICIENT_HISTORY',
      penalty: P.severelyInsufficientHistory,
      detail: `Only ${input.historySessions} session(s) of history; momentum and volume statistics are unavailable.`,
    });
  } else if (input.historySessions < T.adequateHistorySessions) {
    factors.push({
      code: 'INSUFFICIENT_HISTORY',
      penalty: P.insufficientHistory,
      detail: `${input.historySessions} session(s) of history, fewer than the ${T.adequateHistorySessions} the 20-day statistics need.`,
    });
  }

  if (input.ageInDays !== null && input.ageInDays > T.staleDays) {
    factors.push({
      code: 'STALE_DATA',
      penalty: P.staleData,
      detail: `Latest observation is ${input.ageInDays} day(s) old, beyond the ${T.staleDays}-day freshness threshold.`,
    });
  }

  if (!input.traded) {
    factors.push({
      code: 'NO_TRADE_IN_SESSION',
      penalty: P.noTradeInSession,
      detail:
        'The counter did not trade in this session, so price-derived metrics carry over a stale close.',
    });
  }

  if (
    input.turnoverTzs !== null &&
    input.turnoverTzs > 0 &&
    input.turnoverTzs < T.lowLiquidityTurnoverTzs
  ) {
    factors.push({
      code: 'LOW_LIQUIDITY',
      penalty: P.lowLiquidity,
      detail: `Turnover of ${Math.round(input.turnoverTzs).toLocaleString()} TZS is below the ${T.lowLiquidityTurnoverTzs.toLocaleString()} TZS threshold; derived metrics are noisy.`,
    });
  }

  if (input.hasValidationWarnings) {
    factors.push({
      code: 'VALIDATION_WARNING',
      penalty: P.validationWarning,
      detail:
        'The stored observation carries data-quality warnings from ingestion.',
    });
  }

  if (!input.sourceLicensed) {
    factors.push({
      code: 'UNLICENSED_SOURCE',
      penalty: P.unlicensedSource,
      detail:
        'Data came from a manual or unlicensed source rather than a licensed exchange feed.',
    });
  }

  if (input.hasFundamentals === false) {
    factors.push({
      code: 'NO_FUNDAMENTALS',
      penalty: P.noFundamentals,
      detail: 'No published financial results are on file for this issuer.',
    });
  } else if (
    input.hasFundamentals === true &&
    input.fundamentalsVerified === false
  ) {
    factors.push({
      code: 'UNVERIFIED_FUNDAMENTALS',
      penalty: P.unverifiedFundamentals,
      detail:
        'Financial results on file have not been checked against the published filing.',
    });
  }

  const totalPenalty = factors.reduce((sum, f) => sum + f.penalty, 0);

  return {
    score: clamp(100 - totalPenalty, 0, 100),
    factors,
    modelVersion: CONFIDENCE_MODEL_VERSION,
  };
}

/** Coarse label for a confidence value, used for badge colouring. */
export function confidenceLabel(score: number): 'High' | 'Moderate' | 'Low' | 'Very low' {
  if (score >= 80) return 'High';
  if (score >= 60) return 'Moderate';
  if (score >= 40) return 'Low';
  return 'Very low';
}
