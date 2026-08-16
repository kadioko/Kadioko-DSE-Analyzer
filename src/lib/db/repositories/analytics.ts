import 'server-only';
import { and, desc, eq, inArray, lte, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  analyticsDaily,
  marketDailySummary,
  type AnalyticsDailyRow,
  type NewAnalyticsDailyRow,
  type NewMarketDailySummaryRow,
} from '@/lib/db/schema';
import { ANALYTICS_MODEL_VERSION } from '@/lib/analytics/config';

/**
 * Derived-analytics data access.
 *
 * Everything written here is reproducible from `market_daily` alone. Rows are
 * keyed by `model_version`, so changing a formula produces new rows rather than
 * overwriting published history.
 */

export async function upsertAnalyticsDaily(
  rows: readonly NewAnalyticsDailyRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const CHUNK = 300;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(analyticsDaily)
      .values(rows.slice(i, i + CHUNK) as NewAnalyticsDailyRow[])
      .onConflictDoUpdate({
        target: [
          analyticsDaily.instrumentId,
          analyticsDaily.tradingDate,
          analyticsDaily.modelVersion,
        ],
        set: {
          boRatio: raw`excluded.bo_ratio`,
          boState: raw`excluded.bo_state`,
          bidValueTzs: raw`excluded.bid_value_tzs`,
          offerValueTzs: raw`excluded.offer_value_tzs`,
          bidPctMcap: raw`excluded.bid_pct_mcap`,
          offerPctMcap: raw`excluded.offer_pct_mcap`,
          avgBo5d: raw`excluded.avg_bo_5d`,
          boMomentumPct: raw`excluded.bo_momentum_pct`,
          boObservations5d: raw`excluded.bo_observations_5d`,
          avgVolume5d: raw`excluded.avg_volume_5d`,
          avgVolume20d: raw`excluded.avg_volume_20d`,
          medianVolume20d: raw`excluded.median_volume_20d`,
          volumeRatio: raw`excluded.volume_ratio`,
          turnoverRatio: raw`excluded.turnover_ratio`,
          avgDealSize: raw`excluded.avg_deal_size`,
          liquidityPercentile: raw`excluded.liquidity_percentile`,
          return1d: raw`excluded.return_1d`,
          return5d: raw`excluded.return_5d`,
          return20d: raw`excluded.return_20d`,
          rangePct: raw`excluded.range_pct`,
          volatility20d: raw`excluded.volatility_20d`,
          liquidityScore: raw`excluded.liquidity_score`,
          pressureScore: raw`excluded.pressure_score`,
          opportunityScore: raw`excluded.opportunity_score`,
          dataConfidenceScore: raw`excluded.data_confidence_score`,
          pressureSignal: raw`excluded.pressure_signal`,
          pressureComponents: raw`excluded.pressure_components`,
          opportunityComponents: raw`excluded.opportunity_components`,
          confidenceFactors: raw`excluded.confidence_factors`,
          generatedAt: new Date(),
        },
      });
  }

  return rows.length;
}

export async function upsertMarketSummary(
  row: NewMarketDailySummaryRow,
): Promise<void> {
  await db
    .insert(marketDailySummary)
    .values(row)
    .onConflictDoUpdate({
      target: [marketDailySummary.tradingDate, marketDailySummary.modelVersion],
      set: {
        totalTurnoverTzs: raw`excluded.total_turnover_tzs`,
        totalVolume: raw`excluded.total_volume`,
        totalDeals: raw`excluded.total_deals`,
        countersTraded: raw`excluded.counters_traded`,
        countersListed: raw`excluded.counters_listed`,
        totalBidQty: raw`excluded.total_bid_qty`,
        totalOfferQty: raw`excluded.total_offer_qty`,
        marketBoRatio: raw`excluded.market_bo_ratio`,
        marketBoState: raw`excluded.market_bo_state`,
        totalMarketCapTzs: raw`excluded.total_market_cap_tzs`,
        gainers: raw`excluded.gainers`,
        losers: raw`excluded.losers`,
        unchanged: raw`excluded.unchanged`,
        marketPressureScore: raw`excluded.market_pressure_score`,
        marketPressureSignal: raw`excluded.market_pressure_signal`,
        breadthComponents: raw`excluded.breadth_components`,
        dataConfidenceScore: raw`excluded.data_confidence_score`,
        generatedAt: new Date(),
      },
    });
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function analyticsForDate(
  tradingDate: string,
  modelVersion: string = ANALYTICS_MODEL_VERSION,
): Promise<AnalyticsDailyRow[]> {
  return db
    .select()
    .from(analyticsDaily)
    .where(
      and(
        eq(analyticsDaily.tradingDate, tradingDate),
        eq(analyticsDaily.modelVersion, modelVersion),
      ),
    );
}

export async function analyticsForInstrument(
  instrumentId: string,
  throughDate: string,
  limit = 260,
  modelVersion: string = ANALYTICS_MODEL_VERSION,
): Promise<AnalyticsDailyRow[]> {
  return db
    .select()
    .from(analyticsDaily)
    .where(
      and(
        eq(analyticsDaily.instrumentId, instrumentId),
        eq(analyticsDaily.modelVersion, modelVersion),
        lte(analyticsDaily.tradingDate, throughDate),
      ),
    )
    .orderBy(desc(analyticsDaily.tradingDate))
    .limit(limit);
}

export async function analyticsForInstruments(
  instrumentIds: readonly string[],
  tradingDate: string,
  modelVersion: string = ANALYTICS_MODEL_VERSION,
): Promise<Map<string, AnalyticsDailyRow>> {
  if (instrumentIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(analyticsDaily)
    .where(
      and(
        inArray(analyticsDaily.instrumentId, instrumentIds as string[]),
        eq(analyticsDaily.tradingDate, tradingDate),
        eq(analyticsDaily.modelVersion, modelVersion),
      ),
    );
  return new Map(rows.map((r) => [r.instrumentId, r]));
}

export async function marketSummaryForDate(
  tradingDate: string,
  modelVersion: string = ANALYTICS_MODEL_VERSION,
) {
  const rows = await db
    .select()
    .from(marketDailySummary)
    .where(
      and(
        eq(marketDailySummary.tradingDate, tradingDate),
        eq(marketDailySummary.modelVersion, modelVersion),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function latestMarketSummary(
  modelVersion: string = ANALYTICS_MODEL_VERSION,
) {
  const rows = await db
    .select()
    .from(marketDailySummary)
    .where(eq(marketDailySummary.modelVersion, modelVersion))
    .orderBy(desc(marketDailySummary.tradingDate))
    .limit(1);
  return rows[0] ?? null;
}

export async function marketSummaryRange(
  from: string,
  to: string,
  modelVersion: string = ANALYTICS_MODEL_VERSION,
) {
  return db
    .select()
    .from(marketDailySummary)
    .where(
      and(
        eq(marketDailySummary.modelVersion, modelVersion),
        raw`${marketDailySummary.tradingDate} between ${from} and ${to}`,
      ),
    )
    .orderBy(marketDailySummary.tradingDate);
}
