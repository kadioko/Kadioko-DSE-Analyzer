import { fail, handle, ok } from '@/lib/api';
import { isDatabaseConfigured } from '@/lib/env';
import { getRankingSnapshot, latestRankingDate } from '@/lib/services/ranking-service';
import { roundScore } from '@/lib/analytics/ranking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/rankings/latest
 *
 * The most recent stored snapshot. Returns an explicit empty payload rather
 * than a 404 when nothing has been generated, so a consumer can distinguish
 * "no rankings yet" from "this endpoint is broken".
 */
export async function GET() {
  return handle(async () => {
    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const date = await latestRankingDate();
    if (!date) {
      return ok({
        tradingDate: null,
        rankings: [],
        message:
          'No ranking snapshot has been generated yet. Rankings require market analytics and at least one fundamental score.',
      });
    }

    const snapshot = await getRankingSnapshot(date);
    if (!snapshot) {
      return ok({ tradingDate: null, rankings: [] });
    }

    return ok({
      tradingDate: snapshot.tradingDate,
      fundamentalPeriod: snapshot.fundamentalPeriod,
      generatedAt: snapshot.generatedAt,
      model: snapshot.model,
      counts: {
        considered: snapshot.considered,
        ranked: snapshot.ranked,
        excluded: snapshot.excluded,
      },
      rankings: snapshot.rows
        .filter((r) => r.eligible)
        .map((r) => ({
          rank: r.rank,
          rankChange: r.rankChange,
          symbol: r.symbol,
          name: r.name,
          fundamentalScore: roundScore(r.fundamentalScore),
          sentimentScore: roundScore(r.sentimentScore),
          overallScore: roundScore(r.overallScore),
          grade: r.grade,
          marketDemand: r.marketDemand,
          interpretationCode: r.interpretationCode,
          dataConfidence: r.dataConfidence,
        })),
    });
  });
}
