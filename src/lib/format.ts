/**
 * Display formatting.
 *
 * The single rule enforced here: a null value renders as an em dash, never as
 * "0", "-" or "N/A" that could be mistaken for an observation. If a number is
 * on screen, it was measured or derived; if it could not be, the reader sees
 * that clearly.
 *
 * Safe for client components - no server imports.
 */

/** What every unavailable value renders as, everywhere in the application. */
export const NO_DATA = '—';

const tzs0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const tzs2 = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatNumber(
  value: number | null | undefined,
  decimals = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NO_DATA;
  }
  return decimals === 0 ? tzs0.format(value) : value.toFixed(decimals);
}

/** Price in TZS. DSE quotes are whole shillings, so 0 dp unless sub-unit. */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NO_DATA;
  }
  return Number.isInteger(value) ? tzs0.format(value) : tzs2.format(value);
}

/**
 * Large TZS amounts abbreviated for headline tiles.
 * Uses bn / m / k rather than the ambiguous "B" and "M".
 */
export function formatCompactTzs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NO_DATA;
  }
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}tn`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return tzs0.format(value);
}

/** Percentage with an explicit sign, for changes and momentum. */
export function formatPctSigned(
  value: number | null | undefined,
  decimals = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NO_DATA;
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

/** Percentage without a forced sign, for shares and ratios expressed as %. */
export function formatPct(
  value: number | null | undefined,
  decimals = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NO_DATA;
  }
  return `${value.toFixed(decimals)}%`;
}

export function formatRatio(
  value: number | null | undefined,
  decimals = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NO_DATA;
  }
  return value.toFixed(decimals);
}

/** Score rendered as a whole number; null scores are withheld, not zeroed. */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NO_DATA;
  }
  return Math.round(value).toString();
}

/** Tailwind text colour class for a directional value. */
export function directionClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'text-ink-400';
  }
  if (value > 0) return 'text-up-400';
  if (value < 0) return 'text-down-400';
  return 'text-ink-300';
}

/** 2026-08-11 -> "11 Aug 2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return NO_DATA;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return NO_DATA;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** 2026-08-11 -> "Tue 11 Aug 2026" */
export function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return NO_DATA;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return NO_DATA;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
