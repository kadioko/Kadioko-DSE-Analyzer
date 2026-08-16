import { z } from 'zod';
import { clientKey, fail, handle, ok, rateLimit } from '@/lib/api';
import { ADMIN_COOKIE_NAME, authenticateAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().min(1).max(255),
  token: z.string().min(1).max(500),
});

/**
 * Exchanges an allowlisted email plus ADMIN_TOKEN for a signed session cookie.
 *
 * Rate limited hard, and the failure response never distinguishes a wrong email
 * from a wrong token - that distinction would turn this into an oracle for
 * enumerating administrator addresses.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const limit = rateLimit(`admin-login:${clientKey(request)}`, 5, 15 * 60_000);
    if (!limit.allowed) {
      return fail(
        429,
        'RATE_LIMITED',
        'Too many sign-in attempts. Try again later.',
      );
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'INVALID_BODY', 'Email and token are required.');
    }

    const session = authenticateAdmin(parsed.data.email, parsed.data.token);
    if (!session) {
      return fail(401, 'INVALID_CREDENTIALS', 'Sign-in failed.');
    }

    const response = ok({ email: parsed.data.email.trim().toLowerCase() });
    response.cookies.set({
      name: session.cookieName,
      value: session.value,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: session.maxAgeSeconds,
    });
    return response;
  });
}

/** Signs out by clearing the session cookie. */
export async function DELETE() {
  return handle(async () => {
    const response = ok({ signedOut: true });
    response.cookies.set({
      name: ADMIN_COOKIE_NAME,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
    return response;
  });
}
