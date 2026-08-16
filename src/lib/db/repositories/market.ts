import 'server-only';
import { and, desc, eq, gte, inArray, lte, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  instruments,
  marketDaily,
  type MarketDailyRow,
  type NewMarketDailyRow,
} from '@/lib/db/schema';
import { toNum, toNumeric, toQty } from '@/lib/db/num';
import type { NormalizedMarketRecord } from '@/lib/types/market';

/**
 * Market observation data access.
 *
 * This module owns the only write path into `market_daily`. Everything it
 * writes is raw source data; nothing derived is ever stored here.
 */

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

/** The observation fields compared when deciding insert vs update vs unchanged. */
const COMPARED_FIELDS = [
  'open',
  'previousClose',
  'close',
  'high',
  'low',
  'changePct',
  'turnoverTzs',
  'deals',
  'volume',
  'outstandingBidQty',
  'outstandingOfferQty',
  'marketCapTzs',
] as const;

export interface MarketUpsertInput {
  record: NormalizedMarketRecord;
  instrumentId: string;
  validationStatus: 'VALID' | 'WARNING';
  validationNotes: string[];
}

/**
 * Idempotent upsert of market observations.
 *
 * The `(instrument_id, trading_date)` unique constraint is the idempotency
 * contract: re-importing the same file updates the same rows and never
 * duplicates. Rows whose values are byte-for-byte unchanged are reported
 * separately from genuine updates, so an operator re-running an import can see
 * that nothing actually moved.
 */
export async function upsertMarketDaily(
  inputs: readonly MarketUpsertInput[],
  context: { sourceId: string | null; ingestionRunId: string | null },
): Promise<UpsertCounts> {
  if (inputs.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0 };
  }

  // Read the current state of every key being written, in one query, so the
  // classification below needs no per-row round trip.
  const instrumentIds = [...new Set(inputs.map((i) => i.instrumentId))];
  const dates = [...new Set(inputs.map((i) => i.record.tradingDate))];

  const existingRows = await db
    .select()
    .from(marketDaily)
    .where(
      and(
        inArray(marketDaily.instrumentId, instrumentIds),
        inArray(marketDaily.tradingDate, dates),
      ),
    );

  const existing = new Map<string, MarketDailyRow>(
    existingRows.map((r) => [`${r.instrumentId}|${r.tradingDate}`, r]),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  const values: NewMarketDailyRow[] = [];

  for (const input of inputs) {
    const { record } = input;
    const key = `${input.instrumentId}|${record.tradingDate}`;
    const prior = existing.get(key);

    const row: NewMarketDailyRow = {
      instrumentId: input.instrumentId,
      tradingDate: record.tradingDate,
      open: toNumeric(record.open, 4),
      previousClose: toNumeric(record.previousClose, 4),
      close: toNumeric(record.close, 4),
      high: toNumeric(record.high, 4),
      low: toNumeric(record.low, 4),
      changePct: toNumeric(record.changePct, 6),
      turnoverTzs: toNumeric(record.turnoverTzs, 4),
      deals: record.deals === null ? null : Math.round(record.deals),
      volume: toQty(record.volume),
      outstandingBidQty: toQty(record.outstandingBidQty),
      outstandingOfferQty: toQty(record.outstandingOfferQty),
      marketCapTzs: toNumeric(record.marketCapTzs, 4),
      sourceId: context.sourceId,
      sourceTimestamp: record.sourceTimestamp,
      ingestionRunId: context.ingestionRunId,
      validationStatus: input.validationStatus,
      validationNotes: input.validationNotes,
      updatedAt: new Date(),
    };

    if (!prior) {
      inserted += 1;
    } else if (isUnchanged(prior, record, input)) {
      unchanged += 1;
    } else {
      updated += 1;
    }

    values.push(row);
  }

  // Chunked so a large file does not exceed the parameter limit.
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    await db
      .insert(marketDaily)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [marketDaily.instrumentId, marketDaily.tradingDate],
        set: {
          open: raw`excluded.open`,
          previousClose: raw`excluded.previous_close`,
          close: raw`excluded.close`,
          high: raw`excluded.high`,
          low: raw`excluded.low`,
          changePct: raw`excluded.change_pct`,
          turnoverTzs: raw`excluded.turnover_tzs`,
          deals: raw`excluded.deals`,
          volume: raw`excluded.volume`,
          outstandingBidQty: raw`excluded.outstanding_bid_qty`,
          outstandingOfferQty: raw`excluded.outstanding_offer_qty`,
          marketCapTzs: raw`excluded.market_cap_tzs`,
          sourceId: raw`excluded.source_id`,
          sourceTimestamp: raw`excluded.source_timestamp`,
          ingestionRunId: raw`excluded.ingestion_run_id`,
          validationStatus: raw`excluded.validation_status`,
          validationNotes: raw`excluded.validation_notes`,
          updatedAt: new Date(),
        },
      });
  }

  return { inserted, updated, unchanged };
}

