import Link from 'next/link';
import { Badge, cn, type BadgeTone } from '@/components/ui/primitives';
import {
  formatPctSigned,
  formatRatio,
  formatScore,
  NO_DATA,
} from '@/lib/format';
import type { BoState, MarketRow, PressureSignal } from '@/lib/types/market';

/**
 * Shared market indicators.
 *
 * Two rules run through all of these:
 *   - An unavailable value renders as an em dash with a title explaining why.
 *     It never renders as 0, and it never borrows a neighbouring value.
 *   - Colour carries meaning (direction, pressure side, confidence) and is
 *     never used decoratively.
 */

/* -------------------------------------------------------------------------- */
/* Bid / offer                                                                */
/* -------------------------------------------------------------------------- */

const BO_STATE_EXPLANATION: Record<BoState, string> = {
  NORMAL: 'Bids and offers on both sides of the book.',
  NO_BID: 'No bids on the board: the ratio is genuinely zero.',
  NO_OFFER:
    'No offers on the board, so the bid/offer ratio is undefined. It is not infinite, and no placeholder number is substituted.',
  EMPTY_BOOK: 'No resting orders on either side, so no ratio can be formed.',
};

/**
 * Renders a B/O ratio together with its book state.
 * The state is what makes a missing ratio readable rather than mysterious.
 */
export function BoRatioCell({
  ratio,
  state,
}: {
  ratio: number | null;
  state: BoState;
}) {
  if (ratio === null) {
    return (
      <span
        className="text-ink-500"
        title={BO_STATE_EXPLANATION[state]}
      >
        {NO_DATA}
        <span className="ml-1 text-[10px] uppercase tracking-wide">
          {state === 'NO_OFFER' ? 'no offer' : state === 'EMPTY_BOOK' ? 'no book' : ''}
        </span>
      </span>
    );
  }

  // Above 1 means more resting demand than supply.
  const tone = ratio > 1.15 ? 'text-up-400' : ratio < 0.87 ? 'text-down-400' : 'text-ink-200';

  return (
    <span className={tone} title={BO_STATE_EXPLANATION[state]}>
      {formatRatio(ratio)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Pressure                                                                   */
/* -------------------------------------------------------------------------- */

const SIGNAL_LABEL: Record<PressureSignal, string> = {
  STRONG_DEMAND: 'Strong demand',
  DEMAND: 'Demand',
  BALANCED: 'Balanced',
  SUPPLY: 'Supply',
  STRONG_SUPPLY: 'Strong supply',
  INSUFFICIENT_DATA: 'Insufficient data',
};

const SIGNAL_TONE: Record<PressureSignal, BadgeTone> = {
  STRONG_DEMAND: 'up',
  DEMAND: 'up',
  BALANCED: 'neutral',
  SUPPLY: 'down',
  STRONG_SUPPLY: 'down',
  INSUFFICIENT_DATA: 'muted',
};

export function PressureSignalBadge({ signal }: { signal: PressureSignal }) {
  return (
    <Badge
      tone={SIGNAL_TONE[signal]}
      title="Order-book supply/demand balance. Not investment advice, and not a buy signal on its own."
    >
      {SIGNAL_LABEL[signal]}
    </Badge>
  );
}

/**
 * A 0-100 score rendered as a number over a proportional bar.
 * When the score is null the bar is absent entirely rather than shown at zero,
 * because an empty bar reads as "lowest possible", not "unknown".
 */
export function ScoreBar({
  score,
  label,
  tone = 'pressure',
  title,
}: {
  score: number | null;
  label?: string;
  tone?: 'pressure' | 'neutral' | 'confidence';
  title?: string;
}) {
  if (score === null) {
    return (
      <div title={title ?? 'Not enough data to compute this score.'}>
        {label ? (
          <p className="text-[11px] uppercase tracking-wider text-ink-500">{label}</p>
        ) : null}
        <p className="num text-sm text-ink-500">{NO_DATA}</p>
      </div>
    );
  }

  const colour =
    tone === 'pressure'
      ? score >= 58
        ? 'bg-up-500'
        : score <= 42
          ? 'bg-down-500'
          : 'bg-ink-400'
      : tone === 'confidence'
        ? score >= 80
          ? 'bg-up-500'
          : score >= 60
            ? 'bg-warn-500'
            : 'bg-down-500'
        : 'bg-accent-500';

  return (
    <div title={title}>
      {label ? (
        <p className="text-[11px] uppercase tracking-wider text-ink-500">{label}</p>
      ) : null}
      <div className="mt-0.5 flex items-center gap-2">
        <span className="num w-8 text-sm font-semibold text-ink-100">
          {formatScore(score)}
        </span>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-navy-700">
          <span
            className={cn('block h-full rounded-full', colour)}
            style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
          />
        </span>
      </div>
    </div>
  );
}

/** Confidence rendered as a small badge with its band label. */
export function ConfidenceBadge({ score }: { score: number | null }) {
  if (score === null) {
    return <Badge tone="muted">Confidence {NO_DATA}</Badge>;
  }
  const tone: BadgeTone = score >= 80 ? 'up' : score >= 60 ? 'warn' : 'down';
  const label = score >= 80 ? 'High' : score >= 60 ? 'Moderate' : score >= 40 ? 'Low' : 'Very low';
  return (
    <Badge
      tone={tone}
      title="How much the data behind these scores can be relied on. Built from named penalties for missing, stale, thin or unverified data."
    >
      Confidence {formatScore(score)} · {label}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/* Change                                                                     */
/* -------------------------------------------------------------------------- */

export function ChangeCell({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-ink-500">{NO_DATA}</span>;
  }
  const tone =
    value > 0 ? 'text-up-400' : value < 0 ? 'text-down-400' : 'text-ink-300';
  return <span className={tone}>{formatPctSigned(value)}</span>;
}

/** Symbol as a link to its stock page, with the company name beneath. */
export function SymbolCell({
  symbol,
  name,
}: {
  symbol: string;
  name?: string | null;
}) {
  return (
    <Link href={`/stocks/${symbol}`} className="group block">
      <span className="font-medium text-ink-100 group-hover:text-accent-400">
        {symbol}
      </span>
      {name ? (
        <span className="block max-w-[180px] truncate text-[11px] text-ink-500">
          {name}
        </span>
      ) : null}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* Compact mover list                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The small ranked lists on the dashboard.
 * `metric` renders the number the list is ranked by, so each panel is explicit
 * about what put a counter in it.
 */
export function MoverList({
  rows,
  metric,
  emptyMessage,
}: {
  rows: readonly MarketRow[];
  metric: (row: MarketRow) => React.ReactNode;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-6 text-center text-[13px] text-ink-500">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-navy-800">
      {rows.map((row) => (
        <li
          key={row.instrumentId}
          className="flex items-center justify-between gap-3 px-5 py-2.5"
        >
          <SymbolCell symbol={row.symbol} name={row.name} />
          <span className="num shrink-0 text-[13px]">{metric(row)}</span>
        </li>
      ))}
    </ul>
  );
}
