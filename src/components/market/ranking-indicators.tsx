import { Badge, cn, type BadgeTone } from '@/components/ui/primitives';
import { NO_DATA } from '@/lib/format';
import {
  DEMAND_LABELS,
  GRADE_LABELS,
  getLiquidityBand,
  LIQUIDITY_LABELS,
  roundScore,
} from '@/lib/analytics/ranking';
import type {
  ExclusionReason,
  InterpretationCode,
  MarketDemand,
  RankingGrade,
} from '@/lib/db/schema';

/**
 * Ranking display primitives.
 *
 * Every score here carries a tooltip explaining what it is, because a bare
 * number labelled "Overall" invites the reader to assume it means more than it
 * does. Colour encodes grade and direction only.
 */

export const OVERALL_TOOLTIP =
  '70% Fundamental Score + 30% Market Sentiment. This score ranks relative attractiveness under the current Kadioko Overall model and is not a guaranteed investment outcome.';

export const FUNDAMENTAL_TOOLTIP =
  'Business quality derived from published financial results: profitability, margins, growth, balance sheet, cash conversion and dividend record. It contains nothing about price or the order book.';

export const SENTIMENT_TOOLTIP =
  'The market pressure score for this session: the balance of resting demand against resting supply, with price and volume confirmation. It describes current market behaviour, not company quality.';

export const CONFIDENCE_TOOLTIP =
  'How much the data behind these scores can be relied on. Built from named penalties for missing, stale, thin or unverified data. A high score with low confidence should be treated with caution.';

export const LIQUIDITY_TOOLTIP =
  'How readily the security can be traded. The DSE contains thinly traded counters whose order-book ratios can look dramatic on very little activity.';

const GRADE_TONE: Record<RankingGrade, BadgeTone> = {
  BORA_SANA: 'up',
  NZURI_SANA: 'up',
  NZURI: 'accent',
  WASTANI: 'neutral',
  DHAIFU: 'warn',
  DHAIFU_SANA: 'down',
};

export function GradeBadge({ grade }: { grade: RankingGrade | null }) {
  if (!grade) {
    return (
      <Badge tone="muted" title="Not enough data to grade this security.">
        {NO_DATA}
      </Badge>
    );
  }
  const label = GRADE_LABELS[grade];
  return (
    <Badge tone={GRADE_TONE[grade]} title={`${label.en} (${label.sw})`}>
      {label.sw}
    </Badge>
  );
}

const DEMAND_TONE: Record<MarketDemand, BadgeTone> = {
  DEMAND_KUBWA_SANA: 'up',
  DEMAND_KUBWA: 'up',
  DEMAND_WASTANI: 'neutral',
  DEMAND_NDOGO_SANA: 'down',
};

export function DemandBadge({ demand }: { demand: MarketDemand | null }) {
  if (!demand) {
    return <Badge tone="muted">{NO_DATA}</Badge>;
  }
  const label = DEMAND_LABELS[demand];
  return (
    <Badge tone={DEMAND_TONE[demand]} title={`${label.en}. Derived from the sentiment score alone, not from the overall score.`}>
      {label.sw}
    </Badge>
  );
}

export function LiquidityBadge({ score }: { score: number | null }) {
  const band = getLiquidityBand(score);
  const label = LIQUIDITY_LABELS[band];
  const tone: BadgeTone =
    band === 'HIGH' ? 'up'
    : band === 'MEDIUM' ? 'neutral'
    : band === 'LOW' ? 'warn'
    : band === 'VERY_LOW' ? 'down'
    : 'muted';

  return (
    <Badge tone={tone} title={`${label.en}. ${LIQUIDITY_TOOLTIP}`}>
      {label.en}
    </Badge>
  );
}

/** Rank movement. Positive is an improvement toward rank 1. */
export function RankChange({
  change,
  isNewEntrant,
}: {
  change: number | null;
  isNewEntrant: boolean;
}) {
  if (isNewEntrant) {
    return (
      <Badge tone="accent" title="Not present in the previous ranking snapshot.">
        NEW
      </Badge>
    );
  }
  if (change === null) {
    return <span className="text-ink-500">{NO_DATA}</span>;
  }
  if (change === 0) {
    return <span className="text-ink-400" title="No change since the previous snapshot.">—</span>;
  }
  const up = change > 0;
  return (
    <span
      className={up ? 'text-up-400' : 'text-down-400'}
      title={`Moved ${Math.abs(change)} place${Math.abs(change) === 1 ? '' : 's'} ${up ? 'up' : 'down'} since the previous snapshot.`}
    >
      {up ? '▲' : '▼'} {Math.abs(change)}
    </span>
  );
}

/** Score with an explanatory tooltip. Renders a dash when unavailable. */
export function ScoreValue({
  score,
  tooltip,
  emphasis = false,
}: {
  score: number | null;
  tooltip: string;
  emphasis?: boolean;
}) {
  const rounded = roundScore(score);
  if (rounded === null) {
    return (
      <span className="text-ink-500" title={`${tooltip} Not available for this security.`}>
        {NO_DATA}
      </span>
    );
  }
  return (
    <span
      title={tooltip}
      className={cn(emphasis ? 'font-semibold text-ink-100' : 'text-ink-200')}
    >
      {rounded.toFixed(1)}
    </span>
  );
}

/** Medal-style rank marker for the top three. Deliberately restrained. */
export function RankCell({ rank }: { rank: number | null }) {
  if (rank === null) {
    return (
      <span className="text-ink-500" title="Not eligible to be ranked.">
        {NO_DATA}
      </span>
    );
  }
  const distinguished = rank <= 3;
  return (
    <span
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-[13px] font-semibold',
        distinguished
          ? rank === 1
            ? 'bg-warn-500/20 text-warn-400 ring-1 ring-warn-500/40'
            : 'bg-navy-700 text-ink-100'
          : 'text-ink-300',
      )}
    >
      {rank}
    </span>
  );
}

export const EXCLUSION_SHORT: Record<ExclusionReason, string> = {
  MISSING_FUNDAMENTALS: 'No financials',
  MISSING_SENTIMENT: 'No sentiment',
  STALE_FUNDAMENTALS: 'Stale financials',
  BELOW_MINIMUM_CONFIDENCE: 'Low confidence',
  BELOW_MINIMUM_LIQUIDITY: 'Low liquidity',
  INSTRUMENT_INACTIVE: 'Inactive',
};

export const INTERPRETATION_TONE: Record<InterpretationCode, BadgeTone> = {
  QUALITY_AND_TREND_ALIGNED: 'up',
  QUALITY_AWAITING_TREND: 'accent',
  AVERAGE_QUALITY: 'neutral',
  AVERAGE_QUALITY_WEAK_TREND: 'warn',
  WEAK_QUALITY: 'down',
};
