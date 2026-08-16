import type { Metadata } from 'next';
import Link from 'next/link';
import {
  availableSessions,
  isoWeekOf,
} from '@/lib/services/report-service';
import { isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
} from '@/components/ui/primitives';
import { formatDateLong } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Reports',
  description: 'Daily, weekly and monthly DSE market reports.',
};
export const dynamic = 'force-dynamic';

/** Index of every period that has data, so no link leads to an empty report. */
export default async function ReportsIndexPage() {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const sessions = await availableSessions(60);

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No market data has been imported yet"
        description="Reports are built from stored sessions."
        action={
          <Link
            href="/admin/data"
            className="inline-block rounded bg-accent-600 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-accent-500"
          >
            Go to data administration
          </Link>
        }
      />
    );
  }

  // Only periods that actually contain a stored session are offered.
  const weeks = new Map<string, { year: number; week: number }>();
  const months = new Map<string, { year: number; month: number; label: string }>();

  for (const date of sessions) {
    const { year, week } = isoWeekOf(date);
    weeks.set(`${year}-${week}`, { year, week });

    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    months.set(`${y}-${m}`, {
      year: y,
      month: m,
      label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    });
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">
          Reports
        </h1>
        <p className="mt-1 text-[13px] text-ink-400">
          Only periods containing stored sessions are listed, so no link here
          leads to an empty report.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Daily"
            description={`${sessions.length} session${sessions.length === 1 ? '' : 's'} with data`}
          />
          <ul className="max-h-96 divide-y divide-navy-800 overflow-y-auto">
            {sessions.map((date) => (
              <li key={date}>
                <Link
                  href={`/reports/daily/${date}`}
                  className="block px-5 py-2.5 text-[13px] text-ink-200 hover:bg-navy-850"
                >
                  {formatDateLong(date)}
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Weekly" description="ISO weeks, Monday start" />
          {weeks.size === 0 ? (
            <CardBody>
              <p className="text-[13px] text-ink-500">No weeks with data.</p>
            </CardBody>
          ) : (
            <ul className="max-h-96 divide-y divide-navy-800 overflow-y-auto">
              {[...weeks.values()]
                .sort((a, b) => b.year - a.year || b.week - a.week)
                .map((w) => (
                  <li key={`${w.year}-${w.week}`}>
                    <Link
                      href={`/reports/weekly/${w.year}/${w.week}`}
                      className="block px-5 py-2.5 text-[13px] text-ink-200 hover:bg-navy-850"
                    >
                      Week {w.week}, {w.year}
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Monthly" description="Calendar months" />
          {months.size === 0 ? (
            <CardBody>
              <p className="text-[13px] text-ink-500">No months with data.</p>
            </CardBody>
          ) : (
            <ul className="max-h-96 divide-y divide-navy-800 overflow-y-auto">
              {[...months.values()]
                .sort((a, b) => b.year - a.year || b.month - a.month)
                .map((m) => (
                  <li key={`${m.year}-${m.month}`}>
                    <Link
                      href={`/reports/monthly/${m.year}/${m.month}`}
                      className="block px-5 py-2.5 text-[13px] text-ink-200 hover:bg-navy-850"
                    >
                      {m.label}
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
