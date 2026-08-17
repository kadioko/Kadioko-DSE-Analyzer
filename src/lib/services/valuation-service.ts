import 'server-only';
import { and, desc, eq, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  fundamentals,
  instruments,
  marketDaily,
  valuations,
} from '@/lib/db/schema';
import { foreignReportingSymbols } from '@/lib/db/repositories/instruments';
import { toNum, toNumeric, toScore } from '@/lib/db/num';
import {
  computeValuation,
  VALUATION_MODEL_VERSION,
  type ValuationNote,
} from '@/lib/analytics/valuation';
import type { PeriodType } from '@/lib/analytics/period';

/**
 * Valuation generation.
 *
 * Joins the close price for a trading date against the most recent financial
 * results that were available on that date, and stores the resulting multiples
 * in `valuations`.
 *
 * The as-of rule is the same one the ranking engine uses: a valuation dated a
 * given day may only use results whose period ended, and which were published,
 * on or before that day. Computing a historical P/E from figures the market did
 * not yet have would make the stored series worthless.
 */

export interface ValuationGenerationResult {
  tradingDate: string;
  instrumentsConsidered: number;
  valuationsWritten: number;
  withPe: number;
  withPb: number;
  withDividendYield: number;
}

/** The subset of a fundamentals row the valuation engine reads. */
interface FundamentalsAsOf {
  id: string;
  instrumentId: string;
  periodEnd: string;
  periodType: PeriodType;
  eps: string | null;
  dps: string | null;
  bookValuePerShare: string | null;
  netIncome: string | null;
  totalEquity: string | null;
  revenue: string | null;
  totalDebt: string | null;
  cashAndEquivalents: string | null;
  sharesOutstanding: number | null;
}

/**
 * Latest fundamentals per instrument available as of a date.
 *
 * Columns are listed and mapped explicitly rather than using `select f.*`:
 * `db.execute` returns the driver's raw snake_case keys, which do NOT match the
 * camelCase Drizzle row type. Casting the result to that type compiles cleanly
 * and then silently yields `undefined` for every field.
 */
async function fundamentalsAsOf(
  asOfDate: string,
): Promise<Map<string, FundamentalsAsOf>> {
  const result = await db.execute(raw`
    select distinct on (f.instrument_id)
      f.id::text                as id,
      f.instrument_id::text     as instrument_id,
      f.period_end::text        as period_end,
      f.period_type             as period_type,
      f.eps                     as eps,
      f.dps                     as dps,
      f.book_value_per_share    as book_value_per_share,
      f.net_income              as net_income,
      f.total_equity            as total_equity,
      f.revenue                 as revenue,
      f.total_debt              as total_debt,
      f.cash_and_equivalents    as cash_and_equivalents,
      f.shares_outstanding      as shares_outstanding
    from fundamentals f
    where f.period_end <= ${asOfDate}::date
      and (f.published_at is null or f.published_at::date <= ${asOfDate}::date)
    order by f.instrument_id, f.period_end desc, f.updated_at desc
  `);

  const rows = result as unknown as Array<Record<string, unknown>>;
  const map = new Map<string, FundamentalsAsOf>();

  for (const r of rows) {
    const instrumentId = r.instrument_id as string | undefined;
    if (!instrumentId) continue;
    map.set(instrumentId, {
      id: String(r.id),
      instrumentId,
      periodEnd: String(r.period_end),
      periodType: r.period_type as PeriodType,
      eps: (r.eps as string | null) ?? null,
      dps: (r.dps as string | null) ?? null,
      bookValuePerShare: (r.book_value_per_share as string | null) ?? null,
      netIncome: (r.net_income as string | null) ?? null,
      totalEquity: (r.total_equity as string | null) ?? null,
      revenue: (r.revenue as string | null) ?? null,
      totalDebt: (r.total_debt as string | null) ?? null,
      cashAndEquivalents: (r.cash_and_equivalents as string | null) ?? null,
      sharesOutstanding:
        r.shares_outstanding === null || r.shares_outstanding === undefined
          ? null
          : Number(r.shares_outstanding),
    });
  }

  return map;
}

/**
 * Regenerates valuations for one trading date. Safe to re-run: rows are keyed
 * by (instrument, date, model version).
 */
