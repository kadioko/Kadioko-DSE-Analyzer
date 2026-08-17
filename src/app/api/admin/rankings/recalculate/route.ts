import { z } from 'zod';
import { clientKey, fail, handle, ok, rateLimit } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { isDatabaseConfigured } from '@/lib/env';
import { generateRankingSnapshot } from '@/lib/services/ranking-service';
import { regenerateFundamentalScores } from '@/lib/services/fundamental-service';
import { regenerateValuationsForDates } from '@/lib/services/valuation-service';
import { latestTradingDate, listTradingDates } from '@/lib/db/repositories/market';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const bodySchema = z.object({
  /** Omit to recalculate the latest session. */
  date: z.string().regex(ISO_DATE).optional(),
  /** Rebuild every date that has market analytics. */
  all: z.boolean().optional(),
  /** Recompute fundamental scores from `fundamentals` first. */
  regenerateFundamentals: z.boolean().optional(),
  /** Bounds a full rebuild. */
  limit: z.number().int().min(1).max(400).optional(),
});

/**
 * POST /api/admin/rankings/recalculate
 *
 * Admin-only. Regenerates ranking snapshots, optionally rebuilding fundamental
 * scores first. Snapshots are keyed by (model, date, version), so a rerun
 * corrects an existing snapshot rather than creating a duplicate.
 *
 * Dates are processed oldest first, because each snapshot's rank-movement
 * figures are calculated against the preceding one.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await requireAdmin();

    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const limiter = rateLimit(`ranking-recalc:${clientKey(request)}`, 10, 60_000);
    if (!limiter.allowed) {
      return fail(429, 'RATE_LIMITED', 'Too many recalculation requests.');
    }

    const parsed = bodySchema.safeParse(
      await request.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return fail(400, 'INVALID_BODY', 'Invalid request body.');
    }

    const { date, all, regenerateFundamentals, limit } = parsed.data;

    const fundamentalResult = regenerateFundamentals
      ? await regenerateFundamentalScores()
      : null;

    let dates: string[];
    if (all) {
      // Oldest first: rank movement is computed against the previous snapshot,
      // so rebuilding in reverse would produce wrong movement figures.
      dates = (await listTradingDates(limit ?? 60)).slice().reverse();
    } else if (date) {
      dates = [date];
    } else {
      const latest = await latestTradingDate();
      if (!latest) {
        return fail(
          400,
          'NO_MARKET_DATA',
          'No market data has been imported, so there is nothing to rank.',
        );
      }
      dates = [latest];
    }

    // Valuations sit between fundamentals and the ranking: a new financial
    // period changes the multiples, which feed the Opportunity score. Rebuild
    // them for every date being processed before the snapshots are generated.
    const valuationResults = await regenerateValuationsForDates(dates);

    const results = [];
    for (const d of dates) {
      results.push(await generateRankingSnapshot(d));
    }

    const totalRanked = results.reduce((sum, r) => sum + r.ranked, 0);

    return ok({
      triggeredBy: session.email,
      datesProcessed: results.length,
      snapshots: results,
      valuations: {
        datesProcessed: valuationResults.length,
        withPe: valuationResults.reduce((n, v) => n + v.withPe, 0),
        withPb: valuationResults.reduce((n, v) => n + v.withPb, 0),
        withDividendYield: valuationResults.reduce(
          (n, v) => n + v.withDividendYield,
          0,
        ),
      },
      fundamentals: fundamentalResult
        ? {
            periodsConsidered: fundamentalResult.periodsConsidered,
            scoresWritten: fundamentalResult.scoresWritten,
            skipped: fundamentalResult.skipped,
          }
        : null,
      // Said plainly rather than returning an apparently successful empty run.
      warning:
        totalRanked === 0
          ? 'No security could be ranked in any snapshot. Rankings need a fundamental score, which requires published financial results to have been imported.'
          : null,
    });
  });
}
