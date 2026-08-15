/**
 * Numeric boundary helpers.
 *
 * PostgreSQL NUMERIC columns arrive in JavaScript as strings. That is
 * deliberate: it keeps exact decimal values intact in transit, and it forces an
 * explicit conversion at the point where a value enters floating-point maths.
 *
 * The rule this file encodes:
 *   - Summing / totalling money  -> do it in SQL, on NUMERIC.
 *   - Ratios, percentages, scores -> convert here, then use JS numbers.
 *
 * These helpers have no dependency on the database driver, so they are safe to
 * unit test and to use in shared code.
 */

/** Converts a NUMERIC/bigint column value to a number, preserving null. */
export function toNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Like {@link toNum} but substitutes a caller-chosen fallback for null. */
export function toNumOr(
  value: string | number | null | undefined,
  fallback: number,
): number {
  const n = toNum(value);
  return n === null ? fallback : n;
}

/**
 * Formats a number for a NUMERIC column.
 * Returns null for null/NaN/Infinity so a bad computation is stored as NULL
 * rather than silently persisted as a nonsense value.
 */
export function toNumeric(
  value: number | null | undefined,
  scale = 6,
): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return value.toFixed(scale);
}

/** Formats for a 0-100 score column (2 dp). */
export function toScore(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return clamp(value, 0, 100).toFixed(2);
}

/** Formats an integer quantity column, rejecting non-finite input. */
export function toQty(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to `dp` decimal places, returning null for non-finite input. */
export function round(
  value: number | null | undefined,
  dp = 2,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/** Arithmetic mean, or null when the sample is empty. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Median. Preferred over the mean for volume, because a single block trade can
 * drag a DSE counter's average volume far away from its typical session.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Sample standard deviation; null when fewer than 2 observations. */
export function stdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * Percentile rank of `value` within `population`, expressed 0-100.
 * Uses the "percentage of values strictly below" definition.
 */
export function percentileRank(
  value: number,
  population: readonly number[],
): number | null {
  if (population.length === 0) return null;
  let below = 0;
  for (const v of population) if (v < value) below += 1;
  return (below / population.length) * 100;
}

/**
 * Division that returns null instead of Infinity/NaN.
 * Used everywhere a denominator can legitimately be zero (offer quantity,
 * market cap, average volume) so no fabricated sentinel value is ever stored.
 */
export function safeDiv(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Percentage change from `from` to `to`, as a percentage. Null-safe. */
export function pctChange(
  to: number | null,
  from: number | null,
): number | null {
  if (to === null || from === null || from === 0) return null;
  const r = (to / from - 1) * 100;
  return Number.isFinite(r) ? r : null;
}

/**
 * Maps `value` from [inMin, inMax] onto [outMin, outMax], clamped at both ends.
 * The building block for every 0-100 score component.
 */
export function scaleTo(
  value: number,
  inMin: number,
  inMax: number,
  outMin = 0,
  outMax = 100,
): number {
  if (inMax === inMin) return (outMin + outMax) / 2;
  const t = (value - inMin) / (inMax - inMin);
  return clamp(outMin + t * (outMax - outMin), Math.min(outMin, outMax), Math.max(outMin, outMax));
}
