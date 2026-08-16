import type { Metadata } from 'next';
import Link from 'next/link';
import {
  availableRankingDates,
  getRankingSnapshot,
  latestRankingDate,
} from '@/lib/services/ranking-service';
import { listSectors } from '@/lib/db/repositories/instruments';
import { latestTradingDate } from '@/lib/db/repositories/market';
import { hasAnyFundamentalScores } from '@/lib/services/fundamental-service';
import { isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  Stat,
} from '@/components/ui/primitives';
import {
  CONFIDENCE_TOOLTIP,
  DemandBadge,
  FUNDAMENTAL_TOOLTIP,
  GradeBadge,
  LiquidityBadge,
  OVERALL_TOOLTIP,
  RankChange,
  SENTIMENT_TOOLTIP,
} from '@/components/market/ranking-indicators';
import { formatDateLong, formatScore, NO_DATA } from '@/lib/format';
import { roundScore } from '@/lib/analytics/ranking';
import { RankingsTable } from './rankings-table';

export const metadata: Metadata = {
  title: 'Rankings',
  description:
    'Kadioko DSE Rankings: fundamental strength combined with current market sentiment.',
};
export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Kadioko DSE Rankings.
 *
 * Historical dates are served from stored snapshots, never recomputed, so an
 * older ranking shows exactly what was published then.
 */
export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const params = await searchParams;
  const latest = await latestRankingDate();

  if (!latest) {
    return <NoRankingsYet />;
  }

  const requested =
    params.date && ISO_DATE.test(params.date) ? params.date : latest;

  const [snapshot, sectors, dates, marketDate] = await Promise.all([
    getRankingSnapshot(requested),
    listSectors(),
    availableRankingDates(60),
    latestTradingDate(),
  ]);

  if (!snapshot) {
    return (
      <div className="space-y-5">
        <Header />
        <Notice tone="warn" title="No snapshot for this date">
          No ranking was generated for {formatDateLong(requested)}.{' '}
          <Link href="/rankings" className="text-accent-500 hover:text-accent-400">
            View the latest ranking
          </Link>
          .
        </Notice>
      </div>
    );
  }

  const top = snapshot.rows.find((r) => r.rank === 1) ?? null;

  return (
    <div className="space-y-5">
      <Header />

      <Card>
        <CardBody className="flex flex-wrap items-end justify-between gap-4">
          <dl className="grid gap-x-8 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <Meta label="Ranking date" value={formatDateLong(snapshot.tradingDate)} />
            <Meta
              label="Fundamental period"
              value={
                snapshot.fundamentalPeriod
                  ? formatDateLong(snapshot.fundamentalPeriod)
                  : 'None on file'
              }
            />
            <Meta
              label="Last market data"
              value={marketDate ? formatDateLong(marketDate) : NO_DATA}
            />
            <Meta
              label="Model"
              value={`${snapshot.model.name} v${snapshot.model.version}`}
            />
          </dl>

          <form className="flex items-end gap-2" action="/rankings" method="get">
            <label className="block">
              <span className="block text-[11px] uppercase tracking-wider text-ink-500">
                Ranking date
              </span>
              <select
                name="date"
                defaultValue={snapshot.tradingDate}
                className="mt-1 rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-100"
              >
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {formatDateLong(d)}
                    {d === latest ? ' (latest)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded bg-navy-700 px-3 py-2 text-sm font-medium text-ink-100 hover:bg-navy-600"
            >
              View
            </button>
          </form>
        </CardBody>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Weighting"
          value={`${Math.round(snapshot.model.fundamentalWeight * 100)} / ${Math.round(snapshot.model.sentimentWeight * 100)}`}
          sub="Fundamental / Sentiment"
          title={OVERALL_TOOLTIP}
        />
        <Stat label="Securities ranked" value={String(snapshot.ranked)} />
        <Stat
          label="Not ranked"
          value={String(snapshot.excluded)}
          tone={snapshot.excluded > 0 ? 'warn' : 'neutral'}
          sub="Reason shown per security"
        />
        <Stat label="Considered" value={String(snapshot.considered)} />
      </div>

      {snapshot.notes ? (
        <Notice tone={snapshot.ranked === 0 ? 'down' : 'warn'} title="Snapshot notes">
          {snapshot.notes}
        </Notice>
      ) : null}

      {snapshot.ranked === 0 ? (
        <MissingFundamentals />
      ) : top ? (
        <TopCompanyHero row={top} totalRanked={snapshot.ranked} />
      ) : null}

      <RankingsTable rows={snapshot.rows} sectors={sectors} />

      <Card>
        <CardHeader title="How to read this ranking" />
        <CardBody className="space-y-3 text-[13px] leading-relaxed text-ink-300">
          <p>
            <b className="text-ink-100">Fundamental</b> and{' '}
            <b className="text-ink-100">Sentiment</b> measure different things
            and are never interchangeable. A security can have weak fundamentals
            and excellent sentiment and still rank poorly — that is the model
            working as intended, because {Math.round(snapshot.model.fundamentalWeight * 100)}%
            of the overall score is business quality.
          </p>
          <p>
            The <b className="text-ink-100">Uamuzi</b> column is not a function
            of the overall score. It reads fundamental quality and sentiment
            separately, and no amount of market enthusiasm produces
            accumulate-style language on a weak business.
          </p>
          <p className="text-ink-500">
            This ranking has not been backtested. It describes relative
            attractiveness under a stated model; it is not a prediction and not
            investment advice.{' '}
            <Link href="/methodology" className="text-accent-500 hover:text-accent-400">
              Full methodology
            </Link>
            .
          </p>
          <a
            href={`/api/export/rankings?date=${snapshot.tradingDate}&format=csv`}
            className="inline-block rounded bg-navy-700 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-navy-600"
          >
            Download this ranking as CSV
          </a>
        </CardBody>
      </Card>
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-lg font-semibold tracking-tight text-ink-100">
        Kadioko DSE Rankings
      </h1>
      <p className="mt-1 text-[13px] text-ink-400">
        Fundamental strength × current market sentiment
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone="accent" title={FUNDAMENTAL_TOOLTIP}>Fundamental 70%</Badge>
        <Badge tone="neutral" title={SENTIMENT_TOOLTIP}>Sentiment 30%</Badge>
      </div>
    </header>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-ink-200">{value}</dd>
    </div>
  );
}

