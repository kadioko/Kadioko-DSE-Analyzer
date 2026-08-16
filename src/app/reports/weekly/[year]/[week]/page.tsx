import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  isoWeekBounds,
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
  params: Promise<{ year: string; week: string }>;
}): Promise<Metadata> {
  const { year, week } = await params;
  return {
    title: `Weekly report · week ${week} of ${year}`,
    description: `DSE weekly market report for ISO week ${week} of ${year}.`,
  };
}

/**
 * Weekly market report.
 *
 * Weeks are ISO-8601 (Monday start). A Sunday-start week would silently
 * disagree with the same "week 33" label used everywhere else.
 */
export default async function WeeklyReportPage({
  params,
}: {
  params: Promise<{ year: string; week: string }>;
}) {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const { year: yearParam, week: weekParam } = await params;
  const year = Number(yearParam);
  const week = Number(weekParam);

  if (
    !Number.isInteger(year) ||
    year < 1990 ||
    year > 2200 ||
    !Number.isInteger(week) ||
    week < 1 ||
    week > 53
  ) {
    notFound();
  }

  const bounds = isoWeekBounds(year, week);

  const [totals, performers, sessions] = await Promise.all([
    periodTotals(bounds.from, bounds.to),
    periodPerformance(bounds.from, bounds.to),
    sessionSeries(bounds.from, bounds.to),
  ]);

  return (
    <ReportView
      title="Weekly market report"
      subtitle={`${bounds.label} · ${formatDate(bounds.from)} to ${formatDate(bounds.to)} (ISO week, Monday start)`}
      totals={totals}
      performers={performers}
      sessions={sessions}
    />
  );
}
