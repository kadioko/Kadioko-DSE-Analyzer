import Link from 'next/link';
import {
  dashboardSlices,
  latestSessionDate,
  marketSummary,
  marketTable,
} from '@/lib/services/market-service';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  Stat,
} from '@/components/ui/primitives';
import { SetupRequired } from '@/components/setup-required';
import { isDatabaseConfigured } from '@/lib/env';
import {
  ChangeCell,
  ConfidenceBadge,
  MoverList,
  PressureSignalBadge,
  ScoreBar,
} from '@/components/market/indicators';
import {
  formatCompactTzs,
  formatDateLong,
  formatNumber,
  formatRatio,
  NO_DATA,
} from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Market dashboard.
 *
 * Everything on this page describes ONE trading session, taken from the latest
 * date that has stored data. Before any import has happened the page shows an
 * explicit empty state - never zeros, never sample figures, because a zero on a
 * market dashboard reads as an observation.
 */
export default async function DashboardPage() {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const tradingDate = await latestSessionDate();

  if (!tradingDate) {
    return (
      <div className="space-y-6">
        <PageHeading date={null} />
        <EmptyState
          title="No market data has been imported yet"
          description="The database schema, ingestion validation and analytics engine are in place, but no DSE observations have been stored. Import an end-of-day file to populate the market."
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

  const [rows, summary] = await Promise.all([
    marketTable(tradingDate),
    marketSummary(tradingDate),
  ]);
  const slices = dashboardSlices(rows);

  return (
    <div className="space-y-6">
      <PageHeading date={tradingDate} />

      {summary === null ? (
        <Notice tone="warn" title="Market summary not generated">
          Observations exist for this date but the derived summary has not been
          built. Re-run the import, or regenerate analytics from the admin
          console.
        </Notice>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
            <Stat
              label="Turnover"
              value={formatCompactTzs(summary.totalTurnoverTzs)}
              sub="TZS"
            />
            <Stat label="Volume" value={formatCompactTzs(summary.totalVolume)} sub="shares" />
            <Stat label="Deals" value={formatNumber(summary.totalDeals)} />
            <Stat
              label="Counters traded"
              value={formatNumber(summary.countersTraded)}
              sub={
                summary.countersListed
                  ? `of ${formatNumber(summary.countersListed)} listed`
                  : undefined
              }
            />
            <Stat
              label="Market B/O"
              value={
                summary.marketBoRatio === null
                  ? NO_DATA
                  : formatRatio(summary.marketBoRatio)
              }
              tone={
                summary.marketBoRatio === null
                  ? 'neutral'
                  : summary.marketBoRatio > 1
                    ? 'up'
                    : 'down'
              }
              sub="total bid ÷ total offer"
              title="Quantity-weighted across every counter, not an average of individual ratios."
            />
            <Stat
              label="Breadth"
              value={
                <span className="text-base">
                  <span className="text-up-400">{summary.gainers ?? 0}</span>
                  <span className="text-ink-500"> / </span>
                  <span className="text-down-400">{summary.losers ?? 0}</span>
                  <span className="text-ink-500"> / </span>
                  <span className="text-ink-300">{summary.unchanged ?? 0}</span>
                </span>
              }
              sub="up / down / flat"
            />
          </div>

          <Card>
            <CardHeader
              title="Market pressure"
              description="Order-book supply and demand balance across the whole market. This describes flow, not value."
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <PressureSignalBadge signal={summary.marketPressureSignal} />
                  <ConfidenceBadge score={summary.dataConfidenceScore} />
                </div>
              }
            />
            <div className="grid gap-5 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
              <ScoreBar
                score={summary.marketPressureScore}
                label="Market pressure"
                title="0 = extreme supply pressure, 50 = balanced, 100 = extreme demand pressure."
              />
              <ScoreBar
                score={summary.breadthComponents.orderBook ?? null}
                label="Order book"
                title="Market-wide bid/offer ratio, log-scaled."
              />
              <ScoreBar
                score={summary.breadthComponents.breadth ?? null}
                label="Breadth"
                title="Advancing versus declining counters."
              />
              <ScoreBar
                score={summary.breadthComponents.turnoverWeightedPressure ?? null}
                label="Turnover-weighted"
                title="Average of individual pressure scores, weighted by turnover."
              />
            </div>
            <p className="border-t border-navy-800 px-5 py-3 text-xs leading-relaxed text-ink-500">
              Total resting bid {formatNumber(summary.totalBidQty)} shares against
              total offer {formatNumber(summary.totalOfferQty)} shares.{' '}
              <Link href="/methodology" className="text-accent-500 hover:text-accent-400">
                How this score is built
              </Link>
            </p>
          </Card>
        </>
      )}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader title="Top gainers" />
          <MoverList
            rows={slices.gainers}
            metric={(r) => <ChangeCell value={r.changePct} />}
            emptyMessage="No counter closed higher this session."
          />
        </Card>

        <Card>
          <CardHeader title="Top losers" />
          <MoverList
            rows={slices.losers}
            metric={(r) => <ChangeCell value={r.changePct} />}
            emptyMessage="No counter closed lower this session."
          />
        </Card>

        <Card>
          <CardHeader title="Most active" description="By turnover in TZS" />
          <MoverList
            rows={slices.mostActive}
            metric={(r) => (
              <span className="text-ink-200">{formatCompactTzs(r.turnoverTzs)}</span>
            )}
            emptyMessage="No counter traded this session."
          />
        </Card>

        <Card>
          <CardHeader
            title="Strongest demand pressure"
            description="Highest order-book pressure score"
          />
          <MoverList
            rows={slices.strongestDemand}
            metric={(r) => (
              <span className="text-up-400">{Math.round(r.pressureScore ?? 0)}</span>
            )}
            emptyMessage="No pressure scores could be computed for this session."
          />
        </Card>

        <Card>
          <CardHeader
            title="Strongest supply pressure"
            description="Lowest order-book pressure score"
          />
          <MoverList
            rows={slices.strongestSupply}
            metric={(r) => (
              <span className="text-down-400">{Math.round(r.pressureScore ?? 0)}</span>
            )}
            emptyMessage="No pressure scores could be computed for this session."
          />
        </Card>

        <Card>
          <CardHeader
            title="B/O momentum leaders"
            description="Largest rise versus the counter's own 5-session average"
          />
          <MoverList
            rows={slices.momentumLeaders}
            metric={(r) => <ChangeCell value={r.boMomentumPct} />}
            emptyMessage="Not enough order-book history yet to compute momentum."
          />
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader
            title="Unusual volume"
            description="Volume at least twice the counter's 20-day average"
            action={<Badge tone="warn">≥ 2.0×</Badge>}
          />
          <MoverList
            rows={slices.unusualVolume}
            metric={(r) => (
              <span className="text-warn-400">
                {formatRatio(r.volumeRatio)}× avg
              </span>
            )}
            emptyMessage="No counter traded unusual volume this session."
          />
        </Card>

        <Card>
          <CardHeader title="Reports" />
          <ul className="divide-y divide-navy-800">
            <ReportLink
              href={`/reports/daily/${tradingDate}`}
              label="Daily report"
              detail={formatDateLong(tradingDate)}
            />
            <ReportLink href="/market" label="Full market table" detail="All counters" />
            <ReportLink
              href="/methodology"
              label="Methodology"
              detail="Every formula and weight"
            />
          </ul>
        </Card>
      </div>
    </div>
  );
}

function PageHeading({ date }: { date: string | null }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">
          Market dashboard
        </h1>
        <p className="mt-1 text-[13px] text-ink-400">
          {date ? (
            <>
              Session of{' '}
              <span className="text-ink-200">{formatDateLong(date)}</span>
            </>
          ) : (
            'Awaiting the first data import'
          )}
        </p>
      </div>
      {date ? (
        <Link
          href="/market"
          className="text-[13px] text-accent-500 hover:text-accent-400"
        >
          Full market table →
        </Link>
      ) : null}
    </header>
  );
}

function ReportLink({
  href,
  label,
  detail,
}: {
  href: string;
  label: string;
  detail: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center justify-between px-5 py-2.5 hover:bg-navy-850"
      >
        <span className="text-[13px] text-ink-200">{label}</span>
        <span className="text-[11px] text-ink-500">{detail}</span>
      </Link>
    </li>
  );
}
