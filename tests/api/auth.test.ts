import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Authorisation is the one place where a bug is not a wrong number on a page
 * but an open door, so it is tested against its own contract rather than
 * through a route.
 *
 * Two things make this file look unusual, and both are deliberate:
 *
 *   - `getEnv()` caches process.env, so `vi.resetModules()` runs before every
 *     import. Without it the second test in a file silently runs against the
 *     first test's environment.
 *   - `next/headers` only exists inside a request, so the cookie store is
 *     mocked. That is the seam the session verifier reads through.
 */

const ORIGINAL = { ...process.env };
const TOKEN = 'a'.repeat(64);
const CRON = 'c'.repeat(64);

let cookieJar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  cookieJar = new Map();
  // getEnv() validates the whole environment, so these unit tests supply a
  // complete one rather than inheriting whatever the shell happens to have.
  // Nothing here connects; the value only has to parse.
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/kadioko';
  process.env.ADMIN_TOKEN = TOKEN;
  process.env.ADMIN_EMAIL = 'operator@example.com';
  process.env.CRON_SECRET = CRON;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const auth = () => import('@/lib/auth');

describe('exchanging a token for a session', () => {
  it('accepts an allowlisted email with the right token', async () => {
    const { authenticateAdmin } = await auth();
    const session = authenticateAdmin('operator@example.com', TOKEN);

    expect(session).not.toBeNull();
    expect(session?.cookieName).toBe('kadioko_admin');
    expect(session?.maxAgeSeconds).toBeGreaterThan(0);
  });

  it('is case and whitespace insensitive about the email only', async () => {
    const { authenticateAdmin } = await auth();
    expect(authenticateAdmin('  OPERATOR@Example.com  ', TOKEN)).not.toBeNull();
    // The token is a secret, and is compared exactly.
    expect(authenticateAdmin('operator@example.com', ` ${TOKEN}`)).toBeNull();
    expect(authenticateAdmin('operator@example.com', TOKEN.toUpperCase())).toBeNull();
  });

  it('rejects an email that is not on the allowlist', async () => {
    const { authenticateAdmin } = await auth();
    expect(authenticateAdmin('someone@else.com', TOKEN)).toBeNull();
  });

  it('rejects a wrong token, including a prefix or extension of the real one', async () => {
    const { authenticateAdmin } = await auth();
    expect(authenticateAdmin('operator@example.com', 'a'.repeat(63))).toBeNull();
    expect(authenticateAdmin('operator@example.com', 'a'.repeat(65))).toBeNull();
    expect(authenticateAdmin('operator@example.com', '')).toBeNull();
  });

  it('refuses everything when no token is configured', async () => {
    // An unset ADMIN_TOKEN must close the door, never open it.
    process.env.ADMIN_TOKEN = '';
    const { authenticateAdmin } = await auth();
    expect(authenticateAdmin('operator@example.com', '')).toBeNull();
    expect(authenticateAdmin('operator@example.com', 'anything')).toBeNull();
  });

  it('refuses everything when no email is allowlisted', async () => {
    process.env.ADMIN_EMAIL = '';
    const { authenticateAdmin } = await auth();
    expect(authenticateAdmin('operator@example.com', TOKEN)).toBeNull();
  });

  it('supports several allowlisted operators', async () => {
    process.env.ADMIN_EMAIL = 'one@example.com, two@example.com';
    const { authenticateAdmin } = await auth();
    expect(authenticateAdmin('one@example.com', TOKEN)).not.toBeNull();
    expect(authenticateAdmin('two@example.com', TOKEN)).not.toBeNull();
    expect(authenticateAdmin('three@example.com', TOKEN)).toBeNull();
  });

  it('does not carry the token inside the cookie it hands back', async () => {
    // The cookie asserts an identity; it is not a bearer of the secret.
    const { authenticateAdmin } = await auth();
    const session = authenticateAdmin('operator@example.com', TOKEN);
    const [encoded] = (session?.value ?? '').split('.');
    const payload = Buffer.from(encoded ?? '', 'base64url').toString('utf8');

    expect(session?.value).not.toContain(TOKEN);
    expect(payload).not.toContain(TOKEN);
    expect(payload).toContain('operator@example.com');
  });
});

