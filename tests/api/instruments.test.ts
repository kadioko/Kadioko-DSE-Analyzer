import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Instrument administration contract.
 *
 * The rules worth protecting here are the destructive ones. A symbol is the
 * identity every stored observation joins on, and an instrument is referenced
 * by every market row, valuation and ranking entry ever recorded for it, so the
 * route offers deactivation and refuses both renaming and deletion.
 */

const ORIGINAL = { ...process.env };

const requireAdmin = vi.fn();
const listInstruments = vi.fn();
const getInstrumentBySymbol = vi.fn();
const updateInstrument = vi.fn();
const upsertInstruments = vi.fn();
const rateLimit = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAdmin: () => requireAdmin(),
  NotAuthorizedError: class NotAuthorizedError extends Error {},
}));

vi.mock('@/lib/db/repositories/instruments', () => ({
  listInstruments: (o: unknown) => listInstruments(o),
  getInstrumentBySymbol: (s: string) => getInstrumentBySymbol(s),
  updateInstrument: (s: string, e: unknown) => updateInstrument(s, e),
  upsertInstruments: (r: unknown) => upsertInstruments(r),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, rateLimit: (...a: unknown[]) => rateLimit(...a) };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/kadioko';
  process.env.ADMIN_TOKEN = 'a'.repeat(64);
  process.env.ADMIN_EMAIL = 'operator@example.com';
  requireAdmin.mockResolvedValue({ email: 'operator@example.com' });
  rateLimit.mockResolvedValue({ allowed: true });
  updateInstrument.mockResolvedValue(true);
  getInstrumentBySymbol.mockResolvedValue(null);
  upsertInstruments.mockResolvedValue({ inserted: 1, updated: 0 });
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const route = () => import('@/app/api/admin/instruments/route');

const send = (method: string, payload: unknown) =>
  new Request('https://x/api/admin/instruments', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

async function body(res: Response) {
  return (await res.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

describe('authorisation', () => {
  it('refuses every verb when not signed in', async () => {
    const { NotAuthorizedError } = await import('@/lib/auth');
    requireAdmin.mockRejectedValue(new NotAuthorizedError('nope'));

    const { GET, POST, PATCH } = await route();
    expect((await GET()).status).toBe(401);
    expect((await POST(send('POST', { symbol: 'X', name: 'X' }))).status).toBe(401);
    expect((await PATCH(send('PATCH', { symbol: 'X' }))).status).toBe(401);

    expect(upsertInstruments).not.toHaveBeenCalled();
    expect(updateInstrument).not.toHaveBeenCalled();
  });
});

describe('adding an instrument', () => {
  it('creates one from a valid body', async () => {
    const { POST } = await route();
    const res = await POST(
      send('POST', { symbol: 'newco', name: 'NewCo PLC', sector: 'Banking' }),
    );
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data?.symbol).toBe('NEWCO');
    // Symbols are normalised on the way in, so casing cannot fork an identity.
    expect(upsertInstruments).toHaveBeenCalledWith([
      expect.objectContaining({ symbol: 'NEWCO', name: 'NewCo PLC' }),
    ]);
  });

  it('refuses to create over a symbol that already exists', async () => {
    // Overwriting would rewrite the identity that all of its history joins on.
    getInstrumentBySymbol.mockResolvedValue({ symbol: 'CRDB' });

    const { POST } = await route();
    const res = await POST(send('POST', { symbol: 'CRDB', name: 'Something else' }));
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.error?.code).toBe('SYMBOL_EXISTS');
    expect(upsertInstruments).not.toHaveBeenCalled();
  });

  it('rejects a malformed symbol', async () => {
    const { POST } = await route();
    for (const symbol of ['', '9LIVES', 'has space', 'way-too-long-a-symbol-here', '@@']) {
      const res = await POST(send('POST', { symbol, name: 'X' }));
      expect(res.status, symbol).toBe(400);
    }
    expect(upsertInstruments).not.toHaveBeenCalled();
  });

  it('requires a name rather than defaulting to the symbol', async () => {
    const { POST } = await route();
    expect((await POST(send('POST', { symbol: 'NEWCO' }))).status).toBe(400);
    expect((await POST(send('POST', { symbol: 'NEWCO', name: '   ' }))).status).toBe(400);
  });

  it('defaults a new instrument to a Tanzanian equity in shillings', async () => {
    const { POST } = await route();
    await POST(send('POST', { symbol: 'NEWCO', name: 'NewCo PLC' }));

    expect(upsertInstruments).toHaveBeenCalledWith([
      expect.objectContaining({
        securityType: 'EQUITY',
        currency: 'TZS',
        countryOfIncorporation: 'TZ',
        // Unknown, and therefore null: a guessed share count would produce a
        // false market-cap anomaly on every import.
        sharesOutstanding: null,
      }),
    ]);
  });
});

describe('editing an instrument', () => {
  it('writes only the fields that were sent', async () => {
    const { PATCH } = await route();
    await PATCH(send('PATCH', { symbol: 'CRDB', sector: 'Financials' }));

    const [, edit] = updateInstrument.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(edit)).toEqual(['sector']);
    // Anything absent must stay absent, or a one-field form blanks a row.
    expect(edit).not.toHaveProperty('name');
    expect(edit).not.toHaveProperty('sharesOutstanding');
  });

  it('deactivates rather than deleting', async () => {
    const { PATCH } = await route();
    const res = await PATCH(send('PATCH', { symbol: 'JATU', active: false }));

    expect(res.status).toBe(200);
    expect(updateInstrument).toHaveBeenCalledWith('JATU', { active: false });
    // There is no DELETE export at all: history must survive.
    const mod = await route();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it('reports a symbol that does not exist rather than silently succeeding', async () => {
    updateInstrument.mockResolvedValue(false);

    const { PATCH } = await route();
    const res = await PATCH(send('PATCH', { symbol: 'NOPE', active: false }));
    const json = await body(res);

    expect(res.status).toBe(404);
    expect(json.error?.code).toBe('NOT_FOUND');
  });

  it('accepts a share count of null to mean unknown, but never zero', async () => {
    const { PATCH } = await route();

    await PATCH(send('PATCH', { symbol: 'CRDB', sharesOutstanding: null }));
    expect(updateInstrument).toHaveBeenCalledWith('CRDB', { sharesOutstanding: null });

    // Zero shares is not a company; it is a mistyped or missing figure.
    const res = await PATCH(send('PATCH', { symbol: 'CRDB', sharesOutstanding: 0 }));
    expect(res.status).toBe(400);
  });
});

describe('declaring a reporting scale', () => {
  it("accepts the wording a statement actually prints", async () => {
    const { PATCH } = await route();

    for (const [input, expected] of [
      ["TZS'000", 1_000],
      ['millions', 1_000_000],
      ['Amounts are stated in TZS millions', 1_000_000],
      [1_000, 1_000],
      ['1', 1],
    ] as const) {
      updateInstrument.mockClear();
      const res = await PATCH(send('PATCH', { symbol: 'CRDB', reportingScale: input }));
      expect(res.status, String(input)).toBe(200);
      expect(updateInstrument).toHaveBeenCalledWith('CRDB', {
        reportingScale: expected,
      });
    }
  });

  it('refuses a scale it cannot read instead of defaulting to 1', async () => {
    // Defaulting would publish figures a thousandfold out, presented as though
    // the issuer had declared them.
    const { PATCH } = await route();
    const res = await PATCH(send('PATCH', { symbol: 'CRDB', reportingScale: 'lots' }));
    const json = await body(res);

    expect(res.status).toBe(400);
    expect(json.error?.code).toBe('INVALID_REPORTING_SCALE');
    expect(updateInstrument).not.toHaveBeenCalled();
  });

  it('clears a declaration with null, returning the issuer to inference', async () => {
    const { PATCH } = await route();
    await PATCH(send('PATCH', { symbol: 'CRDB', reportingScale: null }));
    expect(updateInstrument).toHaveBeenCalledWith('CRDB', { reportingScale: null });
  });

  it('leaves the declaration untouched when the key is absent', async () => {
    const { PATCH } = await route();
    await PATCH(send('PATCH', { symbol: 'CRDB', sector: 'Banking' }));

    const [, edit] = updateInstrument.mock.calls[0] as [string, Record<string, unknown>];
    expect(edit).not.toHaveProperty('reportingScale');
  });
});

describe('rate limiting', () => {
  it('refuses a flood of changes', async () => {
    rateLimit.mockResolvedValue({ allowed: false });

    const { POST, PATCH } = await route();
    expect((await POST(send('POST', { symbol: 'NEWCO', name: 'X' }))).status).toBe(429);
    expect((await PATCH(send('PATCH', { symbol: 'CRDB', active: false }))).status).toBe(429);
    expect(upsertInstruments).not.toHaveBeenCalled();
    expect(updateInstrument).not.toHaveBeenCalled();
  });
});

describe('listing', () => {
  it('includes inactive instruments, so they can be reactivated', async () => {
    listInstruments.mockResolvedValue([
      { symbol: 'CRDB', active: true },
      { symbol: 'JATU', active: false },
    ]);

    const { GET } = await route();
    const json = await body(await GET());

    expect(listInstruments).toHaveBeenCalledWith({ activeOnly: false });
    expect(json.data?.count).toBe(2);
  });
});
