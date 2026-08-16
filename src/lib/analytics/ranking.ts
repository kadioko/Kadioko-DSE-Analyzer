/**
 * Kadioko Overall Ranking engine.
 *
 * Three concepts are kept strictly separate, and conflating them is the single
 * most likely way this feature could mislead someone:
 *
 *   Fundamental Score — how strong the underlying business is.
 *   Sentiment Score   — what the current order book and flow look like.
 *   Overall Score     — the weighted combination of the two.
 *
 * A security may have poor fundamentals and excellent sentiment and still rank
 * poorly. That is intended, not a bug: 70% of the Overall score is business
 * quality, and no amount of order-book enthusiasm compensates for a weak
 * business under this model.
 *
 * Nothing in this module reads the database, so every rule below is directly
 * unit-testable.
 */

import { clamp } from '@/lib/db/num';
import type {
  ExclusionReason,
  InterpretationCode,
  MarketDemand,
  RankingGrade,
} from '@/lib/db/schema';

export const RANKING_MODEL_VERSION = '1.0';
export const DEFAULT_RANKING_MODEL_CODE = 'OVERALL';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface RankingWeights {
  fundamentalWeight: number;
  sentimentWeight: number;
}

/**
 * The default model. Weights are also stored in `ranking_models` so a published
 * snapshot can be reproduced; this constant is the seed and the fallback, not a
 * second source of truth scattered through the code.
 */
export const DEFAULT_RANKING_CONFIG = {
  code: DEFAULT_RANKING_MODEL_CODE,
  name: 'Kadioko Overall Ranking',
  version: RANKING_MODEL_VERSION,
  description:
    'Ranks DSE securities primarily on long-term business quality (70%), adjusted for current order-book sentiment (30%).',
  fundamentalWeight: 0.7,
  sentimentWeight: 0.3,
  /** Entries below these are marked ineligible with a reason, not hidden. */
  minimumConfidence: null as number | null,
  minimumLiquidity: null as number | null,
} as const;

/** Grade band lower edges. Configurable and versioned with the model. */
export const GRADE_BANDS = {
  BORA_SANA: 80,
  NZURI_SANA: 70,
  NZURI: 60,
  WASTANI: 50,
  DHAIFU: 40,
  DHAIFU_SANA: 0,
} as const;

export const GRADE_LABELS: Record<RankingGrade, { sw: string; en: string }> = {
  BORA_SANA: { sw: 'Bora sana', en: 'Excellent' },
  NZURI_SANA: { sw: 'Nzuri sana', en: 'Very good' },
  NZURI: { sw: 'Nzuri', en: 'Good' },
  WASTANI: { sw: 'Wastani', en: 'Average' },
  DHAIFU: { sw: 'Dhaifu', en: 'Weak' },
  DHAIFU_SANA: { sw: 'Dhaifu sana', en: 'Very weak' },
};

/** Market-demand band lower edges, applied to the sentiment score. */
export const DEMAND_BANDS = {
  DEMAND_KUBWA_SANA: 80,
  DEMAND_KUBWA: 50,
  DEMAND_WASTANI: 30,
  DEMAND_NDOGO_SANA: 0,
} as const;

export const DEMAND_LABELS: Record<MarketDemand, { sw: string; en: string }> = {
  DEMAND_KUBWA_SANA: {
    sw: 'Demand kubwa sana',
    en: 'Very strong market demand',
  },
  DEMAND_KUBWA: { sw: 'Demand kubwa', en: 'Strong market demand' },
  DEMAND_WASTANI: { sw: 'Demand ya wastani', en: 'Moderate market demand' },
  DEMAND_NDOGO_SANA: {
    sw: 'Demand ndogo sana',
    en: 'Very weak market demand',
  },
};

/** Liquidity bands, used for the UI warning rather than for scoring. */
export const LIQUIDITY_BANDS = {
  HIGH: 70,
  MEDIUM: 50,
  LOW: 30,
} as const;

export type LiquidityBand =
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'VERY_LOW'
  | 'UNKNOWN';

/* -------------------------------------------------------------------------- */
/* Overall score                                                              */
/* -------------------------------------------------------------------------- */

export class RankingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RankingValidationError';
  }
}

export interface OverallScoreInput {
  fundamentalScore: number | null;
  sentimentScore: number | null;
  fundamentalWeight: number;
  sentimentWeight: number;
}

/**
 * Overall = fundamental × fundamentalWeight + sentiment × sentimentWeight.
 *
 * Throws rather than guessing when an input is unusable. A ranking built on a
 * silently coerced null would be worse than no ranking, so the caller must
 * decide eligibility BEFORE calling this (see `evaluateEligibility`).
 *
 * Returns full precision; rounding to one decimal place is a display concern.
 */
