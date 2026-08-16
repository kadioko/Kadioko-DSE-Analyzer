import { clientKey, fail, handle, ok, rateLimit } from '@/lib/api';
import { isDatabaseConfigured } from '@/lib/env';
import {
  availableRankingDates,
  getRankingSnapshot,
  latestRankingDate,
} from '@/lib/services/ranking-service';
import { roundScore } from '@/lib/analytics/ranking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/rankings              latest snapshot
 * GET /api/rankings?date=...     a specific historical snapshot
 *
 * Historical dates are served from the STORED snapshot, never recomputed, so a
 * past ranking is exactly what was published on that date. Scores are returned
 * rounded to one decimal place for display alongside the full-precision value.
 */
export async function GET(request: Request) {
  return handle(async () => {
    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const limit = rateLimit(`rankings:${clientKey(request)}`, 120, 60_000);
    if (!limit.allowed) {
      return fail(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
    }

    const url = new URL(request.url);
    const requested = url.searchParams.get('date');

    if (requested && !ISO_DATE.test(requested)) {
      return fail(400, 'INVALID_DATE', 'date must be in YYYY-MM-DD format.');
    }

    const date = requested ?? (await latestRankingDate());
    if (!date) {
      return ok({
        tradingDate: null,
        rankings: [],
        availableDates: [],
        message:
          'No ranking snapshot has been generated yet. Rankings require both market analytics and at least one fundamental score.',
      });
    }

    const snapshot = await getRankingSnapshot(date);
    if (!snapshot) {
      return fail(
        404,
        'SNAPSHOT_NOT_FOUND',
        `No ranking snapshot exists for ${date}.`,
      );
    }

    return ok({
      tradingDate: snapshot.tradingDate,
      fundamentalPeriod: snapshot.fundamentalPeriod,
      generatedAt: snapshot.generatedAt,
      status: snapshot.status,
      notes: snapshot.notes,
      model: snapshot.model,
      counts: {
        considered: snapshot.considered,
        ranked: snapshot.ranked,
        excluded: snapshot.excluded,
      },
      availableDates: await availableRankingDates(60),
      rankings: snapshot.rows.map((r) => ({
        rank: r.rank,
        previousRank: r.previousRank,
        rankChange: r.rankChange,
        isNewEntrant: r.isNewEntrant,
        symbol: r.symbol,
        name: r.name,
        sector: r.sector,
        fundamentalScore: roundScore(r.fundamentalScore),
        sentimentScore: roundScore(r.sentimentScore),
        overallScore: roundScore(r.overallScore),
        // Full precision alongside the display value, so a consumer can
        // reproduce the ordering exactly.
        overallScorePrecise: r.overallScore,
        grade: r.grade,
        marketDemand: r.marketDemand,
        interpretationCode: r.interpretationCode,
        interpretationEn: r.interpretationEn,
        interpretationSw: r.interpretationSw,
        liquidityScore: r.liquidityScore,
        dataConfidence: r.dataConfidence,
        fundamentalPeriod: r.fundamentalPeriod,
        eligible: r.eligible,
        exclusionReason: r.exclusionReason,
      })),
    });
  });
}
