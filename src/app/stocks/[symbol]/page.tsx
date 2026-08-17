import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  instrumentDetail,
  instrumentHistory,
  rangeStartDate,
} from '@/lib/services/market-service';
import { Badge, Notice, Stat } from '@/components/ui/primitives';
import { SetupRequired } from '@/components/setup-required';
import { isDatabaseConfigured } from '@/lib/env';
import {
  formatCompactTzs,
  formatDateLong,
  formatPctSigned,
  formatPrice,
  NO_DATA,
} from '@/lib/format';
import type { PeriodRange } from '@/lib/types/market';
import { RankingSection } from '@/components/market/ranking-section';
import { ValuationSection } from '@/components/market/valuation-section';
import { StockView } from './stock-view';

export const dynamic = 'force-dynamic';

const VALID_RANGES: PeriodRange[] = ['1M', '3M', '6M', '1Y', '3Y', 'MAX'];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  const upper = decodeURIComponent(symbol).toUpperCase();
  return {
    title: upper,
    description: `Order-book pressure, liquidity, momentum and price history for ${upper} on the Dar es Salaam Stock Exchange.`,
  };
}

/**
 * Security detail page.
 *
 * The header states the counter's latest STORED session, which may be older
 * than the market's latest session if it has not traded. Saying so is the point:
 * a stale close presented without its date would be misleading.
 */
export default async function StockPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const [{ symbol }, query] = await Promise.all([params, searchParams]);
  const upper = decodeURIComponent(symbol).toUpperCase();

  const detail = await instrumentDetail(upper);
  if (!detail) notFound();

  const range: PeriodRange = VALID_RANGES.includes(query.range as PeriodRange)
    ? (query.range as PeriodRange)
    : '6M';

  const latestDate = detail.latest?.tradingDate ?? null;
  const history = latestDate
    ? await instrumentHistory(
        detail.instrument.id,
        rangeStartDate(range, latestDate),
        latestDate,
      )
    : [];

  const { instrument, latest } = detail;

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <Link
          href="/market"
          className="text-[13px] text-accent-500 hover:text-accent-400"
        >
          ← Market
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink-100">
                {instrument.symbol}
              </h1>
              {instrument.sector ? (
                <Badge tone="muted">{instrument.sector}</Badge>
              ) : null}
              {instrument.isCrossListed ? (
                <Badge tone="accent" title="Cross-listed from another exchange.">
                  Cross-listed
                </Badge>
              ) : null}
              {!instrument.active ? <Badge tone="warn">Inactive</Badge> : null}
            </div>
            <p className="mt-1 text-sm text-ink-300">{instrument.name}</p>
          </div>

          <div className="text-right">
            <p className="num text-2xl font-semibold text-ink-100">
              {latest ? formatPrice(latest.close) : NO_DATA}
              <span className="ml-1.5 text-sm font-normal text-ink-500">
                {instrument.currency}
              </span>
            </p>
            <p
              className={`num text-sm ${
                (latest?.changePct ?? 0) > 0
                  ? 'text-up-400'
                  : (latest?.changePct ?? 0) < 0
                    ? 'text-down-400'
                    : 'text-ink-400'
              }`}
            >
              {formatPctSigned(latest?.changePct ?? null)}
            </p>
            {latestDate ? (
              <p className="mt-0.5 text-[11px] text-ink-500">
                {formatDateLong(latestDate)}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      {!latest ? (
        <Notice tone="warn" title="No market observations for this security">
          {instrument.symbol} is in the instrument master but no sessions have
          been imported for it. Import a DSE end-of-day file that includes this
          counter.
        </Notice>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Market cap"
              value={formatCompactTzs(latest.marketCapTzs)}
              sub="TZS"
            />
            <Stat
              label="Pressure"
              value={
                latest.pressureScore === null
                  ? NO_DATA
                  : Math.round(latest.pressureScore).toString()
              }
              tone={
                latest.pressureScore === null
                  ? 'neutral'
                  : latest.pressureScore >= 58
                    ? 'up'
                    : latest.pressureScore <= 42
                      ? 'down'
                      : 'neutral'
              }
              sub="Order-book balance, not advice"
            />
            <Stat
              label="Opportunity"
              value={
                latest.opportunityScore === null
                  ? NO_DATA
                  : Math.round(latest.opportunityScore).toString()
              }
              sub="Composite, missing pillars excluded"
            />
            <Stat
              label="Data confidence"
              value={
                latest.dataConfidenceScore === null
                  ? NO_DATA
                  : Math.round(latest.dataConfidenceScore).toString()
              }
              tone={
                latest.dataConfidenceScore === null
                  ? 'neutral'
                  : latest.dataConfidenceScore >= 80
                    ? 'up'
                    : latest.dataConfidenceScore >= 60
                      ? 'warn'
                      : 'down'
              }
              sub="See the Methodology tab for penalties"
            />
          </div>

          <RankingSection symbol={instrument.symbol} />

          <ValuationSection symbol={instrument.symbol} />

          <StockView detail={detail} history={history} range={range} />
        </>
      )}
    </div>
  );
}
