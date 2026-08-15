/**
 * Volume, turnover and liquidity analytics.
 *
 * On the DSE a single negotiated block trade can be many multiples of a
 * counter's normal daily volume. Averages alone are therefore misleading, so
 * the median is computed alongside the mean and is what the volume-consistency
 * component of the liquidity score is built on.
 */

import type { LiquidityResult, ScoreComponent, VolumeProfile } from '@/lib/types/market';
import {
  LIQUIDITY_MODEL_VERSION,
  LIQUIDITY_THRESHOLDS as T,
  LIQUIDITY_WEIGHTS as W,
  WINDOWS,
} from './config';
import { clamp, mean, median, percentileRank, safeDiv, scaleTo } from '@/lib/db/num';

export interface VolumeInput {
  volume: number | null;
  turnoverTzs: number | null;
  deals: number | null;
  marketCapTzs: number | null;
  close: number | null;
  /** Prior sessions, most recent first, excluding the current session. */
  trailingVolumes: readonly (number | null)[];
  /** Turnover of every counter in the same session, for the liquidity percentile. */
  marketTurnovers?: readonly number[];
}

/**
 * Builds the volume profile for one session.
 *
 * `volumeRatio` compares today's volume with the 20-day average. It is null
 * when fewer than WINDOWS.longVolumeMinObservations trailing sessions exist,
 * rather than being computed off a two-day sample.
 */
export function analyzeVolume(input: VolumeInput): VolumeProfile {
  const trailing = input.trailingVolumes.filter(
    (v): v is number => v !== null && v !== undefined,
  );

  const short = trailing.slice(0, WINDOWS.shortVolume);
  const long = trailing.slice(0, WINDOWS.longVolume);

  const avgVolume5d = short.length > 0 ? mean(short) : null;
  const hasLongWindow = long.length >= WINDOWS.longVolumeMinObservations;
  const avgVolume20d = hasLongWindow ? mean(long) : null;
  const medianVolume20d = hasLongWindow ? median(long) : null;

  const volumeRatio =
    input.volume !== null && avgVolume20d !== null && avgVolume20d > 0
      ? input.volume / avgVolume20d
      : null;

  // Turnover ratio: session turnover as a share of market capitalisation.
  const turnoverRatio =
    input.turnoverTzs !== null &&
    input.marketCapTzs !== null &&
    input.marketCapTzs > 0
      ? input.turnoverTzs / input.marketCapTzs
      : null;

  const avgDealSize =
    input.deals !== null && input.deals > 0
      ? safeDiv(input.turnoverTzs, input.deals)
      : null;

  const liquidityPercentile =
    input.turnoverTzs !== null &&
    input.marketTurnovers &&
    input.marketTurnovers.length > 0
      ? percentileRank(input.turnoverTzs, input.marketTurnovers)
      : null;

  return {
    volume: input.volume,
    avgVolume5d,
    avgVolume20d,
    medianVolume20d,
    volumeRatio,
    turnoverRatio,
    avgDealSize,
    liquidityPercentile,
    observations: trailing.length,
  };
}

/** log10 scaled to 0-100 between two exponents, safe for zero and negatives. */
function logScore(value: number | null, minExp: number, maxExp: number): number | null {
  if (value === null || value <= 0) return null;
  return scaleTo(Math.log10(value), minExp, maxExp, 0, 100);
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

export interface LiquidityInput {
  profile: VolumeProfile;
  turnoverTzs: number | null;
  deals: number | null;
  bidQty: number | null;
  offerQty: number | null;
  close: number | null;
  /** Count of the last 20 sessions in which the counter actually traded. */
  tradedSessions?: number;
  windowSessions?: number;
}

/**
 * Liquidity score, 0-100. Higher means easier to get in and out of.
 *
 * Components that lack data are excluded from both the numerator and the
 * denominator, and the achieved `coverage` is returned so the caller can decide
 * whether to display the number at all.
 */
export function liquidityScore(input: LiquidityInput): LiquidityResult {
  const { profile } = input;

  const turnoverRaw = logScore(
    input.turnoverTzs,
    T.turnoverLogMin,
    T.turnoverLogMax,
  );

  const dealsRaw = logScore(input.deals, T.dealsLogMin, T.dealsLogMax);

  // Consistency: how often the counter trades, and how close today's volume is
  // to its own median rather than to a block-trade-inflated mean.
  let consistencyRaw: number | null = null;
  if (input.tradedSessions !== undefined && (input.windowSessions ?? 0) > 0) {
    const frequency = clamp(
      input.tradedSessions / (input.windowSessions as number),
      0,
      1,
    );
    consistencyRaw = frequency * 100;
  } else if (profile.medianVolume20d !== null && profile.medianVolume20d > 0) {
    consistencyRaw = 100;
  }

  // Book depth valued in TZS across both sides.
  const depthQty =
    input.bidQty !== null && input.offerQty !== null
      ? input.bidQty + input.offerQty
      : null;
  const depthValue =
    depthQty !== null && input.close !== null ? depthQty * input.close : null;
  const bookDepthRaw = logScore(
    depthValue,
    T.bookDepthLogMin,
    T.bookDepthLogMax,
  );

  const components: Record<string, ScoreComponent> = {
    turnover: component(
      turnoverRaw,
      W.turnover,
      `Session turnover in TZS on a log scale between 10^${T.turnoverLogMin} and 10^${T.turnoverLogMax}.`,
    ),
    deals: component(
      dealsRaw,
      W.deals,
      `Number of deals on a log scale between 10^${T.dealsLogMin} and 10^${T.dealsLogMax}. Many small deals indicate broader participation than one block trade.`,
    ),
    consistency: component(
      consistencyRaw,
      W.consistency,
      'Share of recent sessions in which the counter traded at all.',
    ),
    bookDepth: component(
      bookDepthRaw,
      W.bookDepth,
      'TZS value of resting orders on both sides of the book, on a log scale.',
    ),
  };

  return finalizeScore(components, LIQUIDITY_MODEL_VERSION, 0);
}

/**
 * Combines weighted components into a 0-100 score.
 *
 * The score is renormalised over the components that actually had data, so a
 * missing component neither drags the score down nor is silently replaced with
 * an invented neutral value. `coverage` reports how much of the model's total
 * weight was available; below `minCoverage` the score is withheld (null).
 */
export function finalizeScore(
  components: Record<string, ScoreComponent>,
  modelVersion: string,
  minCoverage: number,
): LiquidityResult {
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
  const score =
    availableWeight > 0 && coverage >= minCoverage
      ? (earned / availableWeight) * 100
      : null;

  return {
    liquidityScore: score === null ? null : clamp(score, 0, 100),
    components,
    coverage,
    modelVersion,
  };
}