describe('verifying a session cookie', () => {
  /** Signs in and puts the resulting cookie in the mocked jar. */
  async function signIn(email = 'operator@example.com') {
    const { authenticateAdmin } = await auth();
    const session = authenticateAdmin(email, TOKEN);
    if (!session) throw new Error('sign-in failed to produce a session');
    cookieJar.set(session.cookieName, session.value);
    return session;
  }

  it('accepts the cookie it just issued', async () => {
    await signIn();
    const { getAdminSession } = await auth();
    const session = await getAdminSession();
    expect(session?.email).toBe('operator@example.com');
  });

  it('returns null when there is no cookie at all', async () => {
    const { getAdminSession } = await auth();
    expect(await getAdminSession()).toBeNull();
  });

  it('rejects a cookie whose payload was edited', async () => {
    const issued = await signIn();
    const [, signature] = issued.value.split('.');

    // Re-encode a payload claiming a different identity, keeping the old
    // signature. This is the attack the HMAC exists to stop.
    const forged = Buffer.from(
      `attacker@example.com:${Date.now() + 60_000}`,
      'utf8',
    ).toString('base64url');
    cookieJar.set(issued.cookieName, `${forged}.${signature}`);

    const { getAdminSession } = await auth();
    expect(await getAdminSession()).toBeNull();
  });

  it('rejects a cookie with a corrupted signature', async () => {
    const issued = await signIn();
    const [encoded] = issued.value.split('.');
    cookieJar.set(issued.cookieName, `${encoded}.${'0'.repeat(64)}`);

    const { getAdminSession } = await auth();
    expect(await getAdminSession()).toBeNull();
  });

  it('rejects unsigned and malformed values', async () => {
    const { getAdminSession } = await auth();
    for (const junk of ['', '.', 'nodot', 'a.b', '....']) {
      cookieJar.set('kadioko_admin', junk);
      expect(await getAdminSession(), junk).toBeNull();
    }
  });

  it('rejects a session that has expired', async () => {
    const issued = await signIn();
    cookieJar.set(issued.cookieName, issued.value);

    // Move past the eight-hour lifetime rather than forging a past timestamp,
    // which would fail on the signature instead of on the expiry.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 9 * 60 * 60 * 1000);
    try {
      const { getAdminSession } = await auth();
      expect(await getAdminSession()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes access the moment an address leaves the allowlist', async () => {
    // The cookie is still validly signed and unexpired. Access must stop
    // anyway, or removing an operator would not take effect until they log out.
    const issued = await signIn();
    cookieJar.set(issued.cookieName, issued.value);

    vi.resetModules();
    process.env.ADMIN_EMAIL = 'someone.else@example.com';

    const { getAdminSession } = await auth();
    expect(await getAdminSession()).toBeNull();
  });

  it('stops honouring cookies once the token is unset', async () => {
    const issued = await signIn();
    cookieJar.set(issued.cookieName, issued.value);

    vi.resetModules();
    process.env.ADMIN_TOKEN = '';

    const { getAdminSession } = await auth();
    expect(await getAdminSession()).toBeNull();
  });
});

describe('the scheduled-ingestion bearer check', () => {
  it('accepts exactly the configured secret', async () => {
    const { isValidCronRequest } = await auth();
    expect(isValidCronRequest(`Bearer ${CRON}`)).toBe(true);
  });

  it('rejects a missing, malformed or wrong header', async () => {
    const { isValidCronRequest } = await auth();
    expect(isValidCronRequest(null)).toBe(false);
    expect(isValidCronRequest('')).toBe(false);
    expect(isValidCronRequest(CRON)).toBe(false); // no scheme
    expect(isValidCronRequest(`Basic ${CRON}`)).toBe(false);
    expect(isValidCronRequest('Bearer wrong')).toBe(false);
    expect(isValidCronRequest(`bearer ${CRON}`)).toBe(false); // scheme is case-sensitive here
  });

  it('rejects the admin token, so one secret cannot stand in for the other', async () => {
    // CRON_SECRET and ADMIN_TOKEN are deliberately separate: a compromised
    // scheduler must not be able to reach the admin surfaces.
    const { isValidCronRequest } = await auth();
    expect(isValidCronRequest(`Bearer ${TOKEN}`)).toBe(false);
  });

  it('refuses everything when no cron secret is configured', async () => {
    process.env.CRON_SECRET = '';
    const { isValidCronRequest } = await auth();
    expect(isValidCronRequest('Bearer ')).toBe(false);
    expect(isValidCronRequest('Bearer anything')).toBe(false);
  });
});
