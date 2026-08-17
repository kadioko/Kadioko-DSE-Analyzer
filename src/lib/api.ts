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
  fn: () => Promise<Response>,
): Promise<Response> {
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

/**
 * Re-exported from src/lib/rate-limit.ts, which keeps counters in PostgreSQL.
 *
 * This used to be an in-process fixed-window map. That is wrong the moment more
 * than one instance runs: each gets its own allowance, so a limit of 5 across 3
 * instances is really 15.
 */
export { rateLimit, clientKey, pruneRateLimits } from '@/lib/rate-limit';
export type { RateLimitResult } from '@/lib/rate-limit';
