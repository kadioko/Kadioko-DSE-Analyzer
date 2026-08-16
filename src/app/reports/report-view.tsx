import Link from 'next/link';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  Stat,
  TableScroll,
  Td,
  Th,
} from '@/components/ui/primitives';
import { SymbolCell } from '@/components/market/indicators';
import {
  formatCompactTzs,
  formatDate,
  formatNumber,
  formatPctSigned,
  formatRatio,
  formatScore,
  NO_DATA,
} from '@/lib/format';
import type {
  PeriodPerformer,
  PeriodTotals,
} from '@/lib/services/report-service';

/**
 * Shared report body for the daily, weekly and monthly reports.
 *
 * One component rather than three, because the three reports differ only in
 * their period bounds. Duplicating the layout would let them drift apart, and a
 * weekly report that computes turnover differently from the daily one is a bug
 * waiting to happen.
 */

interface SessionRow {
  tradingDate: string;
  totalTurnoverTzs: number | null;
  totalVolume: number | null;
  totalDeals: number | null;
  countersTraded: number | null;
  marketBoRatio: number | null;
  marketPressureScore: number | null;
  gainers: number | null;
  losers: number | null;
  unchanged: number | null;
}

export function ReportView({
  title,
  subtitle,
  totals,
  performers,
  sessions,
  showSessionTable = true,
}: {
  title: string;
  subtitle: string;
  totals: PeriodTotals;
  performers: PeriodPerformer[];
  sessions: SessionRow[];
  showSessionTable?: boolean;
}) {
  if (totals.sessions === 0) {
    return (
      <div className="space-y-5">
        <ReportHeader title={title} subtitle={subtitle} />
        <EmptyState
          title="No data for this period"
          description="Nothing has been imported for these dates. This is not a report of a quiet market — it is an absence of data."
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

  const ranked = performers.filter((p) => p.returnPct !== null);
  const gainers = [...ranked]
    .sort((a, b) => (b.returnPct as number) - (a.returnPct as number))
    .slice(0, 10);
  const losers = [...ranked]
    .sort((a, b) => (a.returnPct as number) - (b.returnPct as number))
    .slice(0, 10);
  const mostActive = [...performers]
    .sort((a, b) => (b.turnoverTzs ?? 0) - (a.turnoverTzs ?? 0))
    .slice(0, 10);
  const liquidityLeaders = [...performers]
    .sort((a, b) => b.sessionsTraded - a.sessionsTraded || (b.deals ?? 0) - (a.deals ?? 0))
    .slice(0, 10);

  return (
    <div className="space-y-5">
      <ReportHeader title={title} subtitle={subtitle} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Sessions" value={formatNumber(totals.sessions)} />
        <Stat
          label="Turnover"
          value={formatCompactTzs(totals.totalTurnoverTzs)}
          sub="TZS"
        />
        <Stat label="Volume" value={formatCompactTzs(totals.totalVolume)} sub="shares" />
        <Stat label="Deals" value={formatNumber(totals.totalDeals)} />
        <Stat
          label="Avg market B/O"
          value={formatRatio(totals.avgMarketBoRatio)}
          sub="mean of daily ratios"
        />
        <Stat
          label="Avg pressure"
          value={formatScore(totals.avgMarketPressure)}
          tone={
            totals.avgMarketPressure === null
              ? 'neutral'
              : totals.avgMarketPressure >= 58
                ? 'up'
                : totals.avgMarketPressure <= 42
                  ? 'down'
                  : 'neutral'
          }
        />
      </div>

      <Notice tone="neutral">
        Totals are summed in the database from stored daily summaries, so the
        figures above always agree with the sessions listed beneath them.
        Averages are means of the daily values, not recomputed from raw rows.
      </Notice>

      <div className="grid gap-4 xl:grid-cols-2">
        <PerformerCard
          title="Top performers"
          description="By price return across the period"
          rows={gainers}
          metric={(p) => (
            <span className="text-up-400">{formatPctSigned(p.returnPct)}</span>
          )}
          emptyMessage="No counter had a price at both ends of the period."
        />
        <PerformerCard
          title="Worst performers"
          description="By price return across the period"
          rows={losers}
          metric={(p) => (
            <span className="text-down-400">{formatPctSigned(p.returnPct)}</span>
          )}
          emptyMessage="No counter had a price at both ends of the period."
        />
        <PerformerCard
          title="Most active"
          description="By total turnover"
          rows={mostActive}
          metric={(p) => (
            <span className="text-ink-200">{formatCompactTzs(p.turnoverTzs)}</span>
          )}
          emptyMessage="No turnover recorded."
        />
        <PerformerCard
          title="Liquidity leaders"
          description="By number of sessions actually traded"
          rows={liquidityLeaders}
          metric={(p) => (
            <span className="text-ink-200">
              {p.sessionsTraded} / {totals.sessions} sessions
            </span>
          )}
          emptyMessage="No counter traded during this period."
        />
      </div>

      <Card>
        <CardHeader
          title="All counters"
          description="Period return uses the first and last close that exist inside the window, so a counter that did not trade on the boundary session still gets a figure."
        />
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Symbol</Th>
                <Th align="right">First close</Th>
                <Th align="right">Last close</Th>
                <Th align="right">Return</Th>
                <Th align="right">Turnover</Th>
                <Th align="right">Volume</Th>
                <Th align="right">Deals</Th>
                <Th align="right">Sessions</Th>
                <Th align="right">Avg B/O</Th>
                <Th align="right">Avg pressure</Th>
              </tr>
            </thead>
            <tbody>
              {performers.map((p) => (
                <tr key={p.symbol} className="hover:bg-navy-850">
                  <Td>
                    <SymbolCell symbol={p.symbol} name={p.name} />
                  </Td>
                  <Td align="right">{formatNumber(p.firstClose)}</Td>
                  <Td align="right">{formatNumber(p.lastClose)}</Td>
                  <Td align="right">
                    <span
                      className={
                        p.returnPct === null
                          ? 'text-ink-500'
                          : p.returnPct > 0
                            ? 'text-up-400'
                            : p.returnPct < 0
                              ? 'text-down-400'
                              : 'text-ink-300'
                      }
                    >
                      {formatPctSigned(p.returnPct)}
                    </span>
                  </Td>
                  <Td align="right">{formatCompactTzs(p.turnoverTzs)}</Td>
                  <Td align="right">{formatNumber(p.volume)}</Td>
                  <Td align="right">{formatNumber(p.deals)}</Td>
                  <Td align="right">{p.sessionsTraded}</Td>
                  <Td align="right">{formatRatio(p.avgBoRatio)}</Td>
                  <Td align="right">{formatScore(p.avgPressure)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Card>

      {showSessionTable && sessions.length > 0 ? (
        <Card>
          <CardHeader title="Sessions in this period" />
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th align="right">Turnover</Th>
                  <Th align="right">Volume</Th>
                  <Th align="right">Deals</Th>
                  <Th align="right">Traded</Th>
                  <Th align="right">Market B/O</Th>
                  <Th align="right">Pressure</Th>
                  <Th align="right">Up / Down / Flat</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.tradingDate} className="hover:bg-navy-850">
                    <Td>{formatDate(s.tradingDate)}</Td>
                    <Td align="right">{formatCompactTzs(s.totalTurnoverTzs)}</Td>
                    <Td align="right">{formatNumber(s.totalVolume)}</Td>
                    <Td align="right">{formatNumber(s.totalDeals)}</Td>
                    <Td align="right">{formatNumber(s.countersTraded)}</Td>
                    <Td align="right">{formatRatio(s.marketBoRatio)}</Td>
                    <Td align="right">{formatScore(s.marketPressureScore)}</Td>
                    <Td align="right">
                      <span className="text-up-400">{s.gainers ?? 0}</span>
                      <span className="text-ink-500"> / </span>
                      <span className="text-down-400">{s.losers ?? 0}</span>
                      <span className="text-ink-500"> / </span>
                      <span className="text-ink-300">{s.unchanged ?? 0}</span>
                    </Td>
                    <Td>
                      <Link
                        href={`/reports/daily/${s.tradingDate}`}
                        className="text-accent-500 hover:text-accent-400"
                      >
                        Daily
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Export" />
        <CardBody className="space-y-2 text-[13px] text-ink-300">
          <p>
            This period as CSV, for the Kadioko DSE Sheet or any other consumer:
          </p>
          <p className="num break-all text-ink-100">
            /api/export/daily?from={totals.firstSession}&amp;to={totals.lastSession}
            &amp;format=csv
          </p>
          <a
            href={`/api/export/daily?from=${totals.firstSession}&to=${totals.lastSession}&format=csv`}
            className="inline-block rounded bg-navy-700 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-navy-600"
          >
            Download CSV
          </a>
        </CardBody>
      </Card>
    </div>
  );
}

function ReportHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <Link
          href="/reports"
          className="text-[13px] text-accent-500 hover:text-accent-400"
        >
          ← Reports
        </Link>
        <h1 className="mt-2 text-lg font-semibold tracking-tight text-ink-100">
          {title}
        </h1>
        <p className="mt-1 text-[13px] text-ink-400">{subtitle}</p>
      </div>
    </header>
  );
}

function PerformerCard({
  title,
  description,
  rows,
  metric,
  emptyMessage,
}: {
  title: string;
  description: string;
  rows: PeriodPerformer[];
  metric: (row: PeriodPerformer) => React.ReactNode;
  emptyMessage: string;
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      {rows.length === 0 ? (
        <CardBody>
          <p className="text-[13px] text-ink-500">{emptyMessage}</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-navy-800">
          {rows.map((row) => (
            <li
              key={row.symbol}
              className="flex items-center justify-between gap-3 px-5 py-2.5"
            >
              <SymbolCell symbol={row.symbol} name={row.name} />
              <span className="num shrink-0 text-[13px]">{metric(row)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export { NO_DATA };
