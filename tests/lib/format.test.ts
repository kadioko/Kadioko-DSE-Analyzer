import { describe, expect, it } from 'vitest';
import {
  NO_DATA,
  directionClass,
  formatCompactTzs,
  formatDate,
  formatDateLong,
  formatNumber,
  formatPct,
  formatPctSigned,
  formatPrice,
  formatRatio,
  formatScore,
} from '@/lib/format';

/**
 * These cover the promise the whole product rests on: if a number is on screen
 * it was measured or derived, and if it could not be the reader sees that
 * plainly. A formatter that renders an absent value as "0" turns a gap in the
 * data into an observation, which is the single most damaging thing this
 * codebase could do quietly.
 */

/** Every formatter that takes a number and returns display text. */
const NUMERIC_FORMATTERS: Array<[string, (v: number | null | undefined) => string]> = [
  ['formatNumber', (v) => formatNumber(v)],
  ['formatPrice', formatPrice],
  ['formatCompactTzs', formatCompactTzs],
  ['formatPctSigned', (v) => formatPctSigned(v)],
  ['formatPct', (v) => formatPct(v)],
  ['formatRatio', (v) => formatRatio(v)],
  ['formatScore', formatScore],
];

describe('absent values never render as a number', () => {
  it.each(NUMERIC_FORMATTERS)('%s renders null as the no-data mark', (_name, fn) => {
    expect(fn(null)).toBe(NO_DATA);
  });

  it.each(NUMERIC_FORMATTERS)('%s renders undefined as the no-data mark', (_name, fn) => {
    expect(fn(undefined)).toBe(NO_DATA);
  });

  it.each(NUMERIC_FORMATTERS)(
    '%s refuses NaN and Infinity rather than printing them',
    (_name, fn) => {
      // A division that produced Infinity is a failed calculation, and
      // "Infinity%" on a page reads as a real and spectacular figure.
      expect(fn(Number.NaN)).toBe(NO_DATA);
      expect(fn(Number.POSITIVE_INFINITY)).toBe(NO_DATA);
      expect(fn(Number.NEGATIVE_INFINITY)).toBe(NO_DATA);
    },
  );

  it.each(NUMERIC_FORMATTERS)(
    '%s distinguishes a real zero from an absent value',
    (_name, fn) => {
      // Zero is a measurement: no trades, no change, a flat score. It must be
      // visible as zero and must never collide with the absent mark.
      const zero = fn(0);
      expect(zero).not.toBe(NO_DATA);
      expect(zero).toMatch(/0/);
    },
  );

  it('uses an em dash, not a hyphen that could read as a minus sign', () => {
    expect(NO_DATA).toBe('—');
    expect(NO_DATA).not.toBe('-');
  });
});

describe('formatNumber', () => {
  it('groups thousands and honours a decimal count', () => {
    expect(formatNumber(1_442_616_130)).toBe('1,442,616,130');
    expect(formatNumber(2600)).toBe('2,600');
    expect(formatNumber(3.14159, 2)).toBe('3.14');
  });

  it('keeps negatives negative', () => {
    expect(formatNumber(-2600)).toBe('-2,600');
  });
});

describe('formatPrice', () => {
  it('shows whole shillings without decimals', () => {
    // The DSE quotes in whole shillings, so "2,600.00" is noise.
    expect(formatPrice(2600)).toBe('2,600');
    expect(formatPrice(0)).toBe('0');
  });

  it('shows two decimals only when the price actually has them', () => {
    expect(formatPrice(23.91)).toBe('23.91');
    expect(formatPrice(1850.5)).toBe('1,850.50');
  });
});

describe('formatCompactTzs', () => {
  it('abbreviates by magnitude with unambiguous suffixes', () => {
    // bn and m rather than B and M, which mean different things in different
    // markets and are a real source of order-of-magnitude errors.
    expect(formatCompactTzs(6_999_700_000_000)).toBe('7.00tn');
    expect(formatCompactTzs(9_250_000_000)).toBe('9.25bn');
    expect(formatCompactTzs(2_182_963)).toBe('2.18m');
    expect(formatCompactTzs(79_885)).toBe('79.9k');
  });

  it('leaves small amounts unabbreviated', () => {
    expect(formatCompactTzs(620)).toBe('620');
    expect(formatCompactTzs(0)).toBe('0');
  });

  it('abbreviates negatives by magnitude too', () => {
    expect(formatCompactTzs(-9_250_000_000)).toBe('-9.25bn');
  });
});

describe('percentages', () => {
  it('signs a positive change explicitly', () => {
    // A change of "4.52%" is ambiguous in a column that also holds falls.
    expect(formatPctSigned(4.52)).toBe('+4.52%');
    expect(formatPctSigned(-3.96)).toBe('-3.96%');
  });

  it('leaves an unchanged session as a plain zero, not a signed one', () => {
    expect(formatPctSigned(0)).toBe('0.00%');
  });

  it('does not force a sign where the quantity has no direction', () => {
    // A dividend yield or a share of turnover is not a movement.
    expect(formatPct(5.35)).toBe('5.35%');
    expect(formatPct(0)).toBe('0.00%');
  });
});

describe('formatScore', () => {
  it('rounds to a whole number', () => {
    expect(formatScore(73.4)).toBe('73');
    expect(formatScore(73.5)).toBe('74');
    expect(formatScore(0)).toBe('0');
  });
});

describe('directionClass', () => {
  it('colours by direction, with zero treated as neither', () => {
    expect(directionClass(1)).toBe('text-up-400');
    expect(directionClass(-1)).toBe('text-down-400');
    expect(directionClass(0)).toBe('text-ink-300');
  });

  it('gives an absent value the muted class, not the falling one', () => {
    // Colouring a missing figure red would read as a loss.
    expect(directionClass(null)).toBe('text-ink-400');
    expect(directionClass(undefined)).toBe('text-ink-400');
    expect(directionClass(Number.NaN)).toBe('text-ink-400');
  });
});

describe('dates', () => {
  it('renders an ISO date in the local long-ish form', () => {
    expect(formatDate('2026-08-11')).toBe('11 Aug 2026');
    expect(formatDateLong('2026-08-11')).toBe('Tue, 11 Aug 2026');
  });

  it('reads the date in UTC so the day never shifts by timezone', () => {
    // Formatting in local time would render 2026-01-01 as 31 Dec west of UTC.
    expect(formatDate('2026-01-01')).toBe('01 Jan 2026');
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('refuses an unparseable or absent date', () => {
    expect(formatDate(null)).toBe(NO_DATA);
    expect(formatDate(undefined)).toBe(NO_DATA);
    expect(formatDate('')).toBe(NO_DATA);
    expect(formatDate('not-a-date')).toBe(NO_DATA);
    expect(formatDateLong(null)).toBe(NO_DATA);
    expect(formatDateLong('not-a-date')).toBe(NO_DATA);
  });
});
