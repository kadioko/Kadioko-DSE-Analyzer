import { clientKey, fail, handle, ok, rateLimit } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { commitImport, previewImport } from '@/lib/ingestion/importer';
import { importFundamentalsCsv } from '@/lib/ingestion/fundamentals-import';
import { importCorporateActionsCsv } from '@/lib/ingestion/corporate-actions-import';
import { regenerateAnalyticsForDates } from '@/lib/analytics/pipeline';
import { generateRankingSnapshot, latestRankingDate } from '@/lib/services/ranking-service';
import { regenerateValuationsForDate } from '@/lib/services/valuation-service';
import { latestTradingDate } from '@/lib/db/repositories/market';
import { PARSE_LIMITS } from '@/lib/ingestion/parse';
import { findRunByChecksum, getSourceByName } from '@/lib/db/repositories/ingestion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A large import plus analytics regeneration can exceed the default budget.
export const maxDuration = 300;

const MANUAL_SOURCE = 'Manual CSV upload';

/**
 * CSV import endpoint.
 *
 *   mode=preview  parse + validate only, writes nothing to market_daily
 *   mode=commit   store the approved import and regenerate analytics
 *
 * Preview is the default. An import cannot be committed without the operator
 * having asked for it explicitly.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await requireAdmin();

    const limit = rateLimit(`admin-import:${clientKey(request)}`, 20, 60_000);
    if (!limit.allowed) {
      return fail(429, 'RATE_LIMITED', 'Too many import requests. Try again shortly.');
    }

    const form = await request.formData().catch(() => null);
    if (!form) {
      return fail(400, 'INVALID_BODY', 'Expected a multipart form upload.');
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      return fail(400, 'FILE_REQUIRED', 'No file was supplied.');
    }

    if (file.size > PARSE_LIMITS.maxBytes) {
      return fail(
        413,
        'FILE_TOO_LARGE',
        `File is ${(file.size / 1_048_576).toFixed(1)} MB, above the ${PARSE_LIMITS.maxBytes / 1_048_576} MB limit.`,
      );
    }

    const kind = String(form.get('kind') ?? 'market');
    const mode = String(form.get('mode') ?? 'preview');
    const defaultTradingDate = form.get('tradingDate');
    const content = await file.text();

    // Financial results follow a separate pipeline: they are a small set of
    // carefully checked rows, not a daily observation stream, and the market
    // data-quality rules do not apply to them.
    if (kind === 'fundamentals') {
      const result = await importFundamentalsCsv(content);

      // A new financial period changes the fundamental score, which changes
      // the ranking. Regenerate the latest snapshot so the two stay in step.
      let rankingRegenerated: string | null = null;
      if (result.scoresWritten > 0) {
        const date = (await latestRankingDate()) ?? (await latestTradingDate());
        if (date) {
          // Multiples depend on the results just imported, and the ranking
          // depends on the multiples, so both are rebuilt in that order.
          await regenerateValuationsForDate(date);
          await generateRankingSnapshot(date);
          rankingRegenerated = date;
        }
      }

      return ok({ ...result, kind: 'fundamentals', rankingRegenerated });
    }

    // Corporate actions change dividend yield, which feeds the Opportunity
    // score, so the derived chain is rebuilt for the latest session.
    if (kind === 'corporate_actions') {
      const result = await importCorporateActionsCsv(content);

      let regenerated: string | null = null;
      if (result.accepted > 0) {
        const date = await latestTradingDate();
        if (date) {
          await regenerateAnalyticsForDates([date]);
          await generateRankingSnapshot(date);
          regenerated = date;
        }
      }

      return ok({ ...result, kind: 'corporate_actions', regenerated });
    }

    if (mode === 'preview') {
      const preview = await previewImport(content, {
        fileName: file.name,
        defaultTradingDate:
          typeof defaultTradingDate === 'string' && defaultTradingDate
            ? defaultTradingDate
            : undefined,
      });

      // Warn - but do not block - when this exact file has been seen before.
      const priorRun = await findRunByChecksum(preview.checksum);

      return ok({
        ...preview,
        // The full record list can be very large; the UI needs a bounded sample
        // plus the counts, and every rejected row.
        records: undefined,
        sample: preview.records.slice(0, 50),
        rejectedRows: preview.records.filter((r) => !r.accepted).slice(0, 200),
        previouslyImported: priorRun
          ? {
              runId: priorRun.id,
              startedAt: priorRun.startedAt,
              status: priorRun.status,
            }
          : null,
      });
    }

    if (mode === 'commit') {
      const source = await getSourceByName(MANUAL_SOURCE);
      if (!source) {
        return fail(
          500,
          'SOURCE_MISSING',
          `Ingestion source "${MANUAL_SOURCE}" is not configured. Run npm run db:seed.`,
        );
      }

      const result = await commitImport(content, {
        sourceId: source.id,
        fileName: file.name,
        triggeredBy: session.email,
      });

      return ok(result);
    }

    return fail(400, 'INVALID_MODE', 'mode must be "preview" or "commit".');
  });
}