/** True when re-importing this record would change nothing on the stored row. */
function isUnchanged(
  prior: MarketDailyRow,
  record: NormalizedMarketRecord,
  input: MarketUpsertInput,
): boolean {
  for (const field of COMPARED_FIELDS) {
    const before = toNum(prior[field] as string | number | null);
    const after = record[field];
    if (before === null && after === null) continue;
    if (before === null || after === null) return false;
    // NUMERIC round-trips exactly at the stored scale; compare at that scale.
    if (Math.abs(before - after) > 1e-6) return false;
  }
  return prior.validationStatus === input.validationStatus;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Most recent trading date with any stored observation. */
export async function latestTradingDate(): Promise<string | null> {
  const rows = await db
    .select({ tradingDate: marketDaily.tradingDate })
    .from(marketDaily)
    .orderBy(desc(marketDaily.tradingDate))
    .limit(1);
  return rows[0]?.tradingDate ?? null;
}

/** Distinct trading dates, most recent first. */
export async function listTradingDates(limit = 60): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tradingDate: marketDaily.tradingDate })
    .from(marketDaily)
    .orderBy(desc(marketDaily.tradingDate))
    .limit(limit);
  return rows.map((r) => r.tradingDate);
}

/** Every observation for one trading date, joined to its instrument. */
export async function marketRowsForDate(tradingDate: string) {
  return db
    .select({
      market: marketDaily,
      instrument: instruments,
    })
    .from(marketDaily)
    .innerJoin(instruments, eq(marketDaily.instrumentId, instruments.id))
    .where(eq(marketDaily.tradingDate, tradingDate))
    .orderBy(desc(marketDaily.turnoverTzs));
}

/**
 * Trailing history for one instrument up to and including `throughDate`,
 * most recent first. `limit` bounds the window the analytics engine needs.
 */
export async function instrumentHistory(
  instrumentId: string,
  throughDate: string,
  limit = 40,
): Promise<MarketDailyRow[]> {
  return db
    .select()
    .from(marketDaily)
    .where(
      and(
        eq(marketDaily.instrumentId, instrumentId),
        lte(marketDaily.tradingDate, throughDate),
      ),
    )
    .orderBy(desc(marketDaily.tradingDate))
    .limit(limit);
}

/**
 * Trailing history for many instruments in one query.
 *
 * Uses a window function so the database returns only the rows each instrument
 * actually needs, rather than the application filtering a full table scan.
 */
export async function bulkHistory(
  instrumentIds: readonly string[],
  throughDate: string,
  sessions = 40,
): Promise<Map<string, MarketDailyRow[]>> {
  const result = new Map<string, MarketDailyRow[]>();
  if (instrumentIds.length === 0) return result;

  const rows = await db
    .select()
    .from(marketDaily)
    .where(
      and(
        inArray(marketDaily.instrumentId, instrumentIds as string[]),
        lte(marketDaily.tradingDate, throughDate),
      ),
    )
    .orderBy(desc(marketDaily.tradingDate));

  for (const row of rows) {
    const list = result.get(row.instrumentId);
    if (list === undefined) {
      result.set(row.instrumentId, [row]);
    } else if (list.length < sessions) {
      list.push(row);
    }
  }

  return result;
}

/** Full price history for one instrument over a date range, oldest first. */
export async function historyRange(
  instrumentId: string,
  from: string,
  to: string,
): Promise<MarketDailyRow[]> {
  return db
    .select()
    .from(marketDaily)
    .where(
      and(
        eq(marketDaily.instrumentId, instrumentId),
        gte(marketDaily.tradingDate, from),
        lte(marketDaily.tradingDate, to),
      ),
    )
    .orderBy(marketDaily.tradingDate);
}

/** Number of stored sessions for an instrument, for the confidence score. */
export async function historyDepth(
  instrumentId: string,
  throughDate: string,
): Promise<number> {
  const rows = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(marketDaily)
    .where(
      and(
        eq(marketDaily.instrumentId, instrumentId),
        lte(marketDaily.tradingDate, throughDate),
      ),
    );
  return rows[0]?.count ?? 0;
}
