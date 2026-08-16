import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  isoWeekOf,
  periodPerformance,
  periodTotals,
  sessionSeries,
} from '@/lib/services/report-service';
import { isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
import { formatDateLong } from '@/lib/format';
import { ReportView } from '../../report-view';

export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ date: string }>;
}): Promise<Metadata> {
  const { date } = await params;
  return {
    title: `Daily report · ${date}`,
    description: `DSE market report for ${date}: turnover, volume, order-book pressure, movers and liquidity.`,
  };
}

/** Daily market report for one trading date. */
export default async function DailyReportPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const { date } = await params;
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) notFound();

  const [totals, performers, sessions] = await Promise.all([
    periodTotals(date, date),
    periodPerformance(date, date),
    sessionSeries(date, date),
  ]);

  const { year, week } = isoWeekOf(date);
  const month = date.slice(0, 7);

  return (
    <ReportView
      title="Daily market report"
      subtitle={`${formatDateLong(date)} · ISO week ${week} of ${year} · ${month}`}
      totals={totals}
      performers={performers}
      sessions={sessions}
      // A single session's own row adds nothing beneath its own totals.
      showSessionTable={false}
    />
  );
}
