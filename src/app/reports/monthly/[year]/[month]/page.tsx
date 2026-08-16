import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  monthBounds,
  periodPerformance,
  periodTotals,
  sessionSeries,
} from '@/lib/services/report-service';
import { isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
import { formatDate } from '@/lib/format';
import { ReportView } from '../../../report-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ year: string; month: string }>;
}): Promise<Metadata> {
  const { year, month } = await params;
  return {
    title: `Monthly report · ${year}-${month}`,
    description: `DSE monthly market report for ${year}-${month}.`,
  };
}

/** Monthly market report over a calendar month. */
export default async function MonthlyReportPage({
  params,
}: {
  params: Promise<{ year: string; month: string }>;
}) {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const { year: yearParam, month: monthParam } = await params;
  const year = Number(yearParam);
  const month = Number(monthParam);

  if (
    !Number.isInteger(year) ||
    year < 1990 ||
    year > 2200 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    notFound();
  }

  const bounds = monthBounds(year, month);

  const [totals, performers, sessions] = await Promise.all([
    periodTotals(bounds.from, bounds.to),
    periodPerformance(bounds.from, bounds.to),
    sessionSeries(bounds.from, bounds.to),
  ]);

  return (
    <ReportView
      title="Monthly market report"
      subtitle={`${bounds.label} · ${formatDate(bounds.from)} to ${formatDate(bounds.to)}`}
      totals={totals}
      performers={performers}
      sessions={sessions}
    />
  );
}
