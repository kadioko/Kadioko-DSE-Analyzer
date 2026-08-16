import type { Metadata } from 'next';
import Link from 'next/link';
import { latestSessionDate, marketTable } from '@/lib/services/market-service';
import { listSectors } from '@/lib/db/repositories/instruments';
import { EmptyState, Notice } from '@/components/ui/primitives';
import { SetupRequired } from '@/components/setup-required';
import { isDatabaseConfigured } from '@/lib/env';
import { formatDateLong } from '@/lib/format';
import { MarketTable } from './market-table';

export const metadata: Metadata = {
  title: 'Market',
  description: 'Every DSE-listed counter for the latest trading session.',
};
export const dynamic = 'force-dynamic';

/**
 * Full market table.
 *
 * A date may be requested with ?date=YYYY-MM-DD; otherwise the latest session
 * with stored data is used. Requesting a date with no data shows an explicit
 * notice rather than an empty table, which would read as "nothing traded".
 */
export default async function MarketPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const params = await searchParams;
  const latest = await latestSessionDate();

  if (!latest) {
    return (
      <EmptyState
        title="No market data has been imported yet"
        description="Import a DSE end-of-day file to populate the market table."
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

  const requested =
    params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : latest;

  const [rows, sectors] = await Promise.all([
    marketTable(requested),
    listSectors(),
  ]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-100">
            Market
          </h1>
          <p className="mt-1 text-[13px] text-ink-400">
            Session of{' '}
            <span className="text-ink-200">{formatDateLong(requested)}</span>
          </p>
        </div>
        <Link
          href={`/reports/daily/${requested}`}
          className="text-[13px] text-accent-500 hover:text-accent-400"
        >
          Daily report →
        </Link>
      </header>

      {rows.length === 0 ? (
        <Notice tone="warn" title="No data for this date">
          Nothing has been imported for {formatDateLong(requested)}. The most
          recent session with data is{' '}
          <Link href="/market" className="text-accent-500 hover:text-accent-400">
            {formatDateLong(latest)}
          </Link>
          .
        </Notice>
      ) : (
        <MarketTable rows={rows} sectors={sectors} />
      )}
    </div>
  );
}