export function calculateOverallScore(input: OverallScoreInput): number {
  const { fundamentalScore, sentimentScore, fundamentalWeight, sentimentWeight } =
    input;

  validateWeights({ fundamentalWeight, sentimentWeight });

  if (fundamentalScore === null || fundamentalScore === undefined) {
    throw new RankingValidationError(
      'Fundamental score is required. A missing fundamental score must exclude the security, not be treated as zero.',
    );
  }
  if (sentimentScore === null || sentimentScore === undefined) {
    throw new RankingValidationError(
      'Sentiment score is required. A missing sentiment score must exclude the security, not be treated as zero.',
    );
  }

  assertInRange(fundamentalScore, 'Fundamental score');
  assertInRange(sentimentScore, 'Sentiment score');

  return fundamentalScore * fundamentalWeight + sentimentScore * sentimentWeight;
}

function assertInRange(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RankingValidationError(`${label} must be a finite number.`);
  }
  if (value < 0 || value > 100) {
    throw new RankingValidationError(
      `${label} must be between 0 and 100, received ${value}.`,
    );
  }
}

/** Weights must be non-negative and sum to 1, within floating-point tolerance. */
export function validateWeights(weights: RankingWeights): void {
  const { fundamentalWeight, sentimentWeight } = weights;

  if (!Number.isFinite(fundamentalWeight) || !Number.isFinite(sentimentWeight)) {
    throw new RankingValidationError('Weights must be finite numbers.');
  }
  if (fundamentalWeight < 0 || sentimentWeight < 0) {
    throw new RankingValidationError('Weights must not be negative.');
  }

  const total = fundamentalWeight + sentimentWeight;
  if (Math.abs(total - 1) > 1e-9) {
    throw new RankingValidationError(
      `Weights must sum to 1.00, received ${total.toFixed(4)}.`,
    );
  }
}

