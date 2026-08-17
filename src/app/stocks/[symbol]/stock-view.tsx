'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Card, CardBody, CardHeader, Notice, cn } from '@/components/ui/primitives';
import {
  BidOfferChart,
  BoMomentumChart,
  BoRatioChart,
  NoHistory,
  PressureChart,
  PriceChart,
  TurnoverChart,
  VolumeChart,
} from './charts';
import {
  BoRatioCell,
  ConfidenceBadge,
  PressureSignalBadge,
  ScoreBar,
} from '@/components/market/indicators';
import {
  formatCompactTzs,
  formatNumber,
  formatPct,
  formatPctSigned,
  formatRatio,
  formatScore,
  NO_DATA,
} from '@/lib/format';
import type { HistoryPoint, PeriodRange } from '@/lib/types/market';
import type { InstrumentDetail } from '@/lib/services/market-service';

const RANGES: PeriodRange[] = ['1M', '3M', '6M', '1Y', '3Y', 'MAX'];

const TABS = [
  'Overview',
  'Price',
  'Order Book',
  'Momentum',
  'Fundamentals',
  'Valuation',
  'Dividends',
  'Corporate Actions',
  'Methodology',
] as const;

type Tab = (typeof TABS)[number];

/**
 * Stock detail view.
 *
 * Tabs whose data source is not built yet (fundamentals, valuation, dividends,
 * corporate actions) say so plainly and explain what it costs the scores. They
 * do not show placeholder ratios, and they do not silently disappear — a reader
 * needs to know the gap exists to interpret the Opportunity score.
 */
