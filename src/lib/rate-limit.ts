import 'server-only';
import { sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { isDatabaseConfigured } from '@/lib/env';

/**
 * Distributed rate limiting.
 *
 * Counters live in PostgreSQL, not in process memory, because Railway may run
 * several instances of the web service. An in-memory counter gives each
 * instance its own allowance, so a limit of 5 across 3 instances is really 15 —
 * which quietly defeats the point of limiting admin sign-in attempts at all.
 *
 * The whole check is a single atomic statement. Read-then-write would race
 * between concurrent requests and let a burst through.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  /** True when the limiter could not reach the database. */
  degraded: boolean;
}

/**
 * Fixed-window limiter.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` both resets an expired window and
 * increments a live one in one round trip, and returns the resulting count, so
 * two simultaneous requests cannot both see the pre-increment value.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);

  if (!isDatabaseConfigured()) {
    // Nothing to limit against. Reported rather than silently allowing.
    return { allowed: true, remaining: limit, resetAt, degraded: true };
  }

  try {
    const windowSeconds = Math.ceil(windowMs / 1000);

    const result = await db.execute(raw`
      insert into rate_limits (key, window_start, count, updated_at)
      values (${key}, now(), 1, now())
      on conflict (key) do update set
        -- Expired window: start a new one at 1. Live window: increment.
        window_start = case
          when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          then now()
          else rate_limits.window_start
        end,
        count = case
          when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          then 1
          else rate_limits.count + 1
        end,
        updated_at = now()
      returning
        count::int                                              as count,
        (window_start + make_interval(secs => ${windowSeconds}))::text as reset_at
    `);

    const rows = result as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    const count = Number(row?.count ?? 1);
    const reset = row?.reset_at ? new Date(String(row.reset_at)) : resetAt;

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: reset,
      degraded: false,
    };
  } catch (error) {
    /*
     * Fail OPEN, and say so.
     *
     * The alternative is failing closed, which would turn a database blip into
     * a total outage of every rate-limited route including admin sign-in. The
     * routes this guards are additionally protected by real authentication, so
     * an unlimited window is a smaller harm than a locked-out operator. The
     * `degraded` flag lets the caller log it.
     */
    console.error('[rate-limit] database unavailable, failing open', error);
    return { allowed: true, remaining: limit, resetAt, degraded: true };
  }
}

/**
 * Removes expired counters.
 *
 * Called opportunistically from the scheduled ingestion run rather than on a
 * timer, so a serverless instance does not hold a process open.
 */
export async function pruneRateLimits(olderThanHours = 24): Promise<number> {
  if (!isDatabaseConfigured()) return 0;
  try {
    const result = await db.execute(raw`
      delete from rate_limits
      where window_start < now() - make_interval(hours => ${olderThanHours})
      returning key
    `);
    return (result as unknown as unknown[]).length;
  } catch {
    return 0;
  }
}

/** Best-effort client identity. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return request.headers.get('x-real-ip') ?? 'unknown';
}
