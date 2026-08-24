import { handle, ok } from '@/lib/api';
import { isDatabaseConfigured } from '@/lib/env';
import { pingDatabase } from '@/lib/db/client';
import { latestTradingDate } from '@/lib/db/repositories/market';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health
 *
 * Deployment health check, used by Railway and by an operator confirming a
 * deploy is wired up correctly.
 *
 * Unauthenticated, so it deliberately reveals nothing sensitive: no connection
 * string, no host name, and no driver error text (which can contain the host).
 * A database failure reports THAT it failed, never why. The detail is logged
 * server-side and shown to a signed-in administrator on /admin/data.
 *
 * Always returns HTTP 200, including when degraded. A platform health check
 * that flaps to 503 on a transient database blip will restart or pull a
 * container that is otherwise serving fine; the `status` field is the signal to
 * alert on.
 */
export async function GET() {
  return handle(async () => {
    const configured = isDatabaseConfigured();

    if (!configured) {
      return ok({
        status: 'not_configured',
        database: { configured: false, reachable: false },
        message:
          'No DATABASE_URL is set. The application cannot serve market data until one is configured.',
      });
    }

    const ping = await pingDatabase();

    // Freshness only matters if the database answered at all.
    let latestSession: string | null = null;
    if (ping.ok) {
      try {
        latestSession = await latestTradingDate();
      } catch {
        latestSession = null;
      }
    }

    return ok({
      status: ping.ok ? 'ok' : 'degraded',
      database: {
        configured: true,
        reachable: ping.ok,
        latencyMs: ping.latencyMs,
      },
      data: {
        latestTradingDate: latestSession,
        // Stated plainly so an empty deployment is not mistaken for a broken one.
        note:
          latestSession === null
            ? 'No market data has been imported yet. This is expected on a new deployment.'
            : null,
      },
      // Which optional features are actually usable, without revealing values.
      features: {
        adminRoutes: Boolean(process.env.ADMIN_TOKEN && process.env.ADMIN_EMAIL),
        scheduledIngestion: Boolean(process.env.CRON_SECRET),
        dataProvider: process.env.DATA_PROVIDER ?? 'csv',
      },
      timestamp: new Date().toISOString(),
    });
  });
}
