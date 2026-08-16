import 'server-only';
import { NextResponse } from 'next/server';
import { NotAuthorizedError } from './auth';

/**
 * Uniform JSON API envelope.
 *
 * Every endpoint returns the same shape, so a client never has to guess whether
 * a response is data or an error:
 *
 *   { "ok": true,  "data": ... }
 *   { "ok": false, "error": { "code": "...", "message": "..." } }
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

/**
 * Wraps a handler so an unexpected throw becomes a clean 500 without leaking a
 * stack trace or a connection string to the client. The full error is logged
 * server-side.
 */
export async function handle(
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof NotAuthorizedError) {
      return fail(401, 'NOT_AUTHORIZED', error.message);
    }

    console.error('[api] unhandled error', error);
    return fail(
      500,
      'INTERNAL_ERROR',
      'The request could not be completed. The error has been logged.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window in-process rate limiter.
 *
 * Adequate for a single instance and for the surfaces it guards (admin login,
 * import). It is explicitly NOT a distributed limiter: with several instances
 * each holds its own counter. Moving to Redis is a Phase 14 item, and this
 * comment exists so nobody assumes stronger guarantees than it provides.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

/** Best-effort client identity for rate limiting. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/** Periodically drop expired buckets so the map cannot grow without bound. */
if (typeof setInterval !== 'undefined') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 60_000);
  // Do not hold the process open in the worker or during tests.
  timer.unref?.();
}