export function StockView({
  detail,
  history,
  range,
}: {
  detail: InstrumentDetail;
  history: HistoryPoint[];
  range: PeriodRange;
}) {
  const [tab, setTab] = useState<Tab>('Overview');
  const { latest } = detail;

  // Built here rather than passed in: a function prop cannot cross the
  // server/client boundary, and the URL shape is this component's concern.
  const rangeHref = (next: PeriodRange) =>
    `/stocks/${detail.instrument.symbol}?range=${next}`;

  return (
    <div className="space-y-5">
      <nav className="flex gap-1 overflow-x-auto border-b border-navy-700">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2 text-[13px] transition-colors',
              tab === name
                ? 'border-accent-400 text-ink-100'
                : 'border-transparent text-ink-400 hover:text-ink-200',
            )}
          >
            {name}
          </button>
        ))}
      </nav>

      {tab !== 'Overview' && tab !== 'Methodology' ? (
        <RangePicker range={range} href={rangeHref} />
      ) : null}

      {tab === 'Overview' ? <OverviewTab detail={detail} /> : null}

      {tab === 'Price' ? (
        history.length === 0 ? (
          <NoHistory range={range} />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="xl:col-span-2">
              <PriceChart history={history} />
            </div>
            <VolumeChart history={history} />
            <TurnoverChart history={history} />
          </div>
        )
      ) : null}

      {tab === 'Order Book' ? (
        history.length === 0 ? (
          <NoHistory range={range} />
        ) : (
          <div className="space-y-4">
            <OrderBookSummary detail={detail} />
            <div className="grid gap-4 xl:grid-cols-2">
              <BidOfferChart history={history} />
              <BoRatioChart history={history} />
            </div>
          </div>
        )
      ) : null}

      {tab === 'Momentum' ? (
        history.length === 0 ? (
          <NoHistory range={range} />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            <BoMomentumChart history={history} />
            <PressureChart history={history} />
            <div className="xl:col-span-2">
              <ReturnsPanel detail={detail} />
            </div>
          </div>
        )
      ) : null}

      {tab === 'Fundamentals' ? (
        <NotYetAvailable
          title="Fundamental data unavailable"
          what="Published financial results for this issuer"
          consequence="The fundamentals pillar (30% of the Opportunity score) is excluded from the calculation entirely rather than filled with a neutral value, and data confidence is reduced accordingly."
        />
      ) : null}

      {tab === 'Valuation' ? (
        <Notice tone="neutral" title="Valuation is shown above">
          P/E, P/B, earnings yield and enterprise-value multiples are in the
          Valuation panel above this tab strip, together with a note on exactly
          how each figure was derived and why any absent one is absent.
        </Notice>
      ) : null}

      {tab === 'Dividends' ? (
        <NotYetAvailable
          title="Dividend data unavailable"
          what="Declared dividends per share, ex-dates and payment dates"
          consequence="Dividend yield therefore cannot be computed, and that pillar (10% of the Opportunity score) is excluded rather than treated as a zero yield. A company that pays no dividend and a company whose dividend we have not loaded are different facts, and the platform does not conflate them."
        />
      ) : null}

      {tab === 'Corporate Actions' ? (
        <NotYetAvailable
          title="Corporate actions unavailable"
          what="Dividends, splits, bonus and rights issues, AGMs, suspensions"
          consequence="Without these, an extreme price movement cannot be automatically attributed to a corporate action, and is flagged for manual review at import instead."
        />
      ) : null}

      {tab === 'Methodology' ? <MethodologyTab detail={detail} /> : null}

      {latest ? (
        <p className="text-xs text-ink-500">
          Latest stored session for this counter: {latest.tradingDate}. All
          figures derive from imported observations; nothing is estimated.
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RangePicker({
  range,
  href,
}: {
  range: PeriodRange;
  href: (r: PeriodRange) => string;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {RANGES.map((r) => (
        <Link
          key={r}
          href={href(r)}
          scroll={false}
          className={cn(
            'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
            r === range
              ? 'bg-navy-700 text-ink-100'
              : 'text-ink-400 hover:bg-navy-800 hover:text-ink-200',
          )}
        >
          {r}
        </Link>
      ))}
    </div>
  );
}

function Metric({
  label,
  value,
  title,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div title={title}>
      <dt className="text-[11px] uppercase tracking-wider text-ink-500">{label}</dt>
      <dd
        className={cn(
          'num mt-0.5 text-sm',
          tone === 'up' ? 'text-up-400' : tone === 'down' ? 'text-down-400' : 'text-ink-100',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function OverviewTab({ detail }: { detail: InstrumentDetail }) {
  const { latest } = detail;

  if (!latest) {
    return (
      <Notice tone="warn" title="No market data for this security">
        The instrument exists in the master but no observations have been
        imported for it.
      </Notice>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Session" />
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            <Metric label="Close" value={formatNumber(latest.close)} />
            <Metric
              label="Change"
              value={formatPctSigned(latest.changePct)}
              tone={
                latest.changePct === null
                  ? undefined
                  : latest.changePct > 0
                    ? 'up'
                    : latest.changePct < 0
                      ? 'down'
                      : undefined
              }
            />
            <Metric label="Previous close" value={formatNumber(latest.previousClose)} />
            <Metric label="Turnover" value={formatCompactTzs(latest.turnoverTzs)} />
            <Metric label="Volume" value={formatNumber(latest.volume)} />
            <Metric label="Deals" value={formatNumber(latest.deals)} />
            <Metric
              label="Avg deal size"
              value={formatCompactTzs(detail.avgDealSize)}
              title="Turnover divided by number of deals."
            />
            <Metric label="Market cap" value={formatCompactTzs(latest.marketCapTzs)} />
            <Metric
              label="20d avg volume"
              value={formatNumber(detail.avgVolume20d)}
              title="Requires at least 10 sessions of history."
            />
            <Metric
              label="20d median volume"
              value={formatNumber(detail.medianVolume20d)}
              title="The median resists distortion by a single block trade, which is why it is shown alongside the average."
            />
            <Metric
              label="Volume ratio"
              value={
                latest.volumeRatio === null
                  ? NO_DATA
                  : `${formatRatio(latest.volumeRatio)}×`
              }
            />
            <Metric
              label="Liquidity percentile"
              value={
                detail.liquidityPercentile === null
                  ? NO_DATA
                  : formatPct(detail.liquidityPercentile, 0)
              }
              title="Rank of this counter's turnover among all counters that session."
            />
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Scores" />
        <CardBody className="space-y-4">
          <ScoreBar
            score={latest.pressureScore}
            label="Market pressure"
            title="Order-book supply/demand balance. Not a buy signal."
          />
          <ScoreBar
            score={latest.opportunityScore}
            label="Opportunity"
            tone="neutral"
            title="Composite investment-context score. Pillars without data are excluded, not imputed."
          />
          <ScoreBar score={latest.liquidityScore} label="Liquidity" tone="neutral" />
          <ScoreBar
            score={latest.dataConfidenceScore}
            label="Data confidence"
            tone="confidence"
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <PressureSignalBadge signal={latest.pressureSignal} />
            <ConfidenceBadge score={latest.dataConfidenceScore} />
          </div>
        </CardBody>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader title="Order book" />
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Outstanding bid" value={formatNumber(latest.bidQty)} />
            <Metric label="Outstanding offer" value={formatNumber(latest.offerQty)} />
            <Metric
              label="B/O ratio"
              value={<BoRatioCell ratio={latest.boRatio} state={latest.boState} />}
            />
            <Metric
              label="5d avg B/O"
              value={formatRatio(detail.avgBo5d)}
              title={`From ${detail.boObservations5d} usable trailing observation(s).`}
            />
            <Metric
              label="B/O momentum"
              value={formatPctSigned(latest.boMomentumPct)}
              tone={
                latest.boMomentumPct === null
                  ? undefined
                  : latest.boMomentumPct > 0
                    ? 'up'
                    : 'down'
              }
            />
            <Metric
              label="Net depth"
              value={
                detail.bidPctMcap === null || detail.offerPctMcap === null
                  ? NO_DATA
                  : formatPctSigned(detail.bidPctMcap - detail.offerPctMcap)
              }
              title="Resting demand minus supply, as a percentage of market capitalisation. This is what makes counters of different sizes comparable."
            />
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

function OrderBookSummary({ detail }: { detail: InstrumentDetail }) {
  const { latest } = detail;
  if (!latest) return null;

  return (
    <Card>
      <CardHeader
        title="Order book, valued and normalised"
        description="Quantities valued at the close, then expressed as a share of market capitalisation."
      />
      <CardBody>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Bid quantity" value={formatNumber(latest.bidQty)} />
          <Metric label="Offer quantity" value={formatNumber(latest.offerQty)} />
          <Metric label="Bid value" value={formatCompactTzs(detail.bidValueTzs)} />
          <Metric label="Offer value" value={formatCompactTzs(detail.offerValueTzs)} />
          <Metric
            label="Bid % market cap"
            value={detail.bidPctMcap === null ? NO_DATA : formatPct(detail.bidPctMcap, 3)}
          />
          <Metric
            label="Offer % market cap"
            value={
              detail.offerPctMcap === null ? NO_DATA : formatPct(detail.offerPctMcap, 3)
            }
          />
        </dl>
        {latest.marketCapTzs === null ? (
          <div className="mt-4">
            <Notice tone="warn">
              No market capitalisation is on file for this counter, so the
              percentage-of-market-cap figures cannot be computed. Enter shares
              outstanding in the instrument master, or supply market cap in the
              import file.
            </Notice>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ReturnsPanel({ detail }: { detail: InstrumentDetail }) {
  return (
    <Card>
      <CardHeader title="Returns and volatility" />
      <CardBody>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
          <Metric label="1 day" value={formatPctSigned(detail.return1d)} />
          <Metric label="5 day" value={formatPctSigned(detail.return5d)} />
          <Metric label="20 day" value={formatPctSigned(detail.return20d)} />
          <Metric
            label="Session range"
            value={detail.rangePct === null ? NO_DATA : formatPct(detail.rangePct)}
          />
          <Metric
            label="Typical daily move"
            value={
              detail.volatility20d === null ? NO_DATA : formatPct(detail.volatility20d)
            }
            title="Standard deviation of daily returns over 20 sessions. Not annualised — it is presented as what it measures."
          />
        </dl>
      </CardBody>
    </Card>
  );
}

function MethodologyTab({ detail }: { detail: InstrumentDetail }) {
  const pressure = detail.pressureComponents;
  const opportunity = detail.opportunityComponents;
  const confidence = detail.confidenceFactors as {
    factors?: Array<{ code: string; penalty: number; detail: string }>;
    missingPillars?: string[];
    score?: number;
  };

  const componentNames = (source: Record<string, number | null>) =>
    Object.keys(source).filter(
      (k) => !k.endsWith('_raw') && !k.endsWith('_weight') && k !== 'coverage',
    );

  return (
    <div className="space-y-4">
      <Notice tone="neutral">
        These are the actual component contributions behind this security&apos;s
        scores, read straight from the stored analytics row. The full formulas
        are on the{' '}
        <Link href="/methodology" className="text-accent-500 hover:text-accent-400">
          methodology page
        </Link>
        .
      </Notice>

      <Card>
        <CardHeader
          title="Market pressure components"
          description={`Coverage ${formatScore(pressure.coverage ?? null)}% of the model's total weight.`}
        />
        <CardBody>
          {componentNames(pressure).length === 0 ? (
            <p className="text-[13px] text-ink-500">
              No pressure components stored for this session.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {componentNames(pressure).map((name) => (
                <ComponentRow
                  key={name}
                  name={name}
                  contribution={pressure[name] ?? null}
                  raw={pressure[`${name}_raw`] ?? null}
                  weight={pressure[`${name}_weight`] ?? null}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Opportunity components"
          description={`Coverage ${formatScore(opportunity.coverage ?? null)}% of the model's total weight.`}
        />
        <CardBody className="space-y-4">
          {componentNames(opportunity).length === 0 ? (
            <p className="text-[13px] text-ink-500">
              No opportunity components stored for this session.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {componentNames(opportunity).map((name) => (
                <ComponentRow
                  key={name}
                  name={name}
                  contribution={opportunity[name] ?? null}
                  raw={opportunity[`${name}_raw`] ?? null}
                  weight={opportunity[`${name}_weight`] ?? null}
                />
              ))}
            </ul>
          )}

          {confidence.missingPillars && confidence.missingPillars.length > 0 ? (
            <Notice tone="warn" title="Excluded from the calculation">
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {confidence.missingPillars.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
              <p className="mt-2">
                These pillars were removed from the denominator rather than
                filled with a neutral value, and the remaining pillars were
                renormalised over the weight that was available.
              </p>
            </Notice>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Data confidence"
          description="Starts at 100 and subtracts a named penalty for each gap."
        />
        <CardBody>
          {!confidence.factors || confidence.factors.length === 0 ? (
            <p className="text-[13px] text-ink-300">
              No penalties applied — every input this score needs was present,
              fresh and within range.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {confidence.factors.map((factor) => (
                <li
                  key={factor.code}
                  className="flex items-start justify-between gap-4 border-b border-navy-800 pb-2.5 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink-200">
                      {factor.code}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-400">
                      {factor.detail}
                    </p>
                  </div>
                  <Badge tone="down">−{factor.penalty}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function ComponentRow({
  name,
  contribution,
  raw,
  weight,
}: {
  name: string;
  contribution: number | null;
  raw: number | null;
  weight: number | null;
}) {
  const label = name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());

  return (
    <li className="border-b border-navy-800 pb-2.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-ink-200">{label}</span>
        <span className="num shrink-0 text-[13px]">
          {contribution === null ? (
            <span className="text-ink-500" title="No data for this component.">
              excluded
            </span>
          ) : (
            <>
              <span className="text-ink-100">{contribution.toFixed(1)}</span>
              <span className="text-ink-500"> / {weight ?? NO_DATA} pts</span>
            </>
          )}
        </span>
      </div>
      {raw !== null && weight !== null ? (
        <div className="mt-1 flex items-center gap-2">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-navy-700">
            <span
              className="block h-full rounded-full bg-accent-500"
              style={{
                width: `${Math.max(1, Math.min(100, ((contribution ?? 0) / weight) * 100))}%`,
              }}
            />
          </span>
          <span className="num w-14 shrink-0 text-right text-[11px] text-ink-500">
            {raw.toFixed(1)}/100
          </span>
        </div>
      ) : null}
    </li>
  );
}

function NotYetAvailable({
  title,
  what,
  consequence,
}: {
  title: string;
  what: string;
  consequence: string;
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="space-y-3">
        <p className="text-[13px] leading-relaxed text-ink-300">
          <span className="text-ink-100">{what}</span> has not been loaded into
          the database for this issuer.
        </p>
        <p className="text-[13px] leading-relaxed text-ink-400">{consequence}</p>
        <Notice tone="neutral">
          Nothing is estimated or filled in here. An invented figure would be
          worse than a visible gap, because it would flow into the scores as
          though it had been observed.
        </Notice>
      </CardBody>
    </Card>
  );
}
