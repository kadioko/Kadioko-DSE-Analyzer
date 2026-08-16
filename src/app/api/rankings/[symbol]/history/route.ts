import { fail, handle, ok } from '@/lib/api';
import { isDatabaseConfigured } from '@/lib/env';
import { getRankingHistory } from '@/lib/services/ranking-service';
import { roundScore } from '@/lib/analytics/ranking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/rankings/[symbol]/history
 *
 * Rank and score history across stored snapshots, oldest first. Each point
 * comes from the snapshot as published on that date, so the series is a record
 * of what was actually shown rather than a retrospective recomputation.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  return handle(async () => {
    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const { symbol } = await params;
    const history = await getRankingHistory(decodeURIComponent(symbol));

    return ok({
      symbol: decodeURIComponent(symbol).toUpperCase(),
      count: history.length,
      // Stated explicitly: a short series is not evidence of anything, and the
      // model has not been backtested.
      note:
        history.length < 20
          ? 'Too few snapshots to draw conclusions about rank stability. The ranking model has not been backtested.'
          : 'The ranking model has not been backtested. Historical ranks are a record of what was published, not evidence of predictive value.',
      history: history.map((h) => ({
        tradingDate: h.tradingDate,
        rank: h.rank,
        overallScore: roundScore(h.overallScore),
        fundamentalScore: roundScore(h.fundamentalScore),
        sentimentScore: roundScore(h.sentimentScore),
        grade: h.grade,
      })),
    });
  });
}
