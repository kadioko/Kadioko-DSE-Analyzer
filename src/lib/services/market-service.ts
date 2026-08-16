import 'server-only';
import { and, asc, desc, eq, gte, lte, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  analyticsDaily,
  instruments,
  marketDaily,
  marketDailySummary,
} from '@/lib/db/schema';
import { toNum } from '@/lib/db/num';
import { ANALYTICS_MODEL_VERSION } from '@/lib/analytics/config';
import type {
  BoState,
  HistoryPoint,
  MarketRow,
  MarketSummary,
  PeriodRange,
  PressureSignal,
} from '@/lib/types/market';

/**
 * Read models for the market surfaces.
 *
 * Raw observations and derived analytics live in separate tables, and this is
 * the layer that joins them for display. The join is LEFT: a market row without
 * analytics still appears, with null scores, rather than vanishing from the
 * table because a derived value is missing.
 */

/** The latest date that has any market data at all. */
export async function latestSessionDate(): Promise<string | null> {
  const rows = await db
    .select({ tradingDate: marketDaily.tradingDate })
    .from(marketDaily)
    .orderBy(desc(marketDaily.tradingDate))
    .limit(1);
  return rows[0]?.tradingDate ?? null;
}

/**
 * Every counter for a trading date, with its derived analytics.
 *
 * One query. The previous implementation temptation - fetch rows then fetch
 * analytics per row - would be N+1 across ~30 counters on every page load.
 */
export async function marketTable(tradingDate: string): Promise<MarketRow[]> {
  const rows = await db
    .select({
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
      sector: instruments.sector,
      tradingDate: marketDaily.tradingDate,
      close: marketDaily.close,
      previousClose: marketDaily.previousClose,
      changePct: marketDaily.changePct,
      turnoverTzs: marketDaily.turnoverTzs,
      volume: marketDaily.volume,
      deals: marketDaily.deals,
      bidQty: marketDaily.outstandingBidQty,
      offerQty: marketDaily.outstandingOfferQty,
      marketCapTzs: marketDaily.marketCapTzs,
      boRatio: analyticsDaily.boRatio,
      boState: analyticsDaily.boState,
      boMomentumPct: analyticsDaily.boMomentumPct,
      volumeRatio: analyticsDaily.volumeRatio,
      pressureScore: analyticsDaily.pressureScore,
      pressureSignal: analyticsDaily.pressureSignal,
      liquidityScore: analyticsDaily.liquidityScore,
      opportunityScore: analyticsDaily.opportunityScore,
      dataConfidenceScore: analyticsDaily.dataConfidenceScore,
    })
    .from(marketDaily)
    .innerJoin(instruments, eq(marketDaily.instrumentId, instruments.id))
    .leftJoin(
      analyticsDaily,
      and(
        eq(analyticsDaily.instrumentId, marketDaily.instrumentId),
        eq(analyticsDaily.tradingDate, marketDaily.tradingDate),
        eq(analyticsDaily.modelVersion, ANALYTICS_MODEL_VERSION),
      ),
    )
    .where(eq(marketDaily.tradingDate, tradingDate))
    .orderBy(desc(marketDaily.turnoverTzs));

  return rows.map((r) => ({
    instrumentId: r.instrumentId,
    symbol: r.symbol,
    name: r.name,
    sector: r.sector,
    tradingDate: r.tradingDate,
    close: toNum(r.close),
    previousClose: toNum(r.previousClose),
    changePct: toNum(r.changePct),
    turnoverTzs: toNum(r.turnoverTzs),
    volume: toNum(r.volume),
    deals: r.deals,
    bidQty: toNum(r.bidQty),
    offerQty: toNum(r.offerQty),
    marketCapTzs: toNum(r.marketCapTzs),
    boRatio: toNum(r.boRatio),
    boState: (r.boState ?? 'EMPTY_BOOK') as BoState,
    boMomentumPct: toNum(r.boMomentumPct),
    volumeRatio: toNum(r.volumeRatio),
    pressureScore: toNum(r.pressureScore),
    pressureSignal: (r.pressureSignal ?? 'INSUFFICIENT_DATA') as PressureSignal,
    liquidityScore: toNum(r.liquidityScore),
    opportunityScore: toNum(r.opportunityScore),
    dataConfidenceScore: toNum(r.dataConfidenceScore),
  }));
}

