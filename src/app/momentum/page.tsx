import type { Metadata } from 'next';
import Link from 'next/link';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { analyticsDaily } from '@/lib/db/schema';
import { toNum } from '@/lib/db/num';
import { ANALYTICS_MODEL_VERSION } from '@/lib/analytics/config';
import { latestSessionDate, marketTable } from '@/lib/services/market-service';
import { runScanner } from '@/lib/analytics/scanner';
import { isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
} from '@/components/ui/primitives';
import { SymbolCell } from '@/components/market/indicators';
import { formatDateLong } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Momentum scanner',
  description:
    'Rule-based detection of order-book acceleration, unusual volume and possible reversals on the DSE.',
};
export const dynamic = 'force-dynamic';

/**
 * Momentum scanner.
 *
 * Each group states its rule in words directly above its matches, and each
 * match shows the values that satisfied that rule. A reader should be able to
 * check the classification rather than take the label on trust.
 */
export default async function MomentumPage() {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const tradingDate = await latestSessionDate();
  if (!tradingDate) {
    return (
      <EmptyState
        title="No market data has been imported yet"
        description="The scanner runs over stored observations."
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

  const rows = await marketTable(tradingDate);

  // 5-day returns live in analytics_daily, not in the market row.
  const returnRows =
    rows.length > 0
      ? await db
          .select({
            instrumentId: analyticsDaily.instrumentId,
            return5d: analyticsDaily.return5d,
          })
          .from(analyticsDaily)
          .where(
            and(
              inArray(
                analyticsDaily.instrumentId,
                rows.map((r) => r.instrumentId),
              ),
              eq(analyticsDaily.tradingDate, tradingDate),
              eq(analyticsDaily.modelVersion, ANALYTICS_MODEL_VERSION),
            ),
          )
      : [];

  const returns5d = new Map(
    returnRows.map((r) => [r.instrumentId, toNum(r.return5d)]),
  );

  const groups = runScanner(rows, returns5d);
  const totalMatches = groups.reduce((sum, g) => sum + g.matches.length, 0);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">
          Momentum scanner
        </h1>
        <p className="mt-1 text-[13px] text-ink-400">
          Session of{' '}
          <span className="text-ink-200">{formatDateLong(tradingDate)}</span> ·{' '}
          {totalMatches} match{totalMatches === 1 ? '' : 'es'} across{' '}
          {rows.length} counters
        </p>
      </header>

      <Notice tone="neutral">
        These are rule matches, not recommendations. A counter appears in a group
        because it satisfied that group&apos;s stated rule on this session&apos;s
        data — nothing more is being claimed.
      </Notice>

      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <Card key={group.code}>
            <CardHeader
              title={group.title}
              description={group.rule}
              action={
                <Badge tone={group.matches.length > 0 ? group.tone : 'muted'}>
                  {group.matches.length}
                </Badge>
              }
            />
            {group.matches.length === 0 ? (
              <CardBody>
                <p className="text-[13px] text-ink-500">
                  No counter met this rule in this session.
                </p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-navy-800">
                {group.matches.map((match) => (
                  <li
                    key={match.row.instrumentId}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                  >
                    <SymbolCell
                      symbol={match.row.symbol}
                      name={match.row.name}
                    />
                    <div className="flex flex-wrap gap-x-5 gap-y-1">
                      {match.evidence.map((e) => (
                        <span key={e.label} className="text-right">
                          <span className="block text-[10px] uppercase tracking-wider text-ink-500">
                            {e.label}
                          </span>
                          <span className="num text-[13px] text-ink-100">
                            {e.value}
                          </span>
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title="Why the reversal rules are strict" />
        <CardBody className="space-y-3 text-[13px] leading-relaxed text-ink-300">
          <p>
            A price fall followed by a rise is not evidence of a reversal — it is
            the definition of ordinary volatility. Labelling it as one would be a
            claim the data does not support.
          </p>
          <p>
            A reversal match therefore requires three independent conditions at
            once: price moving one way, the resting order book moving the other,
            and volume above its own recent average to confirm that the move
            carried participation. Any two without the third produces no match.
          </p>
          <p className="text-ink-500">
            Even then, &quot;possible&quot; is doing real work in the label. The
            rule identifies a configuration worth looking at, not an outcome.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
