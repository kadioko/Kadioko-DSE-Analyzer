/**
 * Market scanner.
 *
 * Classifies counters into named, rule-based signals. Every rule is stated
 * explicitly and every match carries the values that triggered it, so a reader
 * can check the classification rather than trusting a label.
 *
 * The reversal rule is deliberately strict. Calling something a reversal on
 * price action alone would be a claim the data does not support, so a match
 * requires the order book to disagree with price AND volume to confirm.
 */

import type { MarketRow } from '@/lib/types/market';
import { SCANNER_THRESHOLDS as T } from './config';

export type SignalCode =
  | 'BO_ACCELERATION'
  | 'BO_DETERIORATION'
  | 'UNUSUAL_VOLUME'
  | 'POSITIVE_MOMENTUM'
  | 'NEGATIVE_MOMENTUM'
  | 'POSSIBLE_UPWARD_REVERSAL'
  | 'POSSIBLE_DOWNWARD_REVERSAL';

export interface ScannerMatch {
  row: MarketRow;
  /** The values that satisfied the rule, for display next to the match. */
  evidence: Array<{ label: string; value: string }>;
}

export interface SignalGroup {
  code: SignalCode;
  title: string;
  /** The rule, in words. Shown on the page above the matches. */
  rule: string;
  tone: 'up' | 'down' | 'warn';
  matches: ScannerMatch[];
}

const pct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const ratio = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}×`);

/**
 * Runs every scanner rule over one session.
 *
 * `return5dPct` is supplied separately because MarketRow carries only the
 * session's own change; multi-day returns live in analytics_daily.
 */
export function runScanner(
  rows: readonly MarketRow[],
  returns5d: ReadonlyMap<string, number | null> = new Map(),
): SignalGroup[] {
  const get5d = (row: MarketRow) => returns5d.get(row.instrumentId) ?? null;

  const boAcceleration: ScannerMatch[] = [];
  const boDeterioration: ScannerMatch[] = [];
  const unusualVolume: ScannerMatch[] = [];
  const positiveMomentum: ScannerMatch[] = [];
  const negativeMomentum: ScannerMatch[] = [];
  const upwardReversal: ScannerMatch[] = [];
  const downwardReversal: ScannerMatch[] = [];

  for (const row of rows) {
    const momentum = row.boMomentumPct;
    const volumeRatio = row.volumeRatio;
    const change = row.changePct;
    const return5d = get5d(row);

    if (momentum !== null && momentum >= T.boAccelerationPct) {
      boAcceleration.push({
        row,
        evidence: [
          { label: 'B/O momentum', value: pct(momentum) },
          { label: 'B/O', value: row.boRatio === null ? '—' : row.boRatio.toFixed(2) },
        ],
      });
    }

    if (momentum !== null && momentum <= T.boDeteriorationPct) {
      boDeterioration.push({
        row,
        evidence: [
          { label: 'B/O momentum', value: pct(momentum) },
          { label: 'B/O', value: row.boRatio === null ? '—' : row.boRatio.toFixed(2) },
        ],
      });
    }

    if (volumeRatio !== null && volumeRatio >= T.unusualVolumeRatio) {
      unusualVolume.push({
        row,
        evidence: [
          { label: 'Volume vs 20d avg', value: ratio(volumeRatio) },
          { label: 'Change', value: pct(change) },
        ],
      });
    }

    if (return5d !== null && return5d >= T.momentumReturnPct) {
      positiveMomentum.push({
        row,
        evidence: [
          { label: '5-day return', value: pct(return5d) },
          { label: 'Volume vs 20d avg', value: ratio(volumeRatio) },
        ],
      });
    }

    if (return5d !== null && return5d <= -T.momentumReturnPct) {
      negativeMomentum.push({
        row,
        evidence: [
          { label: '5-day return', value: pct(return5d) },
          { label: 'Volume vs 20d avg', value: ratio(volumeRatio) },
        ],
      });
    }

    /* -- Reversals: all three conditions, or no match --------------------- */
    const volumeConfirms =
      volumeRatio !== null && volumeRatio >= T.reversalVolumeRatio;

    if (
      momentum !== null &&
      change !== null &&
      volumeConfirms &&
      // Price fell meaningfully while resting demand built up.
      change <= -T.reversalReturnPct &&
      momentum >= T.reversalBoPct
    ) {
      upwardReversal.push({
        row,
        evidence: [
          { label: 'Price', value: pct(change) },
          { label: 'B/O momentum', value: pct(momentum) },
          { label: 'Volume confirmation', value: ratio(volumeRatio) },
        ],
      });
    }

    if (
      momentum !== null &&
      change !== null &&
      volumeConfirms &&
      // Price rose while resting demand drained away.
      change >= T.reversalReturnPct &&
      momentum <= -T.reversalBoPct
    ) {
      downwardReversal.push({
        row,
        evidence: [
          { label: 'Price', value: pct(change) },
          { label: 'B/O momentum', value: pct(momentum) },
          { label: 'Volume confirmation', value: ratio(volumeRatio) },
        ],
      });
    }
  }

  const bySize = (a: ScannerMatch, b: ScannerMatch, key: 'boMomentumPct' | 'volumeRatio') =>
    Math.abs(b.row[key] ?? 0) - Math.abs(a.row[key] ?? 0);

  return [
    {
      code: 'BO_ACCELERATION',
      title: 'Bid/offer acceleration',
      rule: `B/O momentum at or above +${T.boAccelerationPct}% versus the counter's own 5-session average.`,
      tone: 'up',
      matches: boAcceleration.sort((a, b) => bySize(a, b, 'boMomentumPct')),
    },
    {
      code: 'BO_DETERIORATION',
      title: 'Bid/offer deterioration',
      rule: `B/O momentum at or below ${T.boDeteriorationPct}% versus the counter's own 5-session average.`,
      tone: 'down',
      matches: boDeterioration.sort((a, b) => bySize(a, b, 'boMomentumPct')),
    },
    {
      code: 'UNUSUAL_VOLUME',
      title: 'Unusual volume',
      rule: `Session volume at or above ${T.unusualVolumeRatio}× the 20-day average. Requires at least 10 sessions of history, so a newly listed counter cannot appear here.`,
      tone: 'warn',
      matches: unusualVolume.sort((a, b) => bySize(a, b, 'volumeRatio')),
    },
    {
      code: 'POSITIVE_MOMENTUM',
      title: 'Positive price momentum',
      rule: `5-day return at or above +${T.momentumReturnPct}%.`,
      tone: 'up',
      matches: positiveMomentum,
    },
    {
      code: 'NEGATIVE_MOMENTUM',
      title: 'Negative price momentum',
      rule: `5-day return at or below −${T.momentumReturnPct}%.`,
      tone: 'down',
      matches: negativeMomentum,
    },
    {
      code: 'POSSIBLE_UPWARD_REVERSAL',
      title: 'Possible upward reversal',
      rule: `ALL of: price down at least ${T.reversalReturnPct}%, B/O momentum up at least ${T.reversalBoPct}%, and volume at least ${T.reversalVolumeRatio}× its 20-day average. Price action alone never qualifies.`,
      tone: 'up',
      matches: upwardReversal,
    },
    {
      code: 'POSSIBLE_DOWNWARD_REVERSAL',
      title: 'Possible downward reversal',
      rule: `ALL of: price up at least ${T.reversalReturnPct}%, B/O momentum down at least ${T.reversalBoPct}%, and volume at least ${T.reversalVolumeRatio}× its 20-day average. Price action alone never qualifies.`,
      tone: 'down',
      matches: downwardReversal,
    },
  ];
}