/** The stored market summary for a date, as display types. */
export async function marketSummary(
  tradingDate: string,
): Promise<MarketSummary | null> {
  const rows = await db
    .select()
    .from(marketDailySummary)
    .where(
      and(
        eq(marketDailySummary.tradingDate, tradingDate),
        eq(marketDailySummary.modelVersion, ANALYTICS_MODEL_VERSION),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    tradingDate: row.tradingDate,
    totalTurnoverTzs: toNum(row.totalTurnoverTzs),
    totalVolume: toNum(row.totalVolume),
    totalDeals: row.totalDeals,
    countersTraded: row.countersTraded,
    countersListed: row.countersListed,
    totalBidQty: toNum(row.totalBidQty),
    totalOfferQty: toNum(row.totalOfferQty),
    marketBoRatio: toNum(row.marketBoRatio),
    marketBoState: row.marketBoState,
    totalMarketCapTzs: toNum(row.totalMarketCapTzs),
    gainers: row.gainers,
    losers: row.losers,
    unchanged: row.unchanged,
    marketPressureScore: toNum(row.marketPressureScore),
    marketPressureSignal: row.marketPressureSignal,
    breadthComponents: row.breadthComponents,
    dataConfidenceScore: toNum(row.dataConfidenceScore),
  };
}

/* -------------------------------------------------------------------------- */
/* Instrument detail                                                          */
/* -------------------------------------------------------------------------- */

export interface InstrumentDetail {
  instrument: {
    id: string;
    symbol: string;
    name: string;
    sector: string | null;
    securityType: string;
    currency: string;
    isCrossListed: boolean;
    sharesOutstanding: number | null;
    listedDate: string | null;
    active: boolean;
  };
  latest: MarketRow | null;
  /** Component breakdowns, exposed verbatim so a score can be taken apart. */
  pressureComponents: Record<string, number | null>;
  opportunityComponents: Record<string, number | null>;
  confidenceFactors: Record<string, unknown>;
  avgBo5d: number | null;
  boObservations5d: number;
  avgVolume20d: number | null;
  medianVolume20d: number | null;
  turnoverRatio: number | null;
  avgDealSize: number | null;
  liquidityPercentile: number | null;
  return1d: number | null;
  return5d: number | null;
  return20d: number | null;
  volatility20d: number | null;
  rangePct: number | null;
  bidValueTzs: number | null;
  offerValueTzs: number | null;
  bidPctMcap: number | null;
  offerPctMcap: number | null;
}

export async function instrumentDetail(
  symbol: string,
): Promise<InstrumentDetail | null> {
  const found = await db
    .select()
    .from(instruments)
    .where(eq(instruments.symbol, symbol.toUpperCase()))
    .limit(1);

  const instrument = found[0];
  if (!instrument) return null;

  // Most recent session this instrument has data for - not necessarily the
  // market's latest date, because a counter may not have traded recently.
  const latestRows = await db
    .select({
      market: marketDaily,
      analytics: analyticsDaily,
    })
    .from(marketDaily)
    .leftJoin(
      analyticsDaily,
      and(
        eq(analyticsDaily.instrumentId, marketDaily.instrumentId),
        eq(analyticsDaily.tradingDate, marketDaily.tradingDate),
        eq(analyticsDaily.modelVersion, ANALYTICS_MODEL_VERSION),
      ),
    )
    .where(eq(marketDaily.instrumentId, instrument.id))
    .orderBy(desc(marketDaily.tradingDate))
    .limit(1);

  const row = latestRows[0];
  const a = row?.analytics ?? null;
  const md = row?.market ?? null;

  const base = {
    instrument: {
      id: instrument.id,
      symbol: instrument.symbol,
      name: instrument.name,
      sector: instrument.sector,
      securityType: instrument.securityType,
      currency: instrument.currency,
      isCrossListed: instrument.isCrossListed,
      sharesOutstanding: toNum(instrument.sharesOutstanding),
      listedDate: instrument.listedDate,
      active: instrument.active,
    },
    pressureComponents: a?.pressureComponents ?? {},
    opportunityComponents: a?.opportunityComponents ?? {},
    confidenceFactors: a?.confidenceFactors ?? {},
    avgBo5d: toNum(a?.avgBo5d),
    boObservations5d: a?.boObservations5d ?? 0,
    avgVolume20d: toNum(a?.avgVolume20d),
    medianVolume20d: toNum(a?.medianVolume20d),
    turnoverRatio: toNum(a?.turnoverRatio),
    avgDealSize: toNum(a?.avgDealSize),
    liquidityPercentile: toNum(a?.liquidityPercentile),
    return1d: toNum(a?.return1d),
    return5d: toNum(a?.return5d),
    return20d: toNum(a?.return20d),
    volatility20d: toNum(a?.volatility20d),
    rangePct: toNum(a?.rangePct),
    bidValueTzs: toNum(a?.bidValueTzs),
    offerValueTzs: toNum(a?.offerValueTzs),
    bidPctMcap: toNum(a?.bidPctMcap),
    offerPctMcap: toNum(a?.offerPctMcap),
  };

  if (!md) {
    return { ...base, latest: null };
  }

  return {
    ...base,
    latest: {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      name: instrument.name,
      sector: instrument.sector,
      tradingDate: md.tradingDate,
      close: toNum(md.close),
      previousClose: toNum(md.previousClose),
      changePct: toNum(md.changePct),
      turnoverTzs: toNum(md.turnoverTzs),
      volume: toNum(md.volume),
      deals: md.deals,
      bidQty: toNum(md.outstandingBidQty),
      offerQty: toNum(md.outstandingOfferQty),
      marketCapTzs: toNum(md.marketCapTzs),
      boRatio: toNum(a?.boRatio),
      boState: (a?.boState ?? 'EMPTY_BOOK') as BoState,
      boMomentumPct: toNum(a?.boMomentumPct),
      volumeRatio: toNum(a?.volumeRatio),
      pressureScore: toNum(a?.pressureScore),
      pressureSignal: (a?.pressureSignal ?? 'INSUFFICIENT_DATA') as PressureSignal,
      liquidityScore: toNum(a?.liquidityScore),
      opportunityScore: toNum(a?.opportunityScore),
      dataConfidenceScore: toNum(a?.dataConfidenceScore),
    },
  };
}

/** Converts a display range into an inclusive start date. */
export function rangeStartDate(range: PeriodRange, latest: string): string {
  if (range === 'MAX') return '1900-01-01';
  const end = new Date(`${latest}T00:00:00Z`);
  const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36 }[range];
  end.setUTCMonth(end.getUTCMonth() - months);
  return end.toISOString().slice(0, 10);
}

