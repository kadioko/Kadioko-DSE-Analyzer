import { describe, expect, it } from 'vitest';
import {
  isoWeekBounds,
  isoWeekOf,
  monthBounds,
  toCsv,
  type ExportRow,
} from '@/lib/services/report-service';

/**
 * Period arithmetic is easy to get subtly wrong, and a wrong week boundary
 * silently produces a report that omits or double-counts a session. These cases
 * pin the edges: year boundaries, 53-week years, and leap Februarys.
 */

describe('ISO week bounds', () => {
  it('starts weeks on Monday and ends them on Sunday', () => {
    const w = isoWeekBounds(2026, 33);
    expect(w.from).toBe('2026-08-10');
    expect(w.to).toBe('2026-08-16');
    expect(new Date(`${w.from}T00:00:00Z`).getUTCDay()).toBe(1); // Monday
    expect(new Date(`${w.to}T00:00:00Z`).getUTCDay()).toBe(0); // Sunday
  });

  it('places week 1 by the 4 January rule', () => {
    // 2026-01-01 is a Thursday, so ISO week 1 starts Monday 2025-12-29.
    expect(isoWeekBounds(2026, 1).from).toBe('2025-12-29');
    // 2027-01-01 is a Friday, so week 1 starts Monday 2027-01-04.
    expect(isoWeekBounds(2027, 1).from).toBe('2027-01-04');
  });

  it('handles a 53-week year', () => {
    // 2026 is a 53-week ISO year.
    const w53 = isoWeekBounds(2026, 53);
    expect(w53.from).toBe('2026-12-28');
    expect(w53.to).toBe('2027-01-03');
  });

  it('produces contiguous, non-overlapping weeks', () => {
    for (let week = 1; week < 52; week += 1) {
      const current = isoWeekBounds(2026, week);
      const next = isoWeekBounds(2026, week + 1);
      const dayAfterEnd = new Date(`${current.to}T00:00:00Z`);
      dayAfterEnd.setUTCDate(dayAfterEnd.getUTCDate() + 1);
      expect(dayAfterEnd.toISOString().slice(0, 10)).toBe(next.from);
    }
  });
});

describe('ISO week of a date', () => {
  it('round-trips with isoWeekBounds', () => {
    for (const date of ['2026-08-10', '2026-08-11', '2026-08-16', '2026-03-02']) {
      const { year, week } = isoWeekOf(date);
      const bounds = isoWeekBounds(year, week);
      expect(date >= bounds.from && date <= bounds.to).toBe(true);
    }
  });

  it('assigns early-January dates to the previous ISO year where correct', () => {
    // 2027-01-01 is a Friday, so it belongs to ISO week 53 of 2026.
    const { year, week } = isoWeekOf('2027-01-01');
    expect(year).toBe(2026);
    expect(week).toBe(53);
  });
});

describe('month bounds', () => {
  it('covers the whole calendar month', () => {
    const m = monthBounds(2026, 8);
    expect(m.from).toBe('2026-08-01');
    expect(m.to).toBe('2026-08-31');
  });

  it('handles 30-day months and February', () => {
    expect(monthBounds(2026, 4).to).toBe('2026-04-30');
    expect(monthBounds(2026, 2).to).toBe('2026-02-28');
  });

  it('handles a leap February', () => {
    expect(monthBounds(2028, 2).to).toBe('2028-02-29');
  });

  it('handles December without rolling into the next year', () => {
    const m = monthBounds(2026, 12);
    expect(m.from).toBe('2026-12-01');
    expect(m.to).toBe('2026-12-31');
  });
});

describe('CSV export', () => {
  const row: ExportRow = {
    tradingDate: '2026-08-11',
    symbol: 'CRDB',
    name: 'CRDB Bank Plc',
    open: null,
    previousClose: 2580,
    close: 2600,
    high: null,
    low: null,
    changePct: 0.78,
    turnoverTzs: 1_442_616_130,
    deals: 412,
    volume: 553_818,
    outstandingBidQty: 435_736,
    outstandingOfferQty: 138_838,
    marketCapTzs: null,
    boRatio: 3.138449,
    boState: 'NORMAL',
    boMomentumPct: 29.84,
    volumeRatio: null,
    pressureScore: 64.8,
    liquidityScore: 82.9,
    dataConfidenceScore: 55,
  };

  it('writes an empty cell for an unavailable value, never a zero', () => {
    const csv = toCsv([row]);
    const cells = (csv.split('\n')[1] as string).split(',');
    const headers = (csv.split('\n')[0] as string).split(',');

    const at = (name: string) => cells[headers.indexOf(name)];

    // These distinctions are the whole point of the export contract.
    expect(at('open')).toBe('');
    expect(at('volume_ratio')).toBe('');
    expect(at('market_cap_tzs')).toBe('');
    expect(at('close')).toBe('2600');
  });

  it('quotes text and strips a leading formula trigger', () => {
    const csv = toCsv([{ ...row, name: '=cmd|calc' }]);
    expect(csv).toContain('"cmd|calc"');
    expect(csv).not.toContain('"=cmd');
  });

  it('escapes embedded quotes', () => {
    const csv = toCsv([{ ...row, name: 'A "quoted" name' }]);
    expect(csv).toContain('"A ""quoted"" name"');
  });

  it('emits a header row even with no data rows', () => {
    const csv = toCsv([]);
    expect(csv.split('\n')).toHaveLength(1);
    expect(csv).toContain('trading_date,symbol,name');
  });

  it('keeps bo_ratio and bo_state adjacent so they are read together', () => {
    const headers = (toCsv([]).split(',') as string[]);
    const ratio = headers.indexOf('bo_ratio');
    const state = headers.indexOf('bo_state');
    expect(state).toBe(ratio + 1);
  });
});
