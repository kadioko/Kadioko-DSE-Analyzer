import 'server-only';
import type { MarketDailyRow } from '@/lib/db/schema';
import type { NewAnalyticsDailyRow } from '@/lib/db/schema';
import { toNum, toNumeric, toQty, toScore } from '@/lib/db/num';
import { analyzeOrderBook } from './bo';
import { averageBo, boMomentum, computeReturns } from './momentum';
import { analyzeVolume, liquidityScore } from './liquidity';
import { computePressure } from './pressure';
import { computeOpportunity } from './opportunity';
import { computeConfidence } from './confidence';
import { buildMarketSummary, type MarketConstituent } from './market';
import { ANALYTICS_MODEL_VERSION, WINDOWS } from './config';
import { bulkHistory, marketRowsForDate } from '@/lib/db/repositories/market';
import {
  upsertAnalyticsDaily,
  upsertMarketSummary,
} from '@/lib/db/repositories/analytics';
import { listInstruments } from '@/lib/db/repositories/instruments';
import {
  regenerateValuationsForDate,
  valuationsForDate,
} from '@/lib/services/valuation-service';
import type { ScoreComponent } from '@/lib/types/market';

/**
 * Analytics generation.
 *
 * Reads raw observations, computes every derived metric with the pure analytics
 * modules, and writes the results to `analytics_daily` and
 * `market_daily_summary`. It never modifies a raw observation, and it can be
 * re-run at any time to reproduce or correct derived data.
 *
 * How many trailing sessions are loaded is set by the widest window any metric
 * needs, plus one so a 20-day return has a reference price.
 */
const HISTORY_SESSIONS = WINDOWS.longVolume + 2;

/** Flattens a component map into the jsonb shape stored for transparency. */
function serializeComponents(
  components: Record<string, ScoreComponent>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [name, c] of Object.entries(components)) {
    out[name] = c.available ? Number(c.contribution.toFixed(4)) : null;
    out[`${name}_raw`] = c.raw === null ? null : Number(c.raw.toFixed(4));
    out[`${name}_weight`] = c.weight;
  }
  return out;
}

/** Converts a stored market row into plain numbers for the analytics engine. */
function toNumbers(row: MarketDailyRow) {
  return {
    tradingDate: row.tradingDate,
    close: toNum(row.close),
    previousClose: toNum(row.previousClose),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    changePct: toNum(row.changePct),
    turnoverTzs: toNum(row.turnoverTzs),
    deals: row.deals,
    volume: toNum(row.volume),
    bidQty: toNum(row.outstandingBidQty),
    offerQty: toNum(row.outstandingOfferQty),
    marketCapTzs: toNum(row.marketCapTzs),
  };
}

export interface RegenerateResult {
  tradingDate: string;
  instrumentsProcessed: number;
  summaryWritten: boolean;
}

/**
 * Regenerates all derived analytics for one trading date.
 *
 * The per-instrument pass runs first, because the market summary's
 * turnover-weighted pressure component consumes the individual pressure scores
 * computed here.
 */