/**
 * Price / flow / order-book history for one instrument, oldest first.
 * Oldest-first because that is the order a time-series chart plots.
 */
export async function instrumentHistory(
  instrumentId: string,
  from: string,
  to: string,
): Promise<HistoryPoint[]> {
  const rows = await db
    .select({
      tradingDate: marketDaily.tradingDate,
      close: marketDaily.close,
      volume: marketDaily.volume,
      turnoverTzs: marketDaily.turnoverTzs,
      bidQty: marketDaily.outstandingBidQty,
      offerQty: marketDaily.outstandingOfferQty,
      changePct: marketDaily.changePct,
      boRatio: analyticsDaily.boRatio,
      boState: analyticsDaily.boState,
      boMomentumPct: analyticsDaily.boMomentumPct,
      pressureScore: analyticsDaily.pressureScore,
      volumeRatio: analyticsDaily.volumeRatio,
    })
    .from(marketDaily)
    .leftJoin(
      analyticsDaily,
      and(
        eq(analyticsDaily.instrumentId, marketDaily.instrumentId),
        eq(analyticsDaily.tradingDate, marketDaily.tradingDate),
        eq(analyticsDaily.modelVersion, ANALYTICS_MODEL_VERSION),
      ),
    )
    .where(
      and(
        eq(marketDaily.instrumentId, instrumentId),
        gte(marketDaily.tradingDate, from),
        lte(marketDaily.tradingDate, to),
      ),
    )
    .orderBy(asc(marketDaily.tradingDate));

  return rows.map((r) => ({
    tradingDate: r.tradingDate,
    close: toNum(r.close),
    volume: toNum(r.volume),
    turnoverTzs: toNum(r.turnoverTzs),
    bidQty: toNum(r.bidQty),
    offerQty: toNum(r.offerQty),
    boRatio: toNum(r.boRatio),
    boState: (r.boState ?? 'EMPTY_BOOK') as BoState,
    boMomentumPct: toNum(r.boMomentumPct),
    pressureScore: toNum(r.pressureScore),
    volumeRatio: toNum(r.volumeRatio),
    changePct: toNum(r.changePct),
  }));
}

