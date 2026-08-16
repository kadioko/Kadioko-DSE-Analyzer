import { fail, handle, ok } from '@/lib/api';
import { isDatabaseConfigured } from '@/lib/env';
import { getRankingForSymbol } from '@/lib/services/ranking-service';
import { getLiquidityBand, roundScore } from '@/lib/analytics/ranking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/rankings/[symbol]
 * GET /api/rankings/[symbol]?date=YYYY-MM-DD
 *
 * One security's ranking entry. An ineligible security returns 200 with its
 * exclusion reason rather than 404: "we know about it and here is why it is
 * unranked" is a different answer from "no such security".
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  return handle(async () => {
    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const { symbol } = await params;
    const url = new URL(request.url);
    const date = url.searchParams.get('date') ?? undefined;

    if (date && !ISO_DATE.test(date)) {
      return fail(400, 'INVALID_DATE', 'date must be in YYYY-MM-DD format.');
    }

    const entry = await getRankingForSymbol(decodeURIComponent(symbol), date);
    if (!entry) {
      return fail(
        404,
        'NOT_RANKED',
        `No ranking entry found for ${symbol.toUpperCase()}${date ? ` on ${date}` : ''}.`,
      );
    }

    return ok({
      tradingDate: entry.tradingDate,
      symbol: entry.symbol,
      name: entry.name,
      sector: entry.sector,
      rank: entry.rank,
      previousRank: entry.previousRank,
      rankChange: entry.rankChange,
      isNewEntrant: entry.isNewEntrant,
      totalRanked: entry.totalRanked,
      percentile: entry.percentile === null ? null : roundScore(entry.percentile),
      fundamentalScore: roundScore(entry.fundamentalScore),
      sentimentScore: roundScore(entry.sentimentScore),
      overallScore: roundScore(entry.overallScore),
      grade: entry.grade,
      marketDemand: entry.marketDemand,
      interpretationCode: entry.interpretationCode,
      interpretationEn: entry.interpretationEn,
      interpretationSw: entry.interpretationSw,
      liquidityScore: entry.liquidityScore,
      liquidityBand: getLiquidityBand(entry.liquidityScore),
      dataConfidence: entry.dataConfidence,
      fundamentalPeriod: entry.fundamentalPeriod,
      eligible: entry.eligible,
      exclusionReason: entry.exclusionReason,
    });
  });
}