/** Rank #1. Not hardcoded to any company — it is whatever ranks first. */
function TopCompanyHero({
  row,
  totalRanked,
}: {
  row: import('@/lib/services/ranking-service').RankingRow;
  totalRanked: number;
}) {
  return (
    <Card className="border-warn-500/30 bg-gradient-to-br from-navy-850 to-navy-900">
      <CardHeader
        title="KAMPUNI BORA KWA UJUMLA"
        description={`Highest overall score of ${totalRanked} ranked securities`}
        action={<RankChange change={row.rankChange} isNewEntrant={row.isNewEntrant} />}
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <Link
              href={`/stocks/${row.symbol}`}
              className="text-2xl font-semibold tracking-tight text-ink-100 hover:text-accent-400"
            >
              {row.symbol}
            </Link>
            <p className="mt-0.5 text-sm text-ink-300">{row.name}</p>
          </div>
          <div className="text-right">
            <p
              className="num text-3xl font-semibold text-warn-400"
              title={OVERALL_TOOLTIP}
            >
              {roundScore(row.overallScore)?.toFixed(1) ?? NO_DATA}
            </p>
            <p className="text-[11px] uppercase tracking-wider text-ink-500">
              Overall score
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Fundamental"
            value={roundScore(row.fundamentalScore)?.toFixed(1) ?? NO_DATA}
            title={FUNDAMENTAL_TOOLTIP}
          />
          <Stat
            label="Sentiment"
            value={roundScore(row.sentimentScore)?.toFixed(1) ?? NO_DATA}
            title={SENTIMENT_TOOLTIP}
          />
          <Stat
            label="Confidence"
            value={formatScore(row.dataConfidence)}
            tone={
              row.dataConfidence === null
                ? 'neutral'
                : row.dataConfidence >= 80
                  ? 'up'
                  : row.dataConfidence >= 60
                    ? 'warn'
                    : 'down'
            }
            title={CONFIDENCE_TOOLTIP}
          />
          <Stat
            label="Fundamental period"
            value={row.fundamentalPeriod ?? NO_DATA}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <GradeBadge grade={row.grade} />
          <DemandBadge demand={row.marketDemand} />
          <LiquidityBadge score={row.liquidityScore} />
        </div>

        {row.interpretationSw ? (
          <div className="rounded border border-navy-700 bg-navy-950 px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-ink-500">
              Uamuzi
            </p>
            <p className="mt-1 text-sm text-ink-100">{row.interpretationSw}</p>
            <p className="mt-0.5 text-[13px] text-ink-400">
              {row.interpretationEn}
            </p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function MissingFundamentals() {
  return (
    <Notice tone="warn" title="No security could be ranked">
      <p>
        Every security was excluded, almost certainly because no fundamental
        scores exist yet. The ranking model is 70% business quality, so it
        cannot rank a security whose financial results have not been entered.
      </p>
      <p className="mt-2">
        Import published annual or interim results at{' '}
        <Link href="/admin/data" className="underline">
          /admin/data
        </Link>
        , then recalculate. Nothing is estimated in the meantime: an invented
        fundamental score would produce a ranking that looks authoritative and
        means nothing.
      </p>
    </Notice>
  );
}

async function NoRankingsYet() {
  const [hasFundamentals, marketDate] = await Promise.all([
    hasAnyFundamentalScores(),
    latestTradingDate(),
  ]);

  return (
    <div className="space-y-5">
      <Header />
      <EmptyState
        title="No ranking has been generated yet"
        description={
          !marketDate
            ? 'Rankings need market analytics and at least one fundamental score. No market data has been imported yet.'
            : !hasFundamentals
              ? 'Market data exists, but no financial results have been imported. The ranking is 70% business quality, so it cannot run without them.'
              : 'Market data and fundamental scores exist. Run a recalculation to generate the first snapshot.'
        }
        action={
          <Link
            href="/admin/data"
            className="inline-block rounded bg-accent-600 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-accent-500"
          >
            Go to data administration
          </Link>
        }
      />
    </div>
  );
}
