import 'server-only';
import { and, asc, desc, eq, gte, lte, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { analyticsDaily, instruments, marketDaily, marketDailySummary } from '@/lib/db/schema';
import { toNum } from '@/lib/db/num';
import { ANALYTICS_MODEL_VERSION } from '@/lib/analytics/config';

/**
 * Period reports.
 *
 * Aggregation happens in PostgreSQL, on NUMERIC columns, not by summing in
 * JavaScript. Two reasons: money stays exact, and a month of ~20 sessions x ~30
 * counters never has to cross the wire to be totalled.
 */

export type ReportPeriod = 'daily' | 'weekly' | 'monthly';

export interface PeriodBounds {
  from: string;
  to: string;
  label: string;
}

/* -------------------------------------------------------------------------- */
/* Period arithmetic                                                          */
/* -------------------------------------------------------------------------- */

/**
 * ISO-8601 week bounds (Monday start). ISO weeks are used because that is what
 * "week 33 of 2026" unambiguously means; a Sunday-start week would silently
 * disagree with the same label elsewhere.
 */
export function isoWeekBounds(year: number, week: number): PeriodBounds {
  // 4 January is always in ISO week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));

  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    from: monday.toISOString().slice(0, 10),
    to: sunday.toISOString().slice(0, 10),
    label: `Week ${week}, ${year}`,
  };
}