export async function regenerateValuationsForDate(
  tradingDate: string,
): Promise<ValuationGenerationResult> {
  const [sessionRows, fundamentalsMap, foreignReporters] = await Promise.all([
    db
      .select({
        instrumentId: marketDaily.instrumentId,
        symbol: instruments.symbol,
        close: marketDaily.close,
        marketCapTzs: marketDaily.marketCapTzs,
        sharesOutstanding: instruments.sharesOutstanding,
      })
      .from(marketDaily)
      .innerJoin(instruments, eq(marketDaily.instrumentId, instruments.id))
      .where(eq(marketDaily.tradingDate, tradingDate)),
    fundamentalsAsOf(tradingDate),
    foreignReportingSymbols(),
  ]);

  const rows = [];
  let withPe = 0;
  let withPb = 0;
  let withDividendYield = 0;

  for (const session of sessionRows) {
    const f = fundamentalsMap.get(session.instrumentId);

    const result = computeValuation({
      closePrice: toNum(session.close),
      // Prefer the share count reported with the results; fall back to the
      // instrument master.
      sharesOutstanding:
        toNum(f?.sharesOutstanding ?? null) ?? toNum(session.sharesOutstanding),
      marketCapTzs: toNum(session.marketCapTzs),
      eps: toNum(f?.eps ?? null),
      dps: toNum(f?.dps ?? null),
      bookValuePerShare: toNum(f?.bookValuePerShare ?? null),
      netIncome: toNum(f?.netIncome ?? null),
      totalEquity: toNum(f?.totalEquity ?? null),
      revenue: toNum(f?.revenue ?? null),
      totalDebt: toNum(f?.totalDebt ?? null),
      cashAndEquivalents: toNum(f?.cashAndEquivalents ?? null),
      periodType: f?.periodType ?? null,
      foreignReportingCurrency: foreignReporters.has(session.symbol),
    });

    if (result.peRatio !== null) withPe += 1;
    if (result.pbRatio !== null) withPb += 1;
    if (result.dividendYield !== null) withDividendYield += 1;

    rows.push({
      instrumentId: session.instrumentId,
      tradingDate,
      fundamentalsId: f?.id ?? null,
      closePrice: toNumeric(toNum(session.close), 4),
      marketCapTzs: toNumeric(toNum(session.marketCapTzs), 4),
      peRatio: toNumeric(result.peRatio, 6),
      pbRatio: toNumeric(result.pbRatio, 6),
      priceToSales: toNumeric(result.priceToSales, 6),
      dividendYield: toNumeric(result.dividendYield, 6),
      earningsYield: toNumeric(result.earningsYield, 6),
      enterpriseValueTzs: toNumeric(result.enterpriseValueTzs, 4),
      evToEbitda: null,
      evToSales: toNumeric(result.evToSales, 6),
      notes: result.notes,
      // Completeness of the multiples themselves, so a reader can see at a
      // glance how much of the valuation picture is actually available.
      dataConfidenceScore: toScore(
        (([result.peRatio, result.pbRatio, result.dividendYield].filter(
          (v) => v !== null,
        ).length /
          3) *
          100),
      ),
      modelVersion: VALUATION_MODEL_VERSION,
      generatedAt: new Date(),
    });
  }

  if (rows.length > 0) {
    const CHUNK = 300;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db
        .insert(valuations)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [
            valuations.instrumentId,
            valuations.tradingDate,
            valuations.modelVersion,
          ],
          set: {
            fundamentalsId: raw`excluded.fundamentals_id`,
            closePrice: raw`excluded.close_price`,
            marketCapTzs: raw`excluded.market_cap_tzs`,
            peRatio: raw`excluded.pe_ratio`,
            pbRatio: raw`excluded.pb_ratio`,
            priceToSales: raw`excluded.price_to_sales`,
            dividendYield: raw`excluded.dividend_yield`,
            earningsYield: raw`excluded.earnings_yield`,
            enterpriseValueTzs: raw`excluded.enterprise_value_tzs`,
            evToSales: raw`excluded.ev_to_sales`,
            notes: raw`excluded.notes`,
            dataConfidenceScore: raw`excluded.data_confidence_score`,
            generatedAt: new Date(),
          },
        });
    }
  }

  return {
    tradingDate,
    instrumentsConsidered: sessionRows.length,
    valuationsWritten: rows.length,
    withPe,
    withPb,
    withDividendYield,
  };
}

