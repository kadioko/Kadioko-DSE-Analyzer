import { fail, handle, ok } from '@/lib/api';
import { isValidCronRequest } from '@/lib/auth';
import { isDatabaseConfigured } from '@/lib/env';
import { runScheduledIngestionWithRetry } from '@/lib/ingestion/scheduled';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Ingestion plus analytics, valuations and ranking for a date.
export const maxDuration = 300;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/cron/ingest
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Runs the same scheduled ingestion as the worker, for schedulers that can only
 * make an HTTP request. Authorised by CRON_SECRET, which is deliberately
 * separate from ADMIN_TOKEN so a compromised scheduler cannot reach the admin
 * surfaces.
 *
 * Returns 200 with `status: "FAILED"` in the body when the run itself failed,
 * rather than a 5xx: the request was handled correctly, the ingestion was not.
 * A scheduler should alert on the body, and the status field says exactly what
 * happened.
 */
export async function POST(request: Request) {
  return handle(async () => {
    if (!isValidCronRequest(request.headers.get('authorization'))) {
      // No detail: an unauthenticated caller learns nothing about whether
      // CRON_SECRET is set or merely wrong.
      return fail(401, 'NOT_AUTHORIZED', 'Invalid or missing bearer token.');
    }

    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    const provider = url.searchParams.get('provider') ?? undefined;

    if (date && !ISO_DATE.test(date)) {
      return fail(400, 'INVALID_DATE', 'date must be in YYYY-MM-DD format.');
    }

    const result = await runScheduledIngestionWithRetry({
      date: date ? new Date(`${date}T00:00:00Z`) : undefined,
      providerId: provider,
      // One retry over HTTP: a scheduler will call again, and holding a request
      // open through several backoffs risks a gateway timeout.
      attempts: 2,
      delayMs: 5_000,
      triggeredBy: 'cron',
    });

    return ok(result);
  });
}

/** GET reports what the endpoint expects, without running anything. */
export async function GET() {
  return ok({
    endpoint: '/api/cron/ingest',
    method: 'POST',
    authorization: 'Bearer <CRON_SECRET>',
    parameters: {
      date: 'Optional YYYY-MM-DD. Defaults to today in East Africa Time.',
      provider: 'Optional. csv | dse_official | third_party.',
    },
    note: 'Returns 200 with status FAILED when the run fails. Alert on the status field, not the HTTP code.',
  });
}