/** ISO week number for a date, for linking a session to its weekly report. */
export function isoWeekOf(iso: string): { year: number; week: number } {
  const date = new Date(`${iso}T00:00:00Z`);
  const target = new Date(date);
  const dayNumber = date.getUTCDay() || 7;
  // Move to the Thursday of this week; the year of that Thursday is the ISO year.
  target.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const year = target.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((target.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

export function monthBounds(year: number, month: number): PeriodBounds {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    label: from.toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Aggregates                                                                 */
/* -------------------------------------------------------------------------- */

export interface PeriodTotals {
  sessions: number;
  firstSession: string | null;
  lastSession: string | null;
  totalTurnoverTzs: number | null;
  totalVolume: number | null;
  totalDeals: number | null;
  avgCountersTraded: number | null;
  avgMarketBoRatio: number | null;
  avgMarketPressure: number | null;
  totalGainerSessions: number | null;
  totalLoserSessions: number | null;
}

/**
 * Whole-period totals, summed in SQL from the stored daily summaries.
 *
 * Returns sessions = 0 rather than zeroed totals when the period has no data,
 * so a caller can distinguish "no trading happened" from "no data imported".
 */
export async function periodTotals(
  from: string,
  to: string,
): Promise<PeriodTotals> {
  const rows = await db
    .select({
      sessions: raw<number>`count(*)::int`,
      firstSession: raw<string | null>`min(${marketDailySummary.tradingDate})::text`,
      lastSession: raw<string | null>`max(${marketDailySummary.tradingDate})::text`,
      totalTurnoverTzs: raw<string | null>`sum(${marketDailySummary.totalTurnoverTzs})`,
      totalVolume: raw<string | null>`sum(${marketDailySummary.totalVolume})`,
      totalDeals: raw<string | null>`sum(${marketDailySummary.totalDeals})`,
      avgCountersTraded: raw<string | null>`avg(${marketDailySummary.countersTraded})`,
      avgMarketBoRatio: raw<string | null>`avg(${marketDailySummary.marketBoRatio})`,
      avgMarketPressure: raw<string | null>`avg(${marketDailySummary.marketPressureScore})`,
      totalGainerSessions: raw<string | null>`sum(${marketDailySummary.gainers})`,
      totalLoserSessions: raw<string | null>`sum(${marketDailySummary.losers})`,
    })
    .from(marketDailySummary)
    .where(
      and(
        eq(marketDailySummary.modelVersion, ANALYTICS_MODEL_VERSION),
        gte(marketDailySummary.tradingDate, from),
        lte(marketDailySummary.tradingDate, to),
      ),
    );

  const r = rows[0];
  return {
    sessions: r?.sessions ?? 0,
    firstSession: r?.firstSession ?? null,
    lastSession: r?.lastSession ?? null,
    totalTurnoverTzs: toNum(r?.totalTurnoverTzs),
    totalVolume: toNum(r?.totalVolume),
    totalDeals: toNum(r?.totalDeals),
    avgCountersTraded: toNum(r?.avgCountersTraded),
    avgMarketBoRatio: toNum(r?.avgMarketBoRatio),
    avgMarketPressure: toNum(r?.avgMarketPressure),
    totalGainerSessions: toNum(r?.totalGainerSessions),
    totalLoserSessions: toNum(r?.totalLoserSessions),
  };
}

export interface PeriodPerformer {
  symbol: string;
  name: string;
  sector: string | null;
  firstClose: number | null;
  lastClose: number | null;
  returnPct: number | null;
  turnoverTzs: number | null;
  volume: number | null;
  deals: number | null;
  sessionsTraded: number;
  avgBoRatio: number | null;
  avgPressure: number | null;
}

/**
 * Per-instrument performance across a period.
 *
 * The period return uses the first and last close that actually exist inside
 * the window (via DISTINCT ON ordering), so a counter that did not trade on the
 * exact boundary session still gets a correct figure rather than a null.
 */
export async function periodPerformance(
  from: string,
  to: string,
): Promise<PeriodPerformer[]> {
  const result = await db.execute(raw`
    with bounds as (
      select
        md.instrument_id,
        min(md.trading_date) filter (where md.close is not null) as first_date,
        max(md.trading_date) filter (where md.close is not null) as last_date,
        sum(md.turnover_tzs)                                     as turnover,
        sum(md.volume)                                           as volume,
        sum(md.deals)                                            as deals,
        count(*) filter (where coalesce(md.volume, 0) > 0)::int  as sessions_traded
      from market_daily md
      where md.trading_date between ${from} and ${to}
      group by md.instrument_id
    ),
    prices as (
      select
        b.instrument_id,
        (select close from market_daily
          where instrument_id = b.instrument_id and trading_date = b.first_date) as first_close,
        (select close from market_daily
          where instrument_id = b.instrument_id and trading_date = b.last_date)  as last_close,
        b.turnover, b.volume, b.deals, b.sessions_traded
      from bounds b
    ),
    derived as (
      select
        a.instrument_id,
        avg(a.bo_ratio)        as avg_bo,
        avg(a.pressure_score)  as avg_pressure
      from analytics_daily a
      where a.trading_date between ${from} and ${to}
        and a.model_version = ${ANALYTICS_MODEL_VERSION}
      group by a.instrument_id
    )
    select
      i.symbol, i.name, i.sector,
      p.first_close, p.last_close, p.turnover, p.volume, p.deals,
      p.sessions_traded, d.avg_bo, d.avg_pressure
    from prices p
    join instruments i on i.id = p.instrument_id
    left join derived d on d.instrument_id = p.instrument_id
    order by p.turnover desc nulls last
  `);

  const rows = result as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const firstClose = toNum(r.first_close as string | null);
    const lastClose = toNum(r.last_close as string | null);
    return {
      symbol: String(r.symbol),
      name: String(r.name),
      sector: (r.sector as string | null) ?? null,
      firstClose,
      lastClose,
      returnPct:
        firstClose !== null && lastClose !== null && firstClose > 0
          ? (lastClose / firstClose - 1) * 100
          : null,
      turnoverTzs: toNum(r.turnover as string | null),
      volume: toNum(r.volume as string | null),
      deals: toNum(r.deals as string | null),
      sessionsTraded: Number(r.sessions_traded ?? 0),
      avgBoRatio: toNum(r.avg_bo as string | null),
      avgPressure: toNum(r.avg_pressure as string | null),
    };
  });
}

/** Daily summaries across a period, for the report's session table and chart. */
export async function sessionSeries(from: string, to: string) {
  const rows = await db
    .select()
    .from(marketDailySummary)
    .where(
      and(
        eq(marketDailySummary.modelVersion, ANALYTICS_MODEL_VERSION),
        gte(marketDailySummary.tradingDate, from),
        lte(marketDailySummary.tradingDate, to),
      ),
    )
    .orderBy(asc(marketDailySummary.tradingDate));

  return rows.map((r) => ({
    tradingDate: r.tradingDate,
    totalTurnoverTzs: toNum(r.totalTurnoverTzs),
    totalVolume: toNum(r.totalVolume),
    totalDeals: r.totalDeals,
    countersTraded: r.countersTraded,
    marketBoRatio: toNum(r.marketBoRatio),
    marketPressureScore: toNum(r.marketPressureScore),
    gainers: r.gainers,
    losers: r.losers,
    unchanged: r.unchanged,
  }));
}

/** Trading dates that have data, newest first, for the reports index. */
export async function availableSessions(limit = 30): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tradingDate: marketDaily.tradingDate })
    .from(marketDaily)
    .orderBy(desc(marketDaily.tradingDate))
    .limit(limit);
  return rows.map((r) => r.tradingDate);
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

export interface ExportRow {
  tradingDate: string;
  symbol: string;
  name: string;
  open: number | null;
  previousClose: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  changePct: number | null;
  turnoverTzs: number | null;
  deals: number | null;
  volume: number | null;
  outstandingBidQty: number | null;
  outstandingOfferQty: number | null;
  marketCapTzs: number | null;
  boRatio: number | null;
  boState: string;
  boMomentumPct: number | null;
  volumeRatio: number | null;
  pressureScore: number | null;
  liquidityScore: number | null;
  dataConfidenceScore: number | null;
}