/** Display rounding: one decimal place, as specified. */
export function roundScore(score: number | null): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  return Math.round(score * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/* Grades and demand                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Grade band for an overall score.
 *
 * Bands are evaluated against the score at full precision, then displayed
 * rounded. A score of 79.96 is NZURI_SANA and displays as 80.0, which is
 * intentional: the band is the fact, the rounding is presentation.
 */
export function getOverallGrade(
  score: number | null,
  bands: Record<string, number> = GRADE_BANDS,
): RankingGrade | null {
  if (score === null || !Number.isFinite(score)) return null;

  const s = clamp(score, 0, 100);
  if (s >= (bands.BORA_SANA ?? GRADE_BANDS.BORA_SANA)) return 'BORA_SANA';
  if (s >= (bands.NZURI_SANA ?? GRADE_BANDS.NZURI_SANA)) return 'NZURI_SANA';
  if (s >= (bands.NZURI ?? GRADE_BANDS.NZURI)) return 'NZURI';
  if (s >= (bands.WASTANI ?? GRADE_BANDS.WASTANI)) return 'WASTANI';
  if (s >= (bands.DHAIFU ?? GRADE_BANDS.DHAIFU)) return 'DHAIFU';
  return 'DHAIFU_SANA';
}

/** Market demand band, derived from the SENTIMENT score, never the overall. */
export function getMarketDemand(
  sentimentScore: number | null,
): MarketDemand | null {
  if (sentimentScore === null || !Number.isFinite(sentimentScore)) return null;

  const s = clamp(sentimentScore, 0, 100);
  if (s >= DEMAND_BANDS.DEMAND_KUBWA_SANA) return 'DEMAND_KUBWA_SANA';
  if (s >= DEMAND_BANDS.DEMAND_KUBWA) return 'DEMAND_KUBWA';
  if (s >= DEMAND_BANDS.DEMAND_WASTANI) return 'DEMAND_WASTANI';
  return 'DEMAND_NDOGO_SANA';
}

/** Liquidity band for the UI warning. Does not affect the score. */
export function getLiquidityBand(
  liquidityScore: number | null,
): LiquidityBand {
  if (liquidityScore === null || !Number.isFinite(liquidityScore)) {
    return 'UNKNOWN';
  }
  if (liquidityScore >= LIQUIDITY_BANDS.HIGH) return 'HIGH';
  if (liquidityScore >= LIQUIDITY_BANDS.MEDIUM) return 'MEDIUM';
  if (liquidityScore >= LIQUIDITY_BANDS.LOW) return 'LOW';
  return 'VERY_LOW';
}

export const LIQUIDITY_LABELS: Record<LiquidityBand, { sw: string; en: string }> =
  {
    HIGH: { sw: 'Ukwasi mkubwa', en: 'High liquidity' },
    MEDIUM: { sw: 'Ukwasi wa wastani', en: 'Medium liquidity' },
    LOW: { sw: 'Ukwasi mdogo', en: 'Low liquidity' },
    VERY_LOW: { sw: 'Ukwasi mdogo sana', en: 'Very low liquidity' },
    UNKNOWN: { sw: 'Ukwasi haujulikani', en: 'Liquidity unknown' },
  };

/* -------------------------------------------------------------------------- */
/* Interpretation                                                             */
/* -------------------------------------------------------------------------- */

export interface Interpretation {
  code: InterpretationCode;
  sw: string;
  en: string;
}

/**
 * The Uamuzi (decision) output.
 *
 * Deliberately NOT a function of the overall score. It reads fundamental
 * quality and sentiment separately, because the same overall score can arise
 * from a strong business in a quiet market or a weak business in an excited
 * one, and those two situations warrant different language.
 *
 * A high sentiment score can never on its own produce accumulate-style
 * language: rules 3, 4 and 5 all return watch/avoid regardless of how strong
 * the order book looks.
 */
export function getInterpretation(
  fundamentalScore: number | null,
  sentimentScore: number | null,
): Interpretation | null {
  if (
    fundamentalScore === null ||
    sentimentScore === null ||
    !Number.isFinite(fundamentalScore) ||
    !Number.isFinite(sentimentScore)
  ) {
    return null;
  }

  // Rule 5 first: weak fundamentals override everything the market is doing.
  if (fundamentalScore < 50) {
    return {
      code: 'WEAK_QUALITY',
      sw: 'Epuka: ubora dhaifu',
      en: 'Avoid or watch cautiously: weak fundamental quality',
    };
  }

  if (fundamentalScore >= 70) {
    if (sentimentScore >= 70) {
      return {
        code: 'QUALITY_AND_TREND_ALIGNED',
        sw: 'Nunua: ubora na mwelekeo vinaungana',
        en: 'Accumulate: quality and market direction are aligned',
      };
    }
    return {
      code: 'QUALITY_AWAITING_TREND',
      sw: 'Fuatilia: ubora mzuri, mwelekeo bado haujathibitisha',
      en: 'Watch: strong quality, but market direction is not yet confirmed',
    };
  }

  // 50 <= fundamental < 70
  if (sentimentScore >= 30) {
    return {
      code: 'AVERAGE_QUALITY',
      sw: 'Fuatilia: ubora wa wastani',
      en: 'Watch: average fundamental quality',
    };
  }

  return {
    code: 'AVERAGE_QUALITY_WEAK_TREND',
    sw: 'Fuatilia: ubora wa wastani, mwelekeo bado dhaifu',
    en: 'Watch: average quality and weak current market direction',
  };
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* -------------------------------------------------------------------------- */

export interface EligibilityInput {
  active: boolean;
  fundamentalScore: number | null;
  sentimentScore: number | null;
  liquidityScore: number | null;
  dataConfidence: number | null;
  /** Whether the backing financial report is older than the staleness limit. */
  fundamentalsStale?: boolean;
  minimumConfidence?: number | null;
  minimumLiquidity?: number | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: ExclusionReason | null;
}

/**
 * Decides whether a security can be ranked.
 *
 * Ineligible securities are still recorded in the snapshot, with the reason, so
 * the page can show "12 of 28 counters could not be ranked, because…" rather
 * than silently presenting a short list as if it were the whole market.
 */
export function evaluateEligibility(
  input: EligibilityInput,
): EligibilityResult {
  if (!input.active) {
    return { eligible: false, reason: 'INSTRUMENT_INACTIVE' };
  }
  if (input.fundamentalScore === null) {
    return { eligible: false, reason: 'MISSING_FUNDAMENTALS' };
  }
  if (input.fundamentalsStale) {
    return { eligible: false, reason: 'STALE_FUNDAMENTALS' };
  }
  if (input.sentimentScore === null) {
    return { eligible: false, reason: 'MISSING_SENTIMENT' };
  }
  if (
    input.minimumConfidence !== null &&
    input.minimumConfidence !== undefined &&
    (input.dataConfidence === null ||
      input.dataConfidence < input.minimumConfidence)
  ) {
    return { eligible: false, reason: 'BELOW_MINIMUM_CONFIDENCE' };
  }
  if (
    input.minimumLiquidity !== null &&
    input.minimumLiquidity !== undefined &&
    (input.liquidityScore === null ||
      input.liquidityScore < input.minimumLiquidity)
  ) {
    return { eligible: false, reason: 'BELOW_MINIMUM_LIQUIDITY' };
  }
  return { eligible: true, reason: null };
}

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  MISSING_FUNDAMENTALS:
    'No published financial results on file, so no fundamental score could be computed.',
  MISSING_SENTIMENT:
    'No order-book pressure score for this session, so sentiment could not be measured.',
  STALE_FUNDAMENTALS:
    'The most recent financial results are older than the model allows.',
  BELOW_MINIMUM_CONFIDENCE:
    'Data confidence is below the minimum this ranking model requires.',
  BELOW_MINIMUM_LIQUIDITY:
    'Liquidity is below the minimum this ranking model requires.',
  INSTRUMENT_INACTIVE: 'The security is not currently active.',
};

/* -------------------------------------------------------------------------- */
/* Sorting and ranking                                                        */
/* -------------------------------------------------------------------------- */

export interface RankableEntry {
  symbol: string;
  fundamentalScore: number | null;
  sentimentScore: number | null;
  overallScore: number | null;
  dataConfidence: number | null;
  eligible: boolean;
}

/**
 * Sorts eligible entries into ranking order.
 *
 * Primary: overall score descending. Ties broken by fundamental score, then
 * sentiment, then data confidence, then symbol — so the order is fully
 * deterministic and a re-run produces the identical ranking.
 */
export function compareForRanking(a: RankableEntry, b: RankableEntry): number {
  const byOverall = (b.overallScore ?? -1) - (a.overallScore ?? -1);
  if (Math.abs(byOverall) > 1e-9) return byOverall;

  const byFundamental = (b.fundamentalScore ?? -1) - (a.fundamentalScore ?? -1);
  if (Math.abs(byFundamental) > 1e-9) return byFundamental;

  const bySentiment = (b.sentimentScore ?? -1) - (a.sentimentScore ?? -1);
  if (Math.abs(bySentiment) > 1e-9) return bySentiment;

  const byConfidence = (b.dataConfidence ?? -1) - (a.dataConfidence ?? -1);
  if (Math.abs(byConfidence) > 1e-9) return byConfidence;

  return a.symbol.localeCompare(b.symbol);
}

/**
 * Assigns 1-based ranks to eligible entries in sorted order.
 * Ineligible entries receive a null rank and keep their place in the list.
 */
export function assignRanks<T extends RankableEntry>(
  entries: readonly T[],
): Array<T & { rank: number | null }> {
  const eligible = entries.filter((e) => e.eligible).sort(compareForRanking);
  const ineligible = entries
    .filter((e) => !e.eligible)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  return [
    ...eligible.map((entry, index) => ({ ...entry, rank: index + 1 })),
    ...ineligible.map((entry) => ({ ...entry, rank: null })),
  ];
}

export interface RankMovement {
  previousRank: number | null;
  rankChange: number | null;
  isNewEntrant: boolean;
}

/**
 * Rank movement against the previous snapshot.
 *
 * Convention: positive means IMPROVEMENT. Moving from rank 5 to rank 2 is +3,
 * because a smaller rank number is a better position. Getting this backwards is
 * the classic bug in a rankings table, so it is stated here and tested.
 */
export function calculateRankMovement(
  currentRank: number | null,
  previousRank: number | null | undefined,
): RankMovement {
  if (currentRank === null) {
    return { previousRank: previousRank ?? null, rankChange: null, isNewEntrant: false };
  }
  if (previousRank === null || previousRank === undefined) {
    return { previousRank: null, rankChange: null, isNewEntrant: true };
  }
  return {
    previousRank,
    rankChange: previousRank - currentRank,
    isNewEntrant: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

export interface RankingComputation {
  overallScore: number | null;
  grade: RankingGrade | null;
  marketDemand: MarketDemand | null;
  interpretation: Interpretation | null;
  eligible: boolean;
  exclusionReason: ExclusionReason | null;
}

/**
 * Runs the whole per-security calculation: eligibility, overall score, grade,
 * demand and interpretation. Ineligible securities get a null score and no
 * grade, never a zero.
 */
export function computeRankingEntry(
  input: EligibilityInput & RankingWeights,
): RankingComputation {
  const eligibility = evaluateEligibility(input);

  if (!eligibility.eligible) {
    return {
      overallScore: null,
      grade: null,
      // Demand describes the order book and is still meaningful on its own,
      // even where the security cannot be ranked overall.
      marketDemand: getMarketDemand(input.sentimentScore),
      interpretation: null,
      eligible: false,
      exclusionReason: eligibility.reason,
    };
  }

  const overallScore = calculateOverallScore({
    fundamentalScore: input.fundamentalScore,
    sentimentScore: input.sentimentScore,
    fundamentalWeight: input.fundamentalWeight,
    sentimentWeight: input.sentimentWeight,
  });

  return {
    overallScore,
    grade: getOverallGrade(overallScore),
    marketDemand: getMarketDemand(input.sentimentScore),
    interpretation: getInterpretation(
      input.fundamentalScore,
      input.sentimentScore,
    ),
    eligible: true,
    exclusionReason: null,
  };
}
