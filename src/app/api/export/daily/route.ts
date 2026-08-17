import { z } from 'zod';
import { clientKey, fail, handle, ok, rateLimit } from '@/lib/api';
import { exportRows, toCsv } from '@/lib/services/report-service';
import { isDatabaseConfigured } from '@/lib/env';
import { ANALYTICS_MODEL_VERSION } from '@/lib/analytics/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Data export for the Kadioko DSE Sheet and other consumers.
 *
 *   GET /api/export/daily?date=2026-08-11
 *   GET /api/export/daily?from=2026-08-01&to=2026-08-31&format=csv
 *   GET /api/export/daily?date=2026-08-11&symbol=CRDB
 *
 * This is the interface that lets the Sheet stop maintaining its own market
 * database. Observed and derived columns are both included but stay clearly
 * separated by name, and the response states which model version produced the
 * derived values so a consumer can detect a methodology change.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z
  .object({
    date: z.string().regex(ISO_DATE).optional(),
    from: z.string().regex(ISO_DATE).optional(),
    to: z.string().regex(ISO_DATE).optional(),
    symbol: z.string().max(20).optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .refine((q) => q.date || (q.from && q.to), {
    message: 'Supply either date=YYYY-MM-DD or both from= and to=.',
  });

/** Widest window a single request may cover, to bound response size. */
const MAX_RANGE_DAYS = 400;

export async function GET(request: Request) {
  return handle(async () => {
    if (!isDatabaseConfigured()) {
      return fail(
        503,
        'DATABASE_NOT_CONFIGURED',
        'The server has no database connection configured.',
      );
    }

    const limit = await rateLimit(`export:${clientKey(request)}`, 60, 60_000);
    if (!limit.allowed) {
      return fail(429, 'RATE_LIMITED', 'Too many export requests. Try again shortly.');
    }

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      date: url.searchParams.get('date') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      symbol: url.searchParams.get('symbol') ?? undefined,
      format: url.searchParams.get('format') ?? undefined,
    });

    if (!parsed.success) {
      return fail(
        400,
        'INVALID_QUERY',
        parsed.error.issues[0]?.message ?? 'Invalid query parameters.',
      );
    }

    const { date, symbol, format } = parsed.data;
    const from = date ?? (parsed.data.from as string);
    const to = date ?? (parsed.data.to as string);

    if (from > to) {
      return fail(400, 'INVALID_RANGE', '`from` must not be after `to`.');
    }

    const spanDays =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000;
    if (spanDays > MAX_RANGE_DAYS) {
      return fail(
        400,
        'RANGE_TOO_WIDE',
        `Requested range spans ${Math.round(spanDays)} days, above the ${MAX_RANGE_DAYS}-day limit. Request it in chunks.`,
      );
    }

    const rows = await exportRows(from, to, symbol);

    if (format === 'csv') {
      const filename = symbol
        ? `kadioko-${symbol.toUpperCase()}-${from}-to-${to}.csv`
        : `kadioko-dse-${from}-to-${to}.csv`;

      return new Response(toCsv(rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'private, max-age=60',
          'X-Kadioko-Model-Version': ANALYTICS_MODEL_VERSION,
        },
      });
    }

    return ok(
      {
        from,
        to,
        symbol: symbol?.toUpperCase() ?? null,
        count: rows.length,
        modelVersion: ANALYTICS_MODEL_VERSION,
        // Stated explicitly so a consumer never has to guess which columns are
        // observations and which are this platform's derived values.
        columns: {
          observed: [
            'open', 'previousClose', 'close', 'high', 'low', 'changePct',
            'turnoverTzs', 'deals', 'volume',
            'outstandingBidQty', 'outstandingOfferQty', 'marketCapTzs',
          ],
          derived: [
            'boRatio', 'boState', 'boMomentumPct', 'volumeRatio',
            'pressureScore', 'liquidityScore', 'dataConfidenceScore',
          ],
        },
        notes: [
          'A null value means the figure was not reported or could not be computed. It never means zero.',
          'boRatio is null whenever boState is NO_OFFER or EMPTY_BOOK; read the two together.',
          'Derived columns are reproducible from the observed columns using the published methodology.',
        ],
        rows,
      },
      {
        headers: {
          'Cache-Control': 'private, max-age=60',
          'X-Kadioko-Model-Version': ANALYTICS_MODEL_VERSION,
        },
      },
    );
  });
}
