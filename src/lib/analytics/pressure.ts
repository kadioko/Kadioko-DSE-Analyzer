/**
 * Market Pressure score.
 *
 * WHAT IT MEASURES: the balance between resting demand and resting supply, and
 * whether recent flow confirms it.
 *
 *   0   extreme supply-side (sell) pressure
 *   50  balanced
 *   100 extreme demand-side (buy) pressure
 *
 * WHAT IT DOES NOT MEASURE: whether the security is a good investment. Pressure
 * is an order-book observation, not a valuation, and a high reading is never on
 * its own a buy signal. Investment context lives in the Opportunity score.
 *
 * Every component's raw sub-score, weight and points contributed is returned so
 * the number can be taken apart on screen. Nothing here is hidden.
 */

import type {
  BoResult,
  PressureResult,
  PressureSignal,
  ScoreComponent,
} from '@/lib/types/market';
import {
  PRESSURE_MODEL_VERSION,
  PRESSURE_THRESHOLDS as T,
  PRESSURE_WEIGHTS as W,
} from './config';
import { netDepthPctMcap } from './bo';
import { clamp, scaleTo } from '@/lib/db/num';

export interface PressureInput {
  book: BoResult;
  /** B/O momentum in percent, or null when history is insufficient. */
  boMomentumPct: number | null;
  /** Session price change in percent. */
  changePct: number | null;
  /** Today's volume relative to the 20-day average. */
  volumeRatio: number | null;
  /** Liquidity score 0-100, from liquidityScore(). */
  liquidityScore: number | null;
}

/**
 * Maps a bid/offer ratio onto 0-100 through log10, so that 0.5x and 2.0x sit
 * symmetrically either side of the balanced midpoint. A linear mapping would
 * treat "twice as many offers" as far milder than "twice as many bids", which
 * is not how an order book behaves.
 */
export function boRatioToScore(ratio: number | null): number | null {
  if (ratio === null) return null;
  if (ratio <= 0) return 0; // NO_BID: all supply, no demand.
  const logRatio = Math.log10(ratio);
  return scaleTo(logRatio, -T.boLogSaturation, T.boLogSaturation, 0, 100);
}

/**
 * Price and volume together: rising price on above-average volume is stronger
 * confirmation of demand than the same rise on thin volume. The volume
 * component is therefore signed by the direction of the price move.
 */
function volumeConfirmationScore(
  volumeRatio: number | null,
  changePct: number | null,
): number | null {
  if (volumeRatio === null) return null;

  // How far above/below normal today's participation is, 0-1.
  const intensity = clamp(
    (volumeRatio - T.volumeNeutralRatio) /
      (T.volumeSaturationRatio - T.volumeNeutralRatio),
    -1,
    1,
  );

  // With no price direction, elevated volume alone says nothing about side.
  if (changePct === null || changePct === 0) return 50;

  const direction = changePct > 0 ? 1 : -1;
  // Elevated volume pushes the score in the direction of the price move;
  // below-average volume pulls it back toward neutral.
  return clamp(50 + direction * intensity * 50, 0, 100);
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

/** Bands the 0-100 score into a signal label. */
export function pressureSignalFor(
  score: number | null,
  coverage: number,
): PressureSignal {
  if (score === null || coverage < T.minCoverage) return 'INSUFFICIENT_DATA';
  const b = T.signalBands;
  if (score < b.strongSupply) return 'STRONG_SUPPLY';
  if (score < b.supply) return 'SUPPLY';
  if (score <= b.demand) return 'BALANCED';
  if (score <= b.strongDemand) return 'DEMAND';
  return 'STRONG_DEMAND';
}

export function computePressure(input: PressureInput): PressureResult {
  const { book } = input;

  const orderBookRaw = boRatioToScore(book.ratio);

  const momentumRaw =
    input.boMomentumPct === null
      ? null
      : scaleTo(
          input.boMomentumPct,
          -T.boMomentumSaturationPct,
          T.boMomentumSaturationPct,
          0,
          100,
        );

  const priceRaw =
    input.changePct === null
      ? null
      : scaleTo(
          input.changePct,
          -T.priceSaturationPct,
          T.priceSaturationPct,
          0,
          100,
        );

  const volumeRaw = volumeConfirmationScore(input.volumeRatio, input.changePct);

  const netDepth = netDepthPctMcap(book);
  const depthRaw =
    netDepth === null
      ? null
      : scaleTo(
          netDepth,
          -T.depthSaturationPctMcap,
          T.depthSaturationPctMcap,
          0,
          100,
        );

  // Liquidity does not have a "side". It scales the informativeness of the
  // reading: an illiquid counter's book is weak evidence either way, so its
  // contribution is pulled toward the neutral midpoint.
  const liquidityRaw =
    input.liquidityScore === null
      ? null
      : 50 + ((orderBookRaw ?? 50) - 50) * (input.liquidityScore / 100);

  const components: Record<string, ScoreComponent> = {
    orderBook: component(
      orderBookRaw,
      W.orderBook,
      `Bid/offer ratio mapped through log10; 0.1x scores 0, 1.0x scores 50, 10x scores 100. Null when there are no offers (${book.state}).`,
    ),
    boMomentum: component(
      momentumRaw,
      W.boMomentum,
      `Change in the bid/offer ratio versus its own 5-session average; +/-${T.boMomentumSaturationPct}% saturates.`,
    ),
    price: component(
      priceRaw,
      W.price,
      `Session price change; +/-${T.priceSaturationPct}% saturates.`,
    ),
    volume: component(
      volumeRaw,
      W.volume,
      `Whether volume confirms the price move. Above-average volume pushes the score in the direction of the move; below-average volume pulls it toward neutral.`,
    ),
    depth: component(
      depthRaw,
      W.depth,
      `Net resting demand minus supply as a percentage of market capitalisation; +/-${T.depthSaturationPctMcap}% saturates. This is what makes counters of different sizes comparable.`,
    ),
    liquidity: component(
      liquidityRaw,
      W.liquidity,
      'Order-book reading damped toward neutral when the counter is illiquid, because a thin book is weak evidence.',
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
  const pressureScore =
    availableWeight > 0 && coverage >= T.minCoverage
      ? clamp((earned / availableWeight) * 100, 0, 100)
      : null;

  return {
    pressureScore,
    signal: pressureSignalFor(pressureScore, coverage),
    components,
    coverage,
    modelVersion: PRESSURE_MODEL_VERSION,
  };
}

/** Display label for a pressure signal. */
export function pressureSignalLabel(signal: PressureSignal): string {
  switch (signal) {
    case 'STRONG_DEMAND':
      return 'Strong demand pressure';
    case 'DEMAND':
      return 'Demand pressure';
    case 'BALANCED':
      return 'Balanced';
    case 'SUPPLY':
      return 'Supply pressure';
    case 'STRONG_SUPPLY':
      return 'Strong supply pressure';
    case 'INSUFFICIENT_DATA':
      return 'Insufficient data';
  }
}
