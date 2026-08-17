import { clientKey, fail, handle, ok, rateLimit } from '@/lib/api';
import { isDatabaseConfigured } from '@/lib/env';
import {
  getRankingSnapshot,
  latestRankingDate,
  type RankingRow,
} from '@/lib/services/ranking-service';
import { getLiquidityBand, roundScore } from '@/lib/analytics/ranking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/export/rankings?date=YYYY-MM-DD&format=csv
 *
 * Lets the Kadioko DSE Sheet consume the SAME ranking the web platform
 * publishes, rather than maintaining a parallel calculation that can drift.
 *
 * Ineligible securities are included with a blank rank and their exclusion
 * reason. Omitting them would let a spreadsheet present a partial market as
 * though it were the whole one.
 */
export async function GET(request: Request) {
  return handle(async () => {
    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const limit = await rateLimit(`export-rankings:${clientKey(request)}`, 60, 60_000);
    if (!limit.allowed) {
      return fail(429, 'RATE_LIMITED', 'Too many export requests.');
    }

    const url = new URL(request.url);
    const requested = url.searchParams.get('date');
    const format = url.searchParams.get('format') ?? 'json';

    if (requested && !ISO_DATE.test(requested)) {
      return fail(400, 'INVALID_DATE', 'date must be in YYYY-MM-DD format.');
    }
    if (format !== 'json' && format !== 'csv') {
      return fail(400, 'INVALID_FORMAT', 'format must be json or csv.');
    }

    const date = requested ?? (await latestRankingDate());
    if (!date) {
      return fail(
        404,
        'NO_SNAPSHOT',
        'No ranking snapshot exists yet.',
      );
    }

    const snapshot = await getRankingSnapshot(date);
    if (!snapshot) {
      return fail(404, 'SNAPSHOT_NOT_FOUND', `No snapshot for ${date}.`);
    }

    if (format === 'csv') {
      return new Response(toRankingCsv(snapshot.tradingDate, snapshot.rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="kadioko-rankings-${snapshot.tradingDate}.csv"`,
          'Cache-Control': 'private, max-age=60',
          'X-Kadioko-Ranking-Model': `${snapshot.model.code}@${snapshot.model.version}`,
        },
      });
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
      notes: [
        'Overall = fundamental x 0.70 + sentiment x 0.30 under the OVERALL model.',
        'A blank rank means the security was not eligible; exclusion_reason states why.',
        'A blank score means the value could not be computed. It never means zero.',
        'This ranking has not been backtested and is not investment advice.',
      ],
      rankings: snapshot.rows,
    });
  });
}

/** CSV serialisation. Blank cells for unavailable values, never zeros. */
function toRankingCsv(tradingDate: string, rows: readonly RankingRow[]): string {
  const headers = [
    'trading_date', 'rank', 'previous_rank', 'rank_change', 'is_new_entrant',
    'symbol', 'name', 'sector',
    'fundamental_score', 'sentiment_score', 'overall_score',
    'grade', 'market_demand',
    'liquidity_score', 'liquidity_band', 'data_confidence',
    'fundamental_period', 'interpretation_code',
    'interpretation_en', 'interpretation_sw',
    'eligible', 'exclusion_reason',
  ];

  const cell = (value: string | number | boolean | null): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      return Number.isFinite(value) ? String(value) : '';
    }
    // Strip a leading formula trigger so the export cannot execute in Excel.
    return `"${value.replace(/^[=+\-@\t\r]+/, '').replace(/"/g, '""')}"`;
  };

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        cell(tradingDate), cell(r.rank), cell(r.previousRank), cell(r.rankChange),
        cell(r.isNewEntrant),
        cell(r.symbol), cell(r.name), cell(r.sector),
        cell(roundScore(r.fundamentalScore)),
        cell(roundScore(r.sentimentScore)),
        cell(roundScore(r.overallScore)),
        cell(r.grade), cell(r.marketDemand),
        cell(r.liquidityScore), cell(getLiquidityBand(r.liquidityScore)),
        cell(r.dataConfidence),
        cell(r.fundamentalPeriod), cell(r.interpretationCode),
        cell(r.interpretationEn), cell(r.interpretationSw),
        cell(r.eligible), cell(r.exclusionReason),
      ].join(','),
    );
  }
  return lines.join('\n');
}
