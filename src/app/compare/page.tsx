import type { Metadata } from 'next';
import Link from 'next/link';
import {
  instrumentDetail,
  instrumentHistory,
  latestSessionDate,
  rangeStartDate,
} from '@/lib/services/market-service';
import { listInstruments } from '@/lib/db/repositories/instruments';
import { isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  TableScroll,
  Td,
  Th,
} from '@/components/ui/primitives';
import {
  formatCompactTzs,
  formatNumber,
  formatPct,
  formatPctSigned,
  formatPrice,
  formatRatio,
  formatScore,
  NO_DATA,
} from '@/lib/format';
import type { HistoryPoint, PeriodRange } from '@/lib/types/market';
import type { NormalizedSeriesPoint } from '@/app/stocks/[symbol]/charts';
import { ComparePicker, CompareChart } from './compare-client';

export const metadata: Metadata = {
  title: 'Compare',
  description: 'Compare any two DSE-listed securities side by side.',
};
export const dynamic = 'force-dynamic';

const VALID_RANGES: PeriodRange[] = ['1M', '3M', '6M', '1Y', '3Y', 'MAX'];

/**
 * Two-security comparison.
 *
 * The return chart rebases both series to 0% at the first session they share,
 * which is the only way a 2,600 TZS counter and a 17,600 TZS counter can be
 * read on one axis. Plotting raw prices together would be visually meaningless.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string; range?: string }>;
}) {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const params = await searchParams;
  const [latest, instruments] = await Promise.all([
    latestSessionDate(),
    listInstruments({ activeOnly: true }),
  ]);

  if (!latest) {
    return (
      <EmptyState
        title="No market data has been imported yet"
        description="Comparison needs stored price history for both securities."
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

  const range: PeriodRange = VALID_RANGES.includes(params.range as PeriodRange)
    ? (params.range as PeriodRange)
    : '6M';

  const symbolA = params.a?.toUpperCase();
  const symbolB = params.b?.toUpperCase();

  const options = instruments.map((i) => ({ symbol: i.symbol, name: i.name }));

  if (!symbolA || !symbolB) {
    return (
      <div className="space-y-5">
        <Header />
        <ComparePicker options={options} a={symbolA ?? ''} b={symbolB ?? ''} range={range} />
        <EmptyState
          title="Select two securities"
          description="Pick any two DSE-listed counters to compare their price behaviour, order book, flow and scores."
        />
      </div>
    );
  }

  if (symbolA === symbolB) {
    return (
      <div className="space-y-5">
        <Header />
        <ComparePicker options={options} a={symbolA} b={symbolB} range={range} />
        <Notice tone="warn" title="Select two different securities">
          Comparing a security with itself produces no information.
        </Notice>
      </div>
    );
  }

  const [detailA, detailB] = await Promise.all([
    instrumentDetail(symbolA),
    instrumentDetail(symbolB),
  ]);

  if (!detailA || !detailB) {
    const missing = !detailA ? symbolA : symbolB;
    return (
      <div className="space-y-5">
        <Header />
        <ComparePicker options={options} a={symbolA} b={symbolB} range={range} />
        <Notice tone="down" title="Security not found">
          {missing} is not in the instrument master.
        </Notice>
      </div>
    );
  }

  const from = rangeStartDate(range, latest);
  const [historyA, historyB] = await Promise.all([
    instrumentHistory(detailA.instrument.id, from, latest),
    instrumentHistory(detailB.instrument.id, from, latest),
  ]);

  const series = normalizeReturns(historyA, historyB, symbolA, symbolB);

  return (
    <div className="space-y-5">
      <Header />
      <ComparePicker options={options} a={symbolA} b={symbolB} range={range} />

      <CompareChart
        data={series}
        seriesKeys={[symbolA, symbolB]}
      />

      <Card>
        <CardHeader
          title="Side by side"
          description="Latest stored session for each security. An em dash means the value could not be computed, and the reason is on that security's Methodology tab."
        />
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Metric</Th>
                <Th align="right">{symbolA}</Th>
                <Th align="right">{symbolB}</Th>
              </tr>
            </thead>
            <tbody>
              <Section label="Identity" />
              <Row label="Company" a={detailA.instrument.name} b={detailB.instrument.name} />
              <Row
                label="Sector"
                a={detailA.instrument.sector ?? NO_DATA}
                b={detailB.instrument.sector ?? NO_DATA}
              />
              <Row
                label="Latest session"
                a={detailA.latest?.tradingDate ?? NO_DATA}
                b={detailB.latest?.tradingDate ?? NO_DATA}
              />

              <Section label="Price" />
              <Row
                label="Close"
                a={formatPrice(detailA.latest?.close ?? null)}
                b={formatPrice(detailB.latest?.close ?? null)}
              />
              <Row
                label="Session change"
                a={formatPctSigned(detailA.latest?.changePct ?? null)}
                b={formatPctSigned(detailB.latest?.changePct ?? null)}
              />
              <Row
                label="5-day return"
                a={formatPctSigned(detailA.return5d)}
                b={formatPctSigned(detailB.return5d)}
              />
              <Row
                label="20-day return"
                a={formatPctSigned(detailA.return20d)}
                b={formatPctSigned(detailB.return20d)}
              />
              <Row
                label="Typical daily move"
                a={detailA.volatility20d === null ? NO_DATA : formatPct(detailA.volatility20d)}
                b={detailB.volatility20d === null ? NO_DATA : formatPct(detailB.volatility20d)}
              />

              <Section label="Size and flow" />
              <Row
                label="Market cap"
                a={formatCompactTzs(detailA.latest?.marketCapTzs ?? null)}
                b={formatCompactTzs(detailB.latest?.marketCapTzs ?? null)}
              />
              <Row
                label="Turnover"
                a={formatCompactTzs(detailA.latest?.turnoverTzs ?? null)}
                b={formatCompactTzs(detailB.latest?.turnoverTzs ?? null)}
              />
              <Row
                label="Volume"
                a={formatNumber(detailA.latest?.volume ?? null)}
                b={formatNumber(detailB.latest?.volume ?? null)}
              />
              <Row
                label="Deals"
                a={formatNumber(detailA.latest?.deals ?? null)}
                b={formatNumber(detailB.latest?.deals ?? null)}
              />
              <Row
                label="Avg deal size"
                a={formatCompactTzs(detailA.avgDealSize)}
                b={formatCompactTzs(detailB.avgDealSize)}
              />
              <Row
                label="20d median volume"
                a={formatNumber(detailA.medianVolume20d)}
                b={formatNumber(detailB.medianVolume20d)}
              />

              <Section label="Order book" />
              <Row
                label="Outstanding bid"
                a={formatNumber(detailA.latest?.bidQty ?? null)}
                b={formatNumber(detailB.latest?.bidQty ?? null)}
              />
              <Row
                label="Outstanding offer"
                a={formatNumber(detailA.latest?.offerQty ?? null)}
                b={formatNumber(detailB.latest?.offerQty ?? null)}
              />
              <Row
                label="B/O ratio"
                a={formatRatio(detailA.latest?.boRatio ?? null)}
                b={formatRatio(detailB.latest?.boRatio ?? null)}
              />
              <Row
                label="5d average B/O"
                a={formatRatio(detailA.avgBo5d)}
                b={formatRatio(detailB.avgBo5d)}
              />
              <Row
                label="B/O momentum"
                a={formatPctSigned(detailA.latest?.boMomentumPct ?? null)}
                b={formatPctSigned(detailB.latest?.boMomentumPct ?? null)}
              />
              <Row
                label="Bid % market cap"
                a={detailA.bidPctMcap === null ? NO_DATA : formatPct(detailA.bidPctMcap, 3)}
                b={detailB.bidPctMcap === null ? NO_DATA : formatPct(detailB.bidPctMcap, 3)}
              />
              <Row
                label="Offer % market cap"
                a={detailA.offerPctMcap === null ? NO_DATA : formatPct(detailA.offerPctMcap, 3)}
                b={detailB.offerPctMcap === null ? NO_DATA : formatPct(detailB.offerPctMcap, 3)}
              />

              <Section label="Scores" />
              <Row
                label="Market pressure"
                a={formatScore(detailA.latest?.pressureScore ?? null)}
                b={formatScore(detailB.latest?.pressureScore ?? null)}
              />
              <Row
                label="Liquidity"
                a={formatScore(detailA.latest?.liquidityScore ?? null)}
                b={formatScore(detailB.latest?.liquidityScore ?? null)}
              />
              <Row
                label="Opportunity"
                a={formatScore(detailA.latest?.opportunityScore ?? null)}
                b={formatScore(detailB.latest?.opportunityScore ?? null)}
              />
              <Row
                label="Data confidence"
                a={formatScore(detailA.latest?.dataConfidenceScore ?? null)}
                b={formatScore(detailB.latest?.dataConfidenceScore ?? null)}
              />

              <Section label="Fundamentals and valuation" />
              <Row label="P/E" a={NO_DATA} b={NO_DATA} />
              <Row label="P/B" a={NO_DATA} b={NO_DATA} />
              <Row label="Dividend yield" a={NO_DATA} b={NO_DATA} />
              <Row label="ROE" a={NO_DATA} b={NO_DATA} />
              <Row label="EPS growth" a={NO_DATA} b={NO_DATA} />
            </tbody>
          </table>
        </TableScroll>
        <CardBody>
          <Notice tone="neutral" title="Fundamental data unavailable">
            No published financial results are on file for either issuer, so the
            valuation rows above are empty rather than estimated. This also means
            the fundamentals and valuation pillars — half the Opportunity score&apos;s
            weight — are excluded from both scores, which is why their data
            confidence is reduced.
          </Notice>
        </CardBody>
      </Card>

      <div className="flex flex-wrap gap-4 text-[13px]">
        <Link href={`/stocks/${symbolA}`} className="text-accent-500 hover:text-accent-400">
          {symbolA} detail →
        </Link>
        <Link href={`/stocks/${symbolB}`} className="text-accent-500 hover:text-accent-400">
          {symbolB} detail →
        </Link>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-lg font-semibold tracking-tight text-ink-100">
        Compare securities
      </h1>
      <p className="mt-1 text-[13px] text-ink-400">
        Any two DSE-listed counters, side by side.
      </p>
    </header>
  );
}

function Section({ label }: { label: string }) {
  return (
    <tr>
      <Td
        className="bg-navy-850 text-[11px] font-semibold uppercase tracking-wider text-ink-400"
        colSpan={3}
      >
        {label}
      </Td>
    </tr>
  );
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <tr>
      <Td className="text-ink-400">{label}</Td>
      <Td align="right">{a}</Td>
      <Td align="right">{b}</Td>
    </tr>
  );
}

/**
 * Rebases both price series to 0% at the first session where BOTH have a close.
 *
 * Using each series' own first session would silently compare different
 * starting points and overstate whichever began earlier.
 */
function normalizeReturns(
  historyA: HistoryPoint[],
  historyB: HistoryPoint[],
  symbolA: string,
  symbolB: string,
): NormalizedSeriesPoint[] {
  const mapA = new Map(historyA.map((p) => [p.tradingDate, p.close]));
  const mapB = new Map(historyB.map((p) => [p.tradingDate, p.close]));

  const dates = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();

  let baseA: number | null = null;
  let baseB: number | null = null;
  for (const date of dates) {
    const a = mapA.get(date) ?? null;
    const b = mapB.get(date) ?? null;
    if (a !== null && a > 0 && b !== null && b > 0) {
      baseA = a;
      baseB = b;
      break;
    }
  }

  // No overlapping session with prices on both sides: nothing comparable.
  if (baseA === null || baseB === null) return [];

  return dates.map((date) => {
    const a = mapA.get(date) ?? null;
    const b = mapB.get(date) ?? null;
    return {
      tradingDate: date,
      [symbolA]: a !== null && a > 0 ? (a / (baseA as number) - 1) * 100 : null,
      [symbolB]: b !== null && b > 0 ? (b / (baseB as number) - 1) * 100 : null,
    };
  });
}
