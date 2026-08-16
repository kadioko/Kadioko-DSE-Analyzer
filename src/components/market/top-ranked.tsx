import Link from 'next/link';
import { getTopRanked } from '@/lib/services/ranking-service';
import { Card, CardBody, CardHeader } from '@/components/ui/primitives';
import {
  GradeBadge,
  OVERALL_TOOLTIP,
  RankCell,
  RankChange,
} from '@/components/market/ranking-indicators';
import { formatDate, NO_DATA } from '@/lib/format';
import { roundScore } from '@/lib/analytics/ranking';

/**
 * Top-ranked securities for the dashboard.
 *
 * Renders nothing when no ranking exists, so the dashboard is not padded with
 * an empty panel. Deliberately compact — the dashboard's job is the market
 * session, and the ranking has its own page.
 */
export async function TopRanked({ limit = 5 }: { limit?: number }) {
  const top = await getTopRanked(limit);
  if (!top || top.rows.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Top ranked DSE companies"
        description={`Overall model · ${formatDate(top.tradingDate)}`}
        action={
          <span
            className="text-[11px] text-ink-500"
            title={OVERALL_TOOLTIP}
          >
            70% fundamental
          </span>
        }
      />
      <ul className="divide-y divide-navy-800">
        {top.rows.map((row) => (
          <li key={row.instrumentId}>
            <Link
              href={`/stocks/${row.symbol}`}
              className="flex items-center gap-3 px-5 py-2.5 hover:bg-navy-850"
            >
              <RankCell rank={row.rank} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink-100">
                  {row.symbol}
                </span>
                <span className="block truncate text-[11px] text-ink-500">
                  {row.name}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="num block text-[13px] font-semibold text-ink-100">
                  {roundScore(row.overallScore)?.toFixed(1) ?? NO_DATA}
                </span>
                <span className="block">
                  <RankChange
                    change={row.rankChange}
                    isNewEntrant={row.isNewEntrant}
                  />
                </span>
              </span>
              <span className="hidden shrink-0 sm:block">
                <GradeBadge grade={row.grade} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <CardBody className="border-t border-navy-800 py-3">
        <Link
          href="/rankings"
          className="inline-block rounded bg-navy-700 px-4 py-2 text-[13px] font-medium text-ink-100 hover:bg-navy-600"
        >
          View full rankings
        </Link>
      </CardBody>
    </Card>
  );
}