/* -------------------------------------------------------------------------- */
/* Dashboard slices                                                           */
/* -------------------------------------------------------------------------- */

export interface DashboardSlices {
  gainers: MarketRow[];
  losers: MarketRow[];
  mostActive: MarketRow[];
  strongestDemand: MarketRow[];
  strongestSupply: MarketRow[];
  momentumLeaders: MarketRow[];
  unusualVolume: MarketRow[];
}

/**
 * Derives the dashboard's lists from one already-fetched table.
 *
 * Sorting in memory over ~30 counters is far cheaper than seven more round
 * trips, and it guarantees every panel describes the same session.
 */
export function dashboardSlices(
  rows: readonly MarketRow[],
  limit = 5,
): DashboardSlices {
  const traded = rows.filter((r) => (r.volume ?? 0) > 0);

  const byChange = (dir: 1 | -1) =>
    traded
      .filter((r) => r.changePct !== null && r.changePct !== 0)
      .filter((r) => (dir === 1 ? (r.changePct as number) > 0 : (r.changePct as number) < 0))
      .sort((a, b) => dir * ((b.changePct as number) - (a.changePct as number)))
      .slice(0, limit);

  const withPressure = rows.filter((r) => r.pressureScore !== null);

  return {
    gainers: byChange(1),
    losers: byChange(-1),
    mostActive: [...traded]
      .sort((a, b) => (b.turnoverTzs ?? 0) - (a.turnoverTzs ?? 0))
      .slice(0, limit),
    strongestDemand: [...withPressure]
      .sort((a, b) => (b.pressureScore as number) - (a.pressureScore as number))
      .slice(0, limit),
    strongestSupply: [...withPressure]
      .sort((a, b) => (a.pressureScore as number) - (b.pressureScore as number))
      .slice(0, limit),
    momentumLeaders: rows
      .filter((r) => r.boMomentumPct !== null)
      .sort((a, b) => (b.boMomentumPct as number) - (a.boMomentumPct as number))
      .slice(0, limit),
    unusualVolume: rows
      .filter((r) => r.volumeRatio !== null && (r.volumeRatio as number) >= 2)
      .sort((a, b) => (b.volumeRatio as number) - (a.volumeRatio as number))
      .slice(0, limit),
  };
}

/** Whether any market data exists at all, for empty-state decisions. */
export async function hasAnyMarketData(): Promise<boolean> {
  const rows = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(marketDaily)
    .limit(1);
  return (rows[0]?.count ?? 0) > 0;
}