export async function regenerateValuationsForDates(
  tradingDates: readonly string[],
): Promise<ValuationGenerationResult[]> {
  const ordered = [...new Set(tradingDates)].sort();
  const results: ValuationGenerationResult[] = [];
  for (const date of ordered) {
    results.push(await regenerateValuationsForDate(date));
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export interface ValuationView {
  tradingDate: string;
  closePrice: number | null;
  marketCapTzs: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  priceToSales: number | null;
  dividendYield: number | null;
  earningsYield: number | null;
  enterpriseValueTzs: number | null;
  evToSales: number | null;
  notes: ValuationNote[];
  dataConfidenceScore: number | null;
  /** The financial period the multiples were computed against. */
  periodEnd: string | null;
  periodType: string | null;
  verified: boolean | null;
}

/** Latest stored valuation for a security. */
export async function latestValuation(
  symbol: string,
): Promise<ValuationView | null> {
  const rows = await db
    .select({
      v: valuations,
      periodEnd: fundamentals.periodEnd,
      periodType: fundamentals.periodType,
      verified: fundamentals.verified,
    })
    .from(valuations)
    .innerJoin(instruments, eq(valuations.instrumentId, instruments.id))
    .leftJoin(fundamentals, eq(valuations.fundamentalsId, fundamentals.id))
    .where(
      and(
        eq(instruments.symbol, symbol.toUpperCase()),
        eq(valuations.modelVersion, VALUATION_MODEL_VERSION),
      ),
    )
    .orderBy(desc(valuations.tradingDate))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    tradingDate: row.v.tradingDate,
    closePrice: toNum(row.v.closePrice),
    marketCapTzs: toNum(row.v.marketCapTzs),
    peRatio: toNum(row.v.peRatio),
    pbRatio: toNum(row.v.pbRatio),
    priceToSales: toNum(row.v.priceToSales),
    dividendYield: toNum(row.v.dividendYield),
    earningsYield: toNum(row.v.earningsYield),
    enterpriseValueTzs: toNum(row.v.enterpriseValueTzs),
    evToSales: toNum(row.v.evToSales),
    notes: (row.v.notes ?? []) as ValuationNote[],
    dataConfidenceScore: toNum(row.v.dataConfidenceScore),
    periodEnd: row.periodEnd ?? null,
    periodType: row.periodType ?? null,
    verified: row.verified ?? null,
  };
}

/** Valuations for many instruments on one date, for the compare page. */
export async function valuationsForDate(
  tradingDate: string,
): Promise<Map<string, ValuationView>> {
  const rows = await db
    .select({
      symbol: instruments.symbol,
      v: valuations,
      periodEnd: fundamentals.periodEnd,
      periodType: fundamentals.periodType,
      verified: fundamentals.verified,
    })
    .from(valuations)
    .innerJoin(instruments, eq(valuations.instrumentId, instruments.id))
    .leftJoin(fundamentals, eq(valuations.fundamentalsId, fundamentals.id))
    .where(
      and(
        eq(valuations.tradingDate, tradingDate),
        eq(valuations.modelVersion, VALUATION_MODEL_VERSION),
      ),
    );

  return new Map(
    rows.map((row) => [
      row.symbol,
      {
        tradingDate: row.v.tradingDate,
        closePrice: toNum(row.v.closePrice),
        marketCapTzs: toNum(row.v.marketCapTzs),
        peRatio: toNum(row.v.peRatio),
        pbRatio: toNum(row.v.pbRatio),
        priceToSales: toNum(row.v.priceToSales),
        dividendYield: toNum(row.v.dividendYield),
        earningsYield: toNum(row.v.earningsYield),
        enterpriseValueTzs: toNum(row.v.enterpriseValueTzs),
        evToSales: toNum(row.v.evToSales),
        notes: (row.v.notes ?? []) as ValuationNote[],
        dataConfidenceScore: toNum(row.v.dataConfidenceScore),
        periodEnd: row.periodEnd ?? null,
        periodType: row.periodType ?? null,
        verified: row.verified ?? null,
      },
    ]),
  );
}

export { VALUATION_MODEL_VERSION };
