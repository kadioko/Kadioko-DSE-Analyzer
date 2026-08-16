import type { Metadata } from 'next';
import Link from 'next/link';
import {
  latestSessionDate,
  marketSummary,
  marketTable,
} from '@/lib/services/market-service';
import { isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
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
import {
  BoRatioCell,
  ChangeCell,
  ConfidenceBadge,
  PressureSignalBadge,
  ScoreBar,
  SymbolCell,
} from '@/components/market/indicators';
import {
  formatDateLong,
  formatNumber,
  formatRatio,
  formatScore,
  NO_DATA,
} from '@/lib/format';
import { PRESSURE_THRESHOLDS } from '@/lib/analytics/config';
import type { MarketRow } from '@/lib/types/market';

export const metadata: Metadata = {
  title: 'Sentiment',
  description: 'Market-wide order-book pressure across DSE-listed securities.',
};
export const dynamic = 'force-dynamic';

/**
 * Market sentiment.
 *
 * Sentiment here means one specific, measurable thing: the balance of resting
 * demand against resting supply. It is not derived from news, social media or
 * opinion, and the page says so, because "sentiment" elsewhere usually means
 * something quite different.
 */
export default async function SentimentPage() {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const tradingDate = await latestSessionDate();
  if (!tradingDate) {
    return (
      <EmptyState
        title="No market data has been imported yet"
        description="Sentiment is computed from stored order-book observations."
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

  const [rows, summary] = await Promise.all([
    marketTable(tradingDate),
    marketSummary(tradingDate),
  ]);

  const scored = rows.filter((r) => r.pressureScore !== null);
  const bands = PRESSURE_THRESHOLDS.signalBands;

  const distribution = [
    { label: 'Strong supply', test: (s: number) => s < bands.strongSupply, tone: 'bg-down-500' },
    { label: 'Supply', test: (s: number) => s >= bands.strongSupply && s < bands.supply, tone: 'bg-down-600' },
    { label: 'Balanced', test: (s: number) => s >= bands.supply && s <= bands.demand, tone: 'bg-ink-500' },
    { label: 'Demand', test: (s: number) => s > bands.demand && s <= bands.strongDemand, tone: 'bg-up-600' },
    { label: 'Strong demand', test: (s: number) => s > bands.strongDemand, tone: 'bg-up-500' },
  ].map((band) => ({
    ...band,
    count: scored.filter((r) => band.test(r.pressureScore as number)).length,
  }));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">
          Market sentiment
        </h1>
        <p className="mt-1 text-[13px] text-ink-400">
          Session of{' '}
          <span className="text-ink-200">{formatDateLong(tradingDate)}</span>
        </p>
      </header>

      <Notice tone="neutral">
        Sentiment on this platform means one measurable thing: the balance of
        resting demand against resting supply in the order book, together with
        whether price and volume confirm it. It is not derived from news, social
        media or opinion, and it is not a recommendation.
      </Notice>

      {summary ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Market pressure"
              value={formatScore(summary.marketPressureScore)}
              tone={
                summary.marketPressureScore === null
                  ? 'neutral'
                  : summary.marketPressureScore >= 58
                    ? 'up'
                    : summary.marketPressureScore <= 42
                      ? 'down'
                      : 'neutral'
              }
              sub="0 supply · 50 balanced · 100 demand"
            />
            <Stat
              label="Market B/O"
              value={formatRatio(summary.marketBoRatio)}
              sub={`${formatNumber(summary.totalBidQty)} bid / ${formatNumber(summary.totalOfferQty)} offer`}
            />
            <Stat
              label="Breadth"
              value={`${summary.gainers ?? 0} / ${summary.losers ?? 0}`}
              sub="advancing / declining"
            />
            <Stat
              label="Counters scored"
              value={`${scored.length} of ${rows.length}`}
              sub="Others lack sufficient data"
            />
          </div>

          <Card>
            <CardHeader
              title="Market pressure components"
              action={
                <div className="flex flex-wrap gap-2">
                  <PressureSignalBadge signal={summary.marketPressureSignal} />
                  <ConfidenceBadge score={summary.dataConfidenceScore} />
                </div>
              }
            />
            <div className="grid gap-5 px-5 py-4 sm:grid-cols-3">
              <ScoreBar
                score={summary.breadthComponents.orderBook ?? null}
                label="Order book (45%)"
                title="Market-wide bid/offer ratio, log-scaled."
              />
              <ScoreBar
                score={summary.breadthComponents.breadth ?? null}
                label="Breadth (30%)"
                title="Advancing versus declining counters."
              />
              <ScoreBar
                score={summary.breadthComponents.turnoverWeightedPressure ?? null}
                label="Turnover-weighted (25%)"
                title="Individual pressure scores weighted by turnover, so the reading reflects where money actually traded."
              />
            </div>
          </Card>
        </>
      ) : (
        <Notice tone="warn" title="No market summary for this session">
          Observations exist but the derived summary has not been generated.
        </Notice>
      )}

      <Card>
        <CardHeader
          title="Pressure distribution"
          description="How many counters fall in each signal band."
        />
        <CardBody className="space-y-2.5">
          {scored.length === 0 ? (
            <p className="text-[13px] text-ink-500">
              No counter had enough data to produce a pressure score this
              session.
            </p>
          ) : (
            distribution.map((band) => (
              <div key={band.label} className="flex items-center gap-3">
                <span className="w-32 shrink-0 text-[13px] text-ink-300">
                  {band.label}
                </span>
                <span className="h-4 flex-1 overflow-hidden rounded bg-navy-800">
                  <span
                    className={`block h-full rounded ${band.tone}`}
                    style={{
                      width: `${scored.length ? (band.count / scored.length) * 100 : 0}%`,
                    }}
                  />
                </span>
                <span className="num w-8 shrink-0 text-right text-[13px] text-ink-200">
                  {band.count}
                </span>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Counter heatmap"
          description="Ranked by pressure score. Counters without a score are listed last with the reason."
        />
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Symbol</Th>
                <Th align="right">Change</Th>
                <Th align="right">B/O</Th>
                <Th align="right">B/O momentum</Th>
                <Th align="right">Volume ratio</Th>
                <Th align="right">Pressure</Th>
                <Th>Signal</Th>
              </tr>
            </thead>
            <tbody>
              {[...rows]
                .sort(
                  (a, b) =>
                    (b.pressureScore ?? -1) - (a.pressureScore ?? -1),
                )
                .map((row) => (
                  <tr key={row.instrumentId} className="hover:bg-navy-850">
                    <Td>
                      <SymbolCell symbol={row.symbol} name={row.name} />
                    </Td>
                    <Td align="right">
                      <ChangeCell value={row.changePct} />
                    </Td>
                    <Td align="right">
                      <BoRatioCell ratio={row.boRatio} state={row.boState} />
                    </Td>
                    <Td align="right">
                      <ChangeCell value={row.boMomentumPct} />
                    </Td>
                    <Td align="right">
                      {row.volumeRatio === null
                        ? NO_DATA
                        : `${formatRatio(row.volumeRatio)}×`}
                    </Td>
                    <Td align="right">
                      <PressureCellBar row={row} />
                    </Td>
                    <Td>
                      <PressureSignalBadge signal={row.pressureSignal} />
                    </Td>
                  </tr>
                ))}
            </tbody>
          </table>
        </TableScroll>
      </Card>

      <p className="text-xs text-ink-500">
        Every score above is reproducible from the stored observations using the
        formulas on the{' '}
        <Link href="/methodology" className="text-accent-500 hover:text-accent-400">
          methodology page
        </Link>
        .
      </p>
    </div>
  );
}

/** A compact bar so the whole column can be scanned vertically. */
function PressureCellBar({ row }: { row: MarketRow }) {
  if (row.pressureScore === null) {
    return <span className="text-ink-500">{NO_DATA}</span>;
  }
  const score = row.pressureScore;
  const colour =
    score >= 58 ? 'bg-up-500' : score <= 42 ? 'bg-down-500' : 'bg-ink-400';

  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-navy-700">
        <span
          className={`block h-full rounded-full ${colour}`}
          style={{ width: `${Math.max(2, score)}%` }}
        />
      </span>
      <span className="w-6 text-right text-ink-100">{formatScore(score)}</span>
    </span>
  );
}
