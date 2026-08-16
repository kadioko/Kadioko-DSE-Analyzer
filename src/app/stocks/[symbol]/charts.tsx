'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyState } from '@/components/ui/primitives';
import {
  formatCompactTzs,
  formatDate,
  formatNumber,
  formatRatio,
  NO_DATA,
} from '@/lib/format';
import type { HistoryPoint } from '@/lib/types/market';

/**
 * Stock charts.
 *
 * Two conventions are enforced across every chart here:
 *
 *   1. A gap in the data is a GAP. `connectNulls` is never enabled, so a
 *      session with no close or an undefined B/O ratio leaves a visible break
 *      rather than a straight line implying values that were never observed.
 *   2. Every chart states its own units and refuses to render at all when it
 *      has no usable points, instead of drawing an empty grid that reads as a
 *      flat market.
 */

const AXIS = {
  stroke: '#4c5b74',
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

const GRID_COLOUR = '#1a2942';

function tooltipStyle() {
  return {
    contentStyle: {
      backgroundColor: '#0e1729',
      border: '1px solid #243452',
      borderRadius: 6,
      fontSize: 12,
      color: '#cfd8e6',
    },
    labelStyle: { color: '#9aa8bf', marginBottom: 4 },
  };
}

/** Shortens an ISO date for an axis tick: 2026-08-11 -> 11 Aug */
function tickDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * Recharts types its tooltip callbacks very loosely (ReactNode / ValueType).
 * These adapters take `unknown` and narrow once, which keeps every call site
 * free of casts and guarantees a non-numeric value renders as the standard
 * no-data dash rather than "NaN" or "undefined".
 */
const dateLabel = (label: unknown): string =>
  typeof label === 'string' ? formatDate(label) : '';

function valueAs(
  name: string,
  render: (value: number) => string,
): (value: unknown) => [string, string] {
  return (value: unknown) => [
    typeof value === 'number' && Number.isFinite(value) ? render(value) : NO_DATA,
    name,
  ];
}

/** Series-aware variant, for charts that plot more than one line. */
function valueAsNamed(
  render: (value: number) => string,
  label: (seriesKey: string) => string = (k) => k,
): (value: unknown, name: unknown) => [string, string] {
  return (value: unknown, name: unknown) => [
    typeof value === 'number' && Number.isFinite(value) ? render(value) : NO_DATA,
    label(typeof name === 'string' ? name : ''),
  ];
}

function ChartFrame({
  title,
  subtitle,
  hasData,
  emptyMessage,
  children,
}: {
  title: string;
  subtitle?: string;
  hasData: boolean;
  emptyMessage: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-900 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
        {subtitle ? (
          <p className="mt-0.5 text-[11px] text-ink-500">{subtitle}</p>
        ) : null}
      </div>
      {hasData ? (
        <div className="h-64 w-full">{children}</div>
      ) : (
        <p className="py-12 text-center text-[13px] text-ink-500">{emptyMessage}</p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Price                                                                      */
/* -------------------------------------------------------------------------- */

export function PriceChart({ history }: { history: HistoryPoint[] }) {
  const hasData = history.some((p) => p.close !== null);

  return (
    <ChartFrame
      title="Close price"
      subtitle="TZS. Breaks in the line are sessions with no recorded close."
      hasData={hasData}
      emptyMessage="No closing prices in this range."
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2ba3c4" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#2ba3c4" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID_COLOUR} vertical={false} />
          <XAxis dataKey="tradingDate" tickFormatter={tickDate} {...AXIS} minTickGap={40} />
          <YAxis
            {...AXIS}
            width={62}
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => formatNumber(v)}
          />
          <Tooltip
            {...tooltipStyle()}
            labelFormatter={dateLabel}
            formatter={valueAs('Close', (v) => `${formatNumber(v)} TZS`)}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke="#4cc4e0"
            strokeWidth={1.75}
            fill="url(#priceFill)"
            dot={false}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Volume and turnover                                                        */
/* -------------------------------------------------------------------------- */

export function VolumeChart({ history }: { history: HistoryPoint[] }) {
  const hasData = history.some((p) => (p.volume ?? 0) > 0);

  return (
    <ChartFrame
      title="Volume"
      subtitle="Shares traded per session"
      hasData={hasData}
      emptyMessage="No volume recorded in this range."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOUR} vertical={false} />
          <XAxis dataKey="tradingDate" tickFormatter={tickDate} {...AXIS} minTickGap={40} />
          <YAxis
            {...AXIS}
            width={62}
            tickFormatter={(v: number) => formatCompactTzs(v)}
          />
          <Tooltip
            {...tooltipStyle()}
            labelFormatter={dateLabel}
            formatter={valueAs('Volume', (v) => formatNumber(v))}
          />
          <Bar dataKey="volume" fill="#2ba3c4" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function TurnoverChart({ history }: { history: HistoryPoint[] }) {
  const hasData = history.some((p) => (p.turnoverTzs ?? 0) > 0);

  return (
    <ChartFrame
      title="Turnover"
      subtitle="TZS value traded per session"
      hasData={hasData}
      emptyMessage="No turnover recorded in this range."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOUR} vertical={false} />
          <XAxis dataKey="tradingDate" tickFormatter={tickDate} {...AXIS} minTickGap={40} />
          <YAxis {...AXIS} width={62} tickFormatter={(v: number) => formatCompactTzs(v)} />
          <Tooltip
            {...tooltipStyle()}
            labelFormatter={dateLabel}
            formatter={valueAs('Turnover', (v) => `${formatCompactTzs(v)} TZS`)}
          />
          <Bar dataKey="turnoverTzs" fill="#1c7f9c" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Order book                                                                 */
/* -------------------------------------------------------------------------- */

export function BidOfferChart({ history }: { history: HistoryPoint[] }) {
  const hasData = history.some((p) => p.bidQty !== null || p.offerQty !== null);

  return (
    <ChartFrame
      title="Outstanding bid vs offer"
      subtitle="Resting order quantities at each close"
      hasData={hasData}
      emptyMessage="No order-book data in this range."
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOUR} vertical={false} />
          <XAxis dataKey="tradingDate" tickFormatter={tickDate} {...AXIS} minTickGap={40} />
          <YAxis {...AXIS} width={62} tickFormatter={(v: number) => formatCompactTzs(v)} />
          <Tooltip
            {...tooltipStyle()}
            labelFormatter={dateLabel}
            formatter={valueAsNamed(
              (v) => formatNumber(v),
              (key) => (key === 'bidQty' ? 'Bid' : 'Offer'),
            )}
          />
          <Legend
            formatter={(value: string) => (
              <span style={{ color: '#9aa8bf', fontSize: 11 }}>
                {value === 'bidQty' ? 'Outstanding bid' : 'Outstanding offer'}
              </span>
            )}
          />
          <Area
            type="monotone"
            dataKey="bidQty"
            stroke="#16b57a"
            fill="#16b57a"
            fillOpacity={0.18}
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
          />
          <Area
            type="monotone"
            dataKey="offerQty"
            stroke="#e0475f"
            fill="#e0475f"
            fillOpacity={0.18}
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function BoRatioChart({ history }: { history: HistoryPoint[] }) {
  const hasData = history.some((p) => p.boRatio !== null);
  const undefinedSessions = history.filter(
    (p) => p.boRatio === null && p.boState === 'NO_OFFER',
  ).length;

  return (
    <ChartFrame
      title="Bid/offer ratio"
      subtitle={
        undefinedSessions > 0
          ? `The reference line marks balance (1.0). ${undefinedSessions} session(s) had no offers, where the ratio is undefined and the line breaks.`
          : 'The reference line marks balance (1.0).'
      }
      hasData={hasData}
      emptyMessage="No bid/offer ratio could be formed in this range."
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOUR} vertical={false} />
          <XAxis dataKey="tradingDate" tickFormatter={tickDate} {...AXIS} minTickGap={40} />
          <YAxis {...AXIS} width={48} tickFormatter={(v: number) => formatRatio(v, 1)} />
          <ReferenceLine y={1} stroke="#4c5b74" strokeDasharray="3 3" />
          <Tooltip
            {...tooltipStyle()}
            labelFormatter={dateLabel}
            formatter={valueAs('B/O', (v) => formatRatio(v))}
          />
          <Line
            type="monotone"
            dataKey="boRatio"
            stroke="#f2b544"
            strokeWidth={1.75}
            dot={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function BoMomentumChart({ history }: { history: HistoryPoint[] }) {
  const hasData = history.some((p) => p.boMomentumPct !== null);

  return (
    <ChartFrame
      title="B/O momentum"
      subtitle="Percentage change versus the counter's own 5-session average"
      hasData={hasData}
      emptyMessage="Not enough order-book history to compute momentum in this range."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOUR} vertical={false} />
          <XAxis dataKey="tradingDate" tickFormatter={tickDate} {...AXIS} minTickGap={40} />
          <YAxis {...AXIS} width={52} tickFormatter={(v: number) => `${v}%`} />
          <ReferenceLine y={0} stroke="#4c5b74" />
          <Tooltip
            {...tooltipStyle()}
            labelFormatter={dateLabel}
            formatter={valueAs('B/O momentum', (v) => `${v.toFixed(1)}%`)}
          />
          <Bar dataKey="boMomentumPct" radius={[2, 2, 0, 0]} fill="#2ba3c4" />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Pressure                                                                   */
/* -------------------------------------------------------------------------- */

export function PressureChart({ history }: { history: HistoryPoint[] }) {
  const hasData = history.some((p) => p.pressureScore !== null);

  return (
    <ChartFrame
      title="Market pressure"
      subtitle="0 = extreme supply, 50 = balanced, 100 = extreme demand"
      hasData={hasData}
      emptyMessage="No pressure scores could be computed in this range."
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOUR} vertical={false} />
          <XAxis dataKey="tradingDate" tickFormatter={tickDate} {...AXIS} minTickGap={40} />
          <YAxis {...AXIS} width={40} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} />
          <ReferenceLine y={50} stroke="#4c5b74" strokeDasharray="3 3" />
          <Tooltip
            {...tooltipStyle()}
            labelFormatter={dateLabel}
            formatter={valueAs('Pressure', (v) => Math.round(v).toString())}
          />
          <Line
            type="monotone"
            dataKey="pressureScore"
            stroke="#34d99a"
            strokeWidth={1.75}
            dot={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Normalised return, used by the comparison page                             */
/* -------------------------------------------------------------------------- */

export interface NormalizedSeriesPoint {
  tradingDate: string;
  [symbol: string]: number | string | null;
}

/**
 * Percentage-return chart.
 *
 * Both series are rebased to 0% at the first session in the range, which is
 * what makes a 2,600 TZS counter and a 17,600 TZS counter comparable on one
 * axis. Plotting raw prices together would be meaningless.
 */
export function NormalizedReturnChart({
  data,
  seriesKeys,
  colours = ['#4cc4e0', '#f2b544'],
}: {
  data: NormalizedSeriesPoint[];
  seriesKeys: string[];
  colours?: string[];
}) {
  const hasData = data.some((point) =>
    seriesKeys.some((key) => typeof point[key] === 'number'),
  );

  return (
    <ChartFrame
      title="Normalised return"
      subtitle="Both series rebased to 0% at the start of the range, so differently priced shares stay comparable."
      hasData={hasData}
      emptyMessage="Not enough overlapping price history to compare these securities."
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOUR} vertical={false} />
          <XAxis dataKey="tradingDate" tickFormatter={tickDate} {...AXIS} minTickGap={40} />
          <YAxis {...AXIS} width={52} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
          <ReferenceLine y={0} stroke="#4c5b74" />
          <Tooltip
            {...tooltipStyle()}
            labelFormatter={dateLabel}
            formatter={valueAsNamed((v) => `${v.toFixed(2)}%`)}
          />
          <Legend
            formatter={(value: string) => (
              <span style={{ color: '#9aa8bf', fontSize: 11 }}>{value}</span>
            )}
          />
          {seriesKeys.map((key, index) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colours[index % colours.length]}
              strokeWidth={1.75}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Shown when a range has no data at all. */
export function NoHistory({ range }: { range: string }) {
  return (
    <EmptyState
      title={`No stored sessions in the ${range} range`}
      description="Import more history, or select a wider range."
    />
  );
}
