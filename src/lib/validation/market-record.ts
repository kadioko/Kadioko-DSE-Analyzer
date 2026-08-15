/**
 * Data-quality rules for market observations.
 *
 * Two severities:
 *   ERROR   - the row is rejected and never stored. Something is impossible.
 *   WARNING - the row is stored with validation_status = 'WARNING' and its
 *             notes attached, and its data-confidence score is reduced.
 *
 * Every rule has a stable code so the admin error inspector can group and
 * explain failures, and so a rule can be referenced in documentation.
 */

import { z } from 'zod';
import type {
  NormalizedMarketRecord,
  ValidationIssue,
} from '@/lib/types/market';
import { QUALITY_BOUNDS } from '@/lib/analytics/config';

/* -------------------------------------------------------------------------- */
/* Shape validation                                                           */
/* -------------------------------------------------------------------------- */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be ISO format YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(d)), 'Date is not a real calendar date');

const nonNegative = z.number().nonnegative().nullable();

export const normalizedMarketRecordSchema = z.object({
  symbol: z
    .string()
    .min(1, 'Symbol is required')
    .max(20, 'Symbol is longer than 20 characters')
    .regex(/^[A-Z0-9.\-]+$/, 'Symbol contains unexpected characters'),
  tradingDate: isoDate,
  open: nonNegative,
  previousClose: nonNegative,
  close: nonNegative,
  high: nonNegative,
  low: nonNegative,
  changePct: z.number().nullable(),
  turnoverTzs: nonNegative,
  deals: z.number().int().nonnegative().nullable(),
  volume: nonNegative,
  outstandingBidQty: nonNegative,
  outstandingOfferQty: nonNegative,
  marketCapTzs: nonNegative,
  sourceTimestamp: z.date().nullable(),
  companyName: z.string().nullable().optional(),
});

/* -------------------------------------------------------------------------- */
/* Semantic rules                                                             */
/* -------------------------------------------------------------------------- */

export interface QualityContext {
  /** Symbols present in the instruments table. Unknown symbols are rejected. */
  knownSymbols?: ReadonlySet<string>;
  /** Shares outstanding per symbol, for the market-cap consistency check. */
  sharesOutstanding?: ReadonlyMap<string, number>;
  /** Today, for the future-date rule. Injected so tests are deterministic. */
  today?: Date;
}

/**
 * Applies every semantic data-quality rule to one already-shape-valid record.
 * Pure: takes data, returns issues, touches nothing else.
 */
