// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InstrumentTable,
  type InstrumentRow,
} from '@/app/admin/instruments/instrument-table';
import { NO_DATA } from '@/lib/format';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const ROWS: InstrumentRow[] = [
  {
    symbol: 'CRDB',
    name: 'CRDB Bank PLC',
    securityType: 'EQUITY',
    sector: 'Banking',
    isCrossListed: false,
    currency: 'TZS',
    active: true,
    sharesOutstanding: 2_611_837_037,
    reportingScale: '1000000.00',
    reportingScaleSource: 'FY2025 statements, p.14',
  },
  {
    symbol: 'NICO',
    name: 'NICOL',
    securityType: 'EQUITY',
    sector: 'Investment',
    isCrossListed: false,
    currency: 'TZS',
    active: true,
    sharesOutstanding: null,
    reportingScale: null,
    reportingScaleSource: null,
  },
  {
    symbol: 'JATU',
    name: 'JATU PLC',
    securityType: 'EQUITY',
    sector: 'Agriculture',
    isCrossListed: false,
    currency: 'TZS',
    active: false,
    sharesOutstanding: 20_000_000,
    reportingScale: null,
    reportingScaleSource: null,
  },
];

const INFERRED = { NICO: 1_000 };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data: { symbol: 'NICO' } }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('what the table shows', () => {
  it('lists active instruments and hides inactive ones by default', () => {
    render(<InstrumentTable instruments={ROWS} inferred={INFERRED} />);

    expect(screen.getByText('CRDB')).toBeTruthy();
    expect(screen.getByText('NICO')).toBeTruthy();
    // Deactivated, so out of the way until asked for.
    expect(screen.queryByText('JATU')).toBeNull();
  });

  it('reveals inactive instruments so they can be reactivated', () => {
    render(<InstrumentTable instruments={ROWS} inferred={INFERRED} />);
    fireEvent.click(screen.getByLabelText(/show inactive/i));

    expect(screen.getByText('JATU')).toBeTruthy();
    expect(screen.getByRole('button', { name: /reactivate/i })).toBeTruthy();
  });

  it('distinguishes a declared scale from an inferred one', () => {
    const { container } = render(
      <InstrumentTable instruments={ROWS} inferred={INFERRED} />,
    );
    const text = container.textContent ?? '';

    // CRDB declared its own unit; NICO's was worked out from the figures.
    expect(text).toContain('millions');
    expect(text).toMatch(/inferred thousands/);
  });

  it('shows an unknown share count as a dash, never as zero', () => {
    const { container } = render(
      <InstrumentTable instruments={ROWS} inferred={INFERRED} />,
    );
    expect(container.textContent).toContain(NO_DATA);
    // 2,611,837,037 is present; a fabricated 0 for NICO is not.
    expect(container.textContent).toContain('2,611,837,037');
  });

  it('warns while any issuer is still relying on inference', () => {
    render(<InstrumentTable instruments={ROWS} inferred={INFERRED} />);
    expect(screen.getByText(/inferred reporting scale/i)).toBeTruthy();
  });

  it('says nothing when every issuer has declared', () => {
    const declared = ROWS.map((r) => ({ ...r, reportingScale: '1000.00' }));
    render(<InstrumentTable instruments={declared} inferred={{}} />);
    expect(screen.queryByText(/inferred reporting scale/i)).toBeNull();
  });

  it('states plainly that instruments are deactivated, not deleted', () => {
    const { container } = render(
      <InstrumentTable instruments={ROWS} inferred={INFERRED} />,
    );
    expect(container.textContent).toMatch(/deactivated, never deleted/i);
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });
});

describe('editing a row', () => {
  it('sends only the edited fields, and normalises a blank to null', async () => {
    render(<InstrumentTable instruments={ROWS} inferred={INFERRED} />);

    // NICO is the second row; edit it.
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[1]!);
    fireEvent.change(screen.getByPlaceholderText(/TZS'000/i), {
      target: { value: "TZS'000" },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));

    expect(init.method).toBe('PATCH');
    expect(sent.symbol).toBe('NICO');
    expect(sent.reportingScale).toBe("TZS'000");
    // The share count box was left empty, which means unknown, not zero.
    expect(sent.sharesOutstanding).toBeNull();
  });

  it('refuses a share count that is not a number, before sending anything', async () => {
    render(<InstrumentTable instruments={ROWS} inferred={INFERRED} />);

    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]!);
    fireEvent.change(screen.getByPlaceholderText(/unknown/i), {
      target: { value: 'quite a lot' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/must be a number/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the server’s reason when a save is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        ok: false,
        error: { code: 'INVALID_REPORTING_SCALE', message: '"lots" is not a reporting scale.' },
      }),
    });

    render(<InstrumentTable instruments={ROWS} inferred={INFERRED} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/is not a reporting scale/i)).toBeTruthy();
    // The row stays open so the operator can correct it rather than retype it.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy();
  });
});

describe('deactivating', () => {
  it('sends the toggle and refreshes the page data', async () => {
    render(<InstrumentTable instruments={ROWS} inferred={INFERRED} />);
    fireEvent.click(screen.getAllByRole('button', { name: /deactivate/i })[0]!);

    await waitFor(() => expect(refresh).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ symbol: 'CRDB', active: false });
  });
});