export async function regenerateAnalyticsForDate(
  tradingDate: string,
  options: { today?: Date } = {},
): Promise<RegenerateResult> {
  const sessionRows = await marketRowsForDate(tradingDate);
  if (sessionRows.length === 0) {
    return { tradingDate, instrumentsProcessed: 0, summaryWritten: false };
  }

  // Valuations are regenerated first because the Opportunity score consumes
  // them. Doing it in this order means one call keeps the whole derived set
  // for a date consistent.
  await regenerateValuationsForDate(tradingDate);
  const valuationBySymbol = await valuationsForDate(tradingDate);

  const instrumentIds = sessionRows.map((r) => r.market.instrumentId);
  const history = await bulkHistory(instrumentIds, tradingDate, HISTORY_SESSIONS);

  // Turnovers across the whole session, for the liquidity percentile.
  const marketTurnovers = sessionRows
    .map((r) => toNum(r.market.turnoverTzs))
    .filter((t): t is number => t !== null && t > 0);

  const today = options.today ?? new Date();
  const analyticsRows: NewAnalyticsDailyRow[] = [];
  const constituents: MarketConstituent[] = [];
  const confidenceScores: number[] = [];

  for (const { market, instrument } of sessionRows) {
    const current = toNumbers(market);

    // history[0] is the current session; everything after it is trailing.
    const sessions = (history.get(market.instrumentId) ?? []).map(toNumbers);
    const trailing = sessions.slice(1);

    /* -- Order book ------------------------------------------------------ */
    const book = analyzeOrderBook({
      bidQty: current.bidQty,
      offerQty: current.offerQty,
      close: current.close,
      marketCapTzs: current.marketCapTzs,
    });

    const trailingBooks = trailing.map((s) => {
      const b = analyzeOrderBook({ bidQty: s.bidQty, offerQty: s.offerQty });
      return { ratio: b.ratio, state: b.state };
    });

    const momentum = boMomentum({ ratio: book.ratio, state: book.state }, trailingBooks);
    const avg5d = averageBo(trailingBooks);

    /* -- Volume and liquidity -------------------------------------------- */
    const volumeProfile = analyzeVolume({
      volume: current.volume,
      turnoverTzs: current.turnoverTzs,
      deals: current.deals,
      marketCapTzs: current.marketCapTzs,
      close: current.close,
      trailingVolumes: trailing.map((s) => s.volume),
      marketTurnovers,
    });

    const tradedSessions = sessions.filter((s) => (s.volume ?? 0) > 0).length;

    const liquidity = liquidityScore({
      profile: volumeProfile,
      turnoverTzs: current.turnoverTzs,
      deals: current.deals,
      bidQty: current.bidQty,
      offerQty: current.offerQty,
      close: current.close,
      tradedSessions,
      windowSessions: sessions.length,
    });

    /* -- Returns ---------------------------------------------------------- */
    const returns = computeReturns(
      sessions.map((s) => s.close),
      current.high,
      current.low,
      // Dates let the window checks reject a reference session that is too far
      // back to be the one it claims to be.
      sessions.map((s) => s.tradingDate),
    );

    // Fall back to the change implied by close and previous close when the
    // source did not supply one.
    const changePct =
      current.changePct ??
      (current.close !== null &&
      current.previousClose !== null &&
      current.previousClose > 0
        ? (current.close / current.previousClose - 1) * 100
        : returns.return1d);

    /* -- Pressure --------------------------------------------------------- */
    const pressure = computePressure({
      book,
      boMomentumPct: momentum.momentumPct,
      changePct,
      volumeRatio: volumeProfile.volumeRatio,
      liquidityScore: liquidity.liquidityScore,
    });

    /* -- Confidence ------------------------------------------------------- */
    const missingFields: string[] = [];
    if (current.close === null) missingFields.push('close');
    if (current.volume === null) missingFields.push('volume');
    if (current.turnoverTzs === null) missingFields.push('turnover');
    if (current.bidQty === null) missingFields.push('outstanding bid');
    if (current.offerQty === null) missingFields.push('outstanding offer');

    const ageInDays = Math.max(
      0,
      Math.round(
        (today.getTime() - new Date(`${tradingDate}T00:00:00Z`).getTime()) /
          86_400_000,
      ),
    );

    const confidence = computeConfidence({
      missingFields,
      marketCapTzs: current.marketCapTzs,
      historySessions: sessions.length,
      ageInDays,
      traded: (current.volume ?? 0) > 0,
      turnoverTzs: current.turnoverTzs,
      hasValidationWarnings: market.validationStatus === 'WARNING',
      // Whether the originating feed is licensed is a property of the source;
      // until a licensed feed exists this is false and costs 10 points.
      sourceLicensed: false,
      // Fundamentals are wired in at Phase 10. Passing undefined means "not
      // assessed" rather than asserting the issuer has published nothing.
      hasFundamentals: undefined,
    });
    confidenceScores.push(confidence.score);

    /* -- Opportunity ------------------------------------------------------ */
    // Valuation multiples now come from the valuations table. Fundamental
    // ratios remain null here: the Opportunity fundamentals pillar is fed by
    // the fundamental scorecard, and a pillar with no data is excluded and
    // reported rather than imputed.
    const valuation = valuationBySymbol.get(instrument.symbol);
    const opportunity = computeOpportunity({
      roePct: null,
      netMarginPct: null,
      debtToEquity: null,
      epsGrowthPct: null,
      peRatio: valuation?.peRatio ?? null,
      pbRatio: valuation?.pbRatio ?? null,
      dividendYieldPct: valuation?.dividendYield ?? null,
      return20dPct: returns.return20d,
      return5dPct: returns.return5d,
      liquidityScore: liquidity.liquidityScore,
      pressureScore: pressure.pressureScore,
      volatility20dPct: returns.volatility20d,
    });

    analyticsRows.push({
      instrumentId: market.instrumentId,
      tradingDate,
      boRatio: toNumeric(book.ratio, 6),
      boState: book.state,
      bidValueTzs: toNumeric(book.bidValueTzs, 4),
      offerValueTzs: toNumeric(book.offerValueTzs, 4),
      bidPctMcap: toNumeric(book.bidPctMcap, 6),
      offerPctMcap: toNumeric(book.offerPctMcap, 6),
      avgBo5d: toNumeric(avg5d.avg, 6),
      boMomentumPct: toNumeric(momentum.momentumPct, 6),
      boObservations5d: momentum.observations,
      avgVolume5d: toNumeric(volumeProfile.avgVolume5d, 4),
      avgVolume20d: toNumeric(volumeProfile.avgVolume20d, 4),
      medianVolume20d: toNumeric(volumeProfile.medianVolume20d, 4),
      volumeRatio: toNumeric(volumeProfile.volumeRatio, 6),
      turnoverRatio: toNumeric(volumeProfile.turnoverRatio, 6),
      avgDealSize: toNumeric(volumeProfile.avgDealSize, 4),
      liquidityPercentile: toNumeric(volumeProfile.liquidityPercentile, 2),
      return1d: toNumeric(returns.return1d, 6),
      return5d: toNumeric(returns.return5d, 6),
      return20d: toNumeric(returns.return20d, 6),
      rangePct: toNumeric(returns.rangePct, 6),
      volatility20d: toNumeric(returns.volatility20d, 6),
      liquidityScore: toScore(liquidity.liquidityScore),
      pressureScore: toScore(pressure.pressureScore),
      opportunityScore: toScore(opportunity.opportunityScore),
      dataConfidenceScore: toScore(confidence.score),
      pressureSignal: pressure.signal,
      pressureComponents: {
        ...serializeComponents(pressure.components),
        coverage: Number(pressure.coverage.toFixed(2)),
      },
      opportunityComponents: {
        ...serializeComponents(opportunity.components),
        coverage: Number(opportunity.coverage.toFixed(2)),
      },
      confidenceFactors: {
        score: confidence.score,
        factors: confidence.factors,
        missingPillars: opportunity.missing,
        modelVersion: confidence.modelVersion,
      },
      modelVersion: ANALYTICS_MODEL_VERSION,
      generatedAt: new Date(),
    });

    constituents.push({
      instrumentId: market.instrumentId,
      symbol: instrument.symbol,
      close: current.close,
      previousClose: current.previousClose,
      changePct,
      turnoverTzs: current.turnoverTzs,
      volume: current.volume,
      deals: current.deals,
      bidQty: current.bidQty,
      offerQty: current.offerQty,
      marketCapTzs: current.marketCapTzs,
      pressureScore: pressure.pressureScore,
    });
  }

  await upsertAnalyticsDaily(analyticsRows);

  /* -- Market summary ----------------------------------------------------- */
  const activeInstruments = await listInstruments({ activeOnly: true });
  const meanConfidence =
    confidenceScores.length > 0
      ? confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length
      : null;

  const summary = buildMarketSummary(
    tradingDate,
    constituents,
    activeInstruments.length,
    meanConfidence,
  );

  await upsertMarketSummary({
    tradingDate: summary.tradingDate,
    totalTurnoverTzs: toNumeric(summary.totalTurnoverTzs, 4),
    totalVolume: toQty(summary.totalVolume),
    totalDeals: summary.totalDeals,
    countersTraded: summary.countersTraded,
    countersListed: summary.countersListed,
    totalBidQty: toQty(summary.totalBidQty),
    totalOfferQty: toQty(summary.totalOfferQty),
    marketBoRatio: toNumeric(summary.marketBoRatio, 6),
    marketBoState: summary.marketBoState,
    totalMarketCapTzs: toNumeric(summary.totalMarketCapTzs, 4),
    gainers: summary.gainers,
    losers: summary.losers,
    unchanged: summary.unchanged,
    marketPressureScore: toScore(summary.marketPressureScore),
    marketPressureSignal: summary.marketPressureSignal,
    breadthComponents: summary.breadthComponents,
    dataConfidenceScore: toScore(summary.dataConfidenceScore),
    modelVersion: ANALYTICS_MODEL_VERSION,
    generatedAt: new Date(),
  });

  return {
    tradingDate,
    instrumentsProcessed: analyticsRows.length,
    summaryWritten: true,
  };
}

/**
 * Regenerates analytics for several dates, oldest first.
 *
 * Order matters: a later date's trailing windows read the same raw table, so
 * processing chronologically keeps any partial failure leaving a consistent
 * prefix rather than gaps in the middle.
 */
export async function regenerateAnalyticsForDates(
  tradingDates: readonly string[],
  options: { today?: Date } = {},
): Promise<RegenerateResult[]> {
  const ordered = [...new Set(tradingDates)].sort();
  const results: RegenerateResult[] = [];
  for (const date of ordered) {
    results.push(await regenerateAnalyticsForDate(date, options));
  }
  return results;
}