export function checkQuality(
  record: NormalizedMarketRecord,
  ctx: QualityContext = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (code: string, message: string, severity: 'ERROR' | 'WARNING', field?: string) =>
    issues.push({ code, severity, message, field, symbol: record.symbol });

  /* -- Required fields ---------------------------------------------------- */
  if (record.close === null && record.previousClose === null) {
    at(
      'MISSING_PRICE',
      'Row has neither a close nor a previous close, so no price can be established.',
      'ERROR',
      'close',
    );
  }

  /* -- Date sanity -------------------------------------------------------- */
  const date = new Date(`${record.tradingDate}T00:00:00Z`);
  const today = ctx.today ?? new Date();
  if (date.getTime() > today.getTime() + 24 * 60 * 60 * 1000) {
    at(
      'FUTURE_TRADING_DATE',
      `Trading date ${record.tradingDate} is in the future.`,
      'ERROR',
      'tradingDate',
    );
  }
  if (record.tradingDate < QUALITY_BOUNDS.earliestTradingDate) {
    at(
      'IMPLAUSIBLE_TRADING_DATE',
      `Trading date ${record.tradingDate} predates ${QUALITY_BOUNDS.earliestTradingDate}.`,
      'ERROR',
      'tradingDate',
    );
  }
  const dayOfWeek = date.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    at(
      'WEEKEND_TRADING_DATE',
      `Trading date ${record.tradingDate} falls on a weekend; the DSE does not trade on weekends.`,
      'WARNING',
      'tradingDate',
    );
  }

  /* -- Unknown instrument ------------------------------------------------- */
  if (ctx.knownSymbols && !ctx.knownSymbols.has(record.symbol)) {
    at(
      'UNKNOWN_SYMBOL',
      `Symbol ${record.symbol} is not in the instrument master. Add the instrument before importing its data.`,
      'ERROR',
      'symbol',
    );
  }

  /* -- High/low consistency ----------------------------------------------- */
  const { high, low, close, open } = record;
  if (high !== null && low !== null && high < low) {
    at(
      'HIGH_BELOW_LOW',
      `High (${high}) is below low (${low}).`,
      'ERROR',
      'high',
    );
  }
  if (close !== null && high !== null && close > high) {
    at(
      'CLOSE_OUTSIDE_HIGH_LOW',
      `Close (${close}) is above the session high (${high}).`,
      'ERROR',
      'close',
    );
  }
  if (close !== null && low !== null && close < low) {
    at(
      'CLOSE_OUTSIDE_HIGH_LOW',
      `Close (${close}) is below the session low (${low}).`,
      'ERROR',
      'close',
    );
  }
  if (open !== null && high !== null && open > high) {
    at(
      'OPEN_OUTSIDE_HIGH_LOW',
      `Open (${open}) is above the session high (${high}).`,
      'ERROR',
      'open',
    );
  }
  if (open !== null && low !== null && open < low) {
    at(
      'OPEN_OUTSIDE_HIGH_LOW',
      `Open (${open}) is below the session low (${low}).`,
      'ERROR',
      'open',
    );
  }

  /* -- Zero prices -------------------------------------------------------- */
  if (close !== null && close === 0) {
    at('ZERO_CLOSE', 'Close price is zero.', 'WARNING', 'close');
  }

  /* -- Trade consistency -------------------------------------------------- */
  const volume = record.volume ?? 0;
  const turnover = record.turnoverTzs ?? 0;
  const deals = record.deals ?? 0;

  if (volume > 0 && turnover === 0) {
    at(
      'VOLUME_WITHOUT_TURNOVER',
      `Volume of ${volume} was reported with zero turnover.`,
      'WARNING',
      'turnoverTzs',
    );
  }
  if (turnover > 0 && volume === 0) {
    at(
      'TURNOVER_WITHOUT_VOLUME',
      `Turnover of ${turnover} TZS was reported with zero volume.`,
      'WARNING',
      'volume',
    );
  }
  if (deals > 0 && volume === 0) {
    at(
      'DEALS_WITHOUT_VOLUME',
      `${deals} deal(s) reported with zero volume.`,
      'WARNING',
      'volume',
    );
  }

  // Implied average price from turnover/volume should land inside the day's range.
  if (volume > 0 && turnover > 0 && high !== null && low !== null && low > 0) {
    const impliedPrice = turnover / volume;
    // A 25% tolerance allows for block trades priced away from the screen.
    const upper = high * 1.25;
    const lower = low * 0.75;
    if (impliedPrice > upper || impliedPrice < lower) {
      at(
        'IMPLIED_PRICE_OUT_OF_RANGE',
        `Turnover / volume implies an average price of ${impliedPrice.toFixed(2)}, outside the session range ${low}-${high}.`,
        'WARNING',
        'turnoverTzs',
      );
    }
  }

  /* -- Price movement ----------------------------------------------------- */
  const changePct =
    record.changePct ??
    (close !== null && record.previousClose !== null && record.previousClose > 0
      ? (close / record.previousClose - 1) * 100
      : null);

  if (changePct !== null && Math.abs(changePct) > QUALITY_BOUNDS.extremeMovePct) {
    at(
      'EXTREME_PRICE_MOVEMENT',
      `Session change of ${changePct.toFixed(2)}% exceeds the ${QUALITY_BOUNDS.extremeMovePct}% review threshold. This can be genuine (a corporate action, a re-listing) but is flagged for a human to confirm.`,
      'WARNING',
      'changePct',
    );
  }

  // Cross-check a source-supplied change against the prices in the same row.
  if (
    record.changePct !== null &&
    close !== null &&
    record.previousClose !== null &&
    record.previousClose > 0
  ) {
    const derived = (close / record.previousClose - 1) * 100;
    if (Math.abs(derived - record.changePct) > 0.6) {
      at(
        'CHANGE_PCT_MISMATCH',
        `Reported change of ${record.changePct}% does not match the ${derived.toFixed(2)}% implied by close and previous close.`,
        'WARNING',
        'changePct',
      );
    }
  }

  /* -- Market capitalisation --------------------------------------------- */
  const shares = ctx.sharesOutstanding?.get(record.symbol);
  if (
    record.marketCapTzs !== null &&
    record.marketCapTzs > 0 &&
    close !== null &&
    close > 0 &&
    shares !== undefined &&
    shares > 0
  ) {
    const expected = close * shares;
    const deviation = Math.abs(record.marketCapTzs - expected) / expected * 100;
    if (deviation > QUALITY_BOUNDS.marketCapTolerancePct) {
      at(
        'MARKET_CAP_ANOMALY',
        `Reported market cap deviates ${deviation.toFixed(1)}% from close x shares outstanding. Shares outstanding may be stale, or a corporate action may be unrecorded.`,
        'WARNING',
        'marketCapTzs',
      );
    }
  }

  if (record.marketCapTzs === null) {
    at(
      'MISSING_MARKET_CAP',
      'No market capitalisation supplied; bid/offer depth cannot be normalised for this session.',
      'WARNING',
      'marketCapTzs',
    );
  }

  return issues;
}

/** Convenience: does this issue list block storage? */
export function hasBlockingIssue(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'ERROR');
}