/**
 * Raw + derived data for export, so the Kadioko DSE Sheet can consume this
 * database rather than maintaining its own.
 *
 * Both are included but stay clearly labelled: observed columns carry the
 * source's own names, derived columns carry the metric names used on screen.
 */
export async function exportRows(
  from: string,
  to: string,
  symbol?: string,
): Promise<ExportRow[]> {
  const conditions = [
    gte(marketDaily.tradingDate, from),
    lte(marketDaily.tradingDate, to),
  ];
  if (symbol) conditions.push(eq(instruments.symbol, symbol.toUpperCase()));

  const rows = await db
    .select({
      tradingDate: marketDaily.tradingDate,
      symbol: instruments.symbol,
      name: instruments.name,
      open: marketDaily.open,
      previousClose: marketDaily.previousClose,
      close: marketDaily.close,
      high: marketDaily.high,
      low: marketDaily.low,
      changePct: marketDaily.changePct,
      turnoverTzs: marketDaily.turnoverTzs,
      deals: marketDaily.deals,
      volume: marketDaily.volume,
      outstandingBidQty: marketDaily.outstandingBidQty,
      outstandingOfferQty: marketDaily.outstandingOfferQty,
      marketCapTzs: marketDaily.marketCapTzs,
      boRatio: analyticsDaily.boRatio,
      boState: analyticsDaily.boState,
      boMomentumPct: analyticsDaily.boMomentumPct,
      volumeRatio: analyticsDaily.volumeRatio,
      pressureScore: analyticsDaily.pressureScore,
      liquidityScore: analyticsDaily.liquidityScore,
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
    .where(and(...conditions))
    .orderBy(asc(marketDaily.tradingDate), asc(instruments.symbol));

  return rows.map((r) => ({
    tradingDate: r.tradingDate,
    symbol: r.symbol,
    name: r.name,
    open: toNum(r.open),
    previousClose: toNum(r.previousClose),
    close: toNum(r.close),
    high: toNum(r.high),
    low: toNum(r.low),
    changePct: toNum(r.changePct),
    turnoverTzs: toNum(r.turnoverTzs),
    deals: r.deals,
    volume: toNum(r.volume),
    outstandingBidQty: toNum(r.outstandingBidQty),
    outstandingOfferQty: toNum(r.outstandingOfferQty),
    marketCapTzs: toNum(r.marketCapTzs),
    boRatio: toNum(r.boRatio),
    boState: r.boState ?? 'EMPTY_BOOK',
    boMomentumPct: toNum(r.boMomentumPct),
    volumeRatio: toNum(r.volumeRatio),
    pressureScore: toNum(r.pressureScore),
    liquidityScore: toNum(r.liquidityScore),
    dataConfidenceScore: toNum(r.dataConfidenceScore),
  }));
}

/**
 * Serialises export rows as CSV.
 *
 * An unavailable value is written as an EMPTY cell, never as 0 — a spreadsheet
 * consuming this must be able to tell "not reported" from "reported as zero".
 * Text cells are quoted and any leading formula trigger is stripped, so the
 * export cannot become a formula when opened in Excel.
 */
export function toCsv(rows: readonly ExportRow[]): string {
  const headers = [
    'trading_date', 'symbol', 'name',
    'open', 'previous_close', 'close', 'high', 'low', 'change_pct',
    'turnover_tzs', 'deals', 'volume',
    'outstanding_bid_qty', 'outstanding_offer_qty', 'market_cap_tzs',
    'bo_ratio', 'bo_state', 'bo_momentum_pct', 'volume_ratio',
    'pressure_score', 'liquidity_score', 'data_confidence_score',
  ];

  const cell = (value: string | number | null): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      return Number.isFinite(value) ? String(value) : '';
    }
    const safe = value.replace(/^[=+\-@\t\r]+/, '');
    return `"${safe.replace(/"/g, '""')}"`;
  };

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        cell(r.tradingDate), cell(r.symbol), cell(r.name),
        cell(r.open), cell(r.previousClose), cell(r.close), cell(r.high),
        cell(r.low), cell(r.changePct),
        cell(r.turnoverTzs), cell(r.deals), cell(r.volume),
        cell(r.outstandingBidQty), cell(r.outstandingOfferQty), cell(r.marketCapTzs),
        cell(r.boRatio), cell(r.boState), cell(r.boMomentumPct), cell(r.volumeRatio),
        cell(r.pressureScore), cell(r.liquidityScore), cell(r.dataConfidenceScore),
      ].join(','),
    );
  }
  return lines.join('\n');
}
