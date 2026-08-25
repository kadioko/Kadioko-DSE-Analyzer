import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-handler contracts.
 *
 * Next.js route handlers are ordinary functions from a Request to a Response,
 * so they are called directly here. The database and the ingestion pipeline are
 * mocked: what is under test is the contract each route promises — its status
 * codes, its envelope, its validation, and what it refuses to disclose — not
 * whether Postgres works, which the integration tests already cover.
 */

const ORIGINAL = { ...process.env };

const pingDatabase = vi.fn();
const latestTradingDate = vi.fn();
const runScheduledIngestionWithRetry = vi.fn();

vi.mock('@/lib/db/client', () => ({
  pingDatabase: () => pingDatabase(),
  db: new Proxy({}, { get: () => { throw new Error('db must not be touched'); } }),
}));

vi.mock('@/lib/db/repositories/market', () => ({
  latestTradingDate: () => latestTradingDate(),
}));

vi.mock('@/lib/ingestion/scheduled', () => ({
  runScheduledIngestionWithRetry: (opts: unknown) => runScheduledIngestionWithRetry(opts),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.DATABASE_URL = 'postgresql://user:secret@db.internal:5432/kadioko';
  process.env.ADMIN_TOKEN = 'a'.repeat(64);
  process.env.ADMIN_EMAIL = 'operator@example.com';
  process.env.CRON_SECRET = 'c'.repeat(64);
  process.env.DATA_PROVIDER = 'csv';
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

/** Every route answers in the same envelope, so tests read it the same way. */
async function body(res: Response) {
  return (await res.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

describe('GET /api/health', () => {
  it('reports ok, with the latest session, when the database answers', async () => {
    pingDatabase.mockResolvedValue({ ok: true, latencyMs: 12 });
    latestTradingDate.mockResolvedValue('2026-08-24');

    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data?.status).toBe('ok');
    expect((json.data?.data as Record<string, unknown>).latestTradingDate).toBe('2026-08-24');
  });

  it('stays 200 when the database is unreachable, and says degraded', async () => {
    // A health check that flaps to 503 gets the container restarted or pulled
    // while it is otherwise serving fine. The status field is the alert signal.
    pingDatabase.mockResolvedValue({ ok: false, latencyMs: 2000 });

    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data?.status).toBe('degraded');
  });

  it('never leaks the connection string, host, or driver error', async () => {
    // The endpoint is unauthenticated. A driver message routinely contains the
    // host, and sometimes the user.
    pingDatabase.mockResolvedValue({
      ok: false,
      latencyMs: 5,
      error: 'getaddrinfo ENOTFOUND db.internal',
    });

    const { GET } = await import('@/app/api/health/route');
    const text = await (await GET()).text();

    expect(text).not.toContain('secret');
    expect(text).not.toContain('db.internal');
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('ENOTFOUND');
  });

  it('does not disclose the value of any secret it reports on', async () => {
    pingDatabase.mockResolvedValue({ ok: true, latencyMs: 3 });
    latestTradingDate.mockResolvedValue(null);

    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const text = await res.clone().text();
    const json = await body(res);

    // It says whether a feature is usable, never what the secret is.
    expect(text).not.toContain('a'.repeat(64));
    expect(text).not.toContain('c'.repeat(64));
    expect((json.data?.features as Record<string, unknown>).adminRoutes).toBe(true);
    expect((json.data?.features as Record<string, unknown>).scheduledIngestion).toBe(true);
  });

  it('explains an empty deployment rather than looking broken', async () => {
    pingDatabase.mockResolvedValue({ ok: true, latencyMs: 3 });
    latestTradingDate.mockResolvedValue(null);

    const { GET } = await import('@/app/api/health/route');
    const json = await body(await GET());
    const data = json.data?.data as Record<string, unknown>;

    expect(json.data?.status).toBe('ok');
    expect(data.latestTradingDate).toBeNull();
    expect(String(data.note)).toMatch(/expected on a new deployment/i);
  });

  it('reports not_configured, not an error, when no database is set', async () => {
    delete process.env.DATABASE_URL;

    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data?.status).toBe('not_configured');
    expect(pingDatabase).not.toHaveBeenCalled();
  });
});

describe('POST /api/cron/ingest', () => {
  const post = (headers: Record<string, string> = {}, url = 'https://x/api/cron/ingest') =>
    new Request(url, { method: 'POST', headers });

  it('refuses a request with no bearer token', async () => {
    const { POST } = await import('@/app/api/cron/ingest/route');
    const res = await POST(post());
    const json = await body(res);

    expect(res.status).toBe(401);
    expect(json.error?.code).toBe('NOT_AUTHORIZED');
    expect(runScheduledIngestionWithRetry).not.toHaveBeenCalled();
  });

  it('refuses the admin token in place of the cron secret', async () => {
    const { POST } = await import('@/app/api/cron/ingest/route');
    const res = await POST(post({ authorization: `Bearer ${'a'.repeat(64)}` }));

    expect(res.status).toBe(401);
    expect(runScheduledIngestionWithRetry).not.toHaveBeenCalled();
  });

  it('tells an unauthenticated caller nothing about the secret', async () => {
    // The message must not distinguish "not set" from "wrong", or it becomes an
    // oracle for probing configuration.
    const { POST } = await import('@/app/api/cron/ingest/route');
    const wrong = await body(await POST(post({ authorization: 'Bearer wrong' })));

    process.env.CRON_SECRET = '';
    vi.resetModules();
    const { POST: POST2 } = await import('@/app/api/cron/ingest/route');
    const unset = await body(await POST2(post({ authorization: 'Bearer wrong' })));

    expect(wrong.error?.message).toBe(unset.error?.message);
  });

  it('rejects a malformed date before doing any work', async () => {
    const { POST } = await import('@/app/api/cron/ingest/route');
    const res = await POST(
      post({ authorization: `Bearer ${'c'.repeat(64)}` }, 'https://x/api/cron/ingest?date=24-08-2026'),
    );
    const json = await body(res);

    expect(res.status).toBe(400);
    expect(json.error?.code).toBe('INVALID_DATE');
    expect(runScheduledIngestionWithRetry).not.toHaveBeenCalled();
  });

  it('runs the ingestion for a valid date and passes it through', async () => {
    runScheduledIngestionWithRetry.mockResolvedValue({
      tradingDate: '2026-08-24',
      status: 'SUCCESS',
      inserted: 28,
    });

    const { POST } = await import('@/app/api/cron/ingest/route');
    const res = await POST(
      post({ authorization: `Bearer ${'c'.repeat(64)}` }, 'https://x/api/cron/ingest?date=2026-08-24'),
    );
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data?.status).toBe('SUCCESS');
    expect(runScheduledIngestionWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: 'cron' }),
    );
  });

  it('returns 200 with a FAILED body when the run itself fails', async () => {
    // The request was handled correctly; the ingestion was not. A 5xx here
    // would make a scheduler retry a run that will fail identically.
    runScheduledIngestionWithRetry.mockResolvedValue({
      tradingDate: '2026-08-24',
      status: 'FAILED',
      message: 'Ingest directory is not readable.',
    });

    const { POST } = await import('@/app/api/cron/ingest/route');
    const res = await POST(post({ authorization: `Bearer ${'c'.repeat(64)}` }));
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data?.status).toBe('FAILED');
  });

  it('reports a quiet day as SKIPPED, not as a failure', async () => {
    runScheduledIngestionWithRetry.mockResolvedValue({
      tradingDate: '2026-08-22',
      status: 'SKIPPED',
      message: '2026-08-22 is a weekend; the DSE does not trade.',
    });

    const { POST } = await import('@/app/api/cron/ingest/route');
    const json = await body(await POST(post({ authorization: `Bearer ${'c'.repeat(64)}` })));

    expect(json.data?.status).toBe('SKIPPED');
  });
});

describe('GET /api/cron/ingest', () => {
  it('describes itself without running anything', async () => {
    const { GET } = await import('@/app/api/cron/ingest/route');
    const json = await body(await GET());

    expect(json.ok).toBe(true);
    expect(json.data?.method).toBe('POST');
    expect(runScheduledIngestionWithRetry).not.toHaveBeenCalled();
  });

  it('does not require authorisation merely to read the contract', async () => {
    const { GET } = await import('@/app/api/cron/ingest/route');
    expect((await GET()).status).toBe(200);
  });
});
