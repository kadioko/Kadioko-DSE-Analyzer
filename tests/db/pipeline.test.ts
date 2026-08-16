import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from '../setup';

/**
 * Database-backed integration tests.
 *
 * These exercise the real upsert SQL, the unique constraints and the analytics
 * pipeline against PostgreSQL. They SKIP when DATABASE_URL is absent, so a
 * clean checkout still runs green — but they are not optional coverage: run
 * them against a Railway database before trusting an import.
 *
 *   DATABASE_URL=... npm test
 *
 * They operate on a reserved test symbol and clean up after themselves. They
 * never touch a real instrument's data.
 */

const TEST_SYMBOL = '__KADIOKO_TEST__';
const D1 = '2020-01-06'; // A Monday, safely outside any real DSE import.
const D2 = '2020-01-07';

const suite = hasDatabase() ? describe : describe.skip;

suite('database integration', () => {
  let instrumentId: string;
  let sourceId: string;

  // Imported lazily: these modules are `server-only` and open a connection.
  type Mod = {
    db: typeof import('@/lib/db/client')['db'];
    schema: typeof import('@/lib/db/schema');
    market: typeof import('@/lib/db/repositories/market');
    pipeline: typeof import('@/lib/analytics/pipeline');
    analytics: typeof import('@/lib/db/repositories/analytics');
  };
  let m: Mod;

  beforeAll(async () => {
    const [client, schema, market, pipeline, analytics] = await Promise.all([
      import('@/lib/db/client'),
      import('@/lib/db/schema'),
      import('@/lib/db/repositories/market'),
      import('@/lib/analytics/pipeline'),
      import('@/lib/db/repositories/analytics'),
    ]);
    m = { db: client.db, schema, market, pipeline, analytics };

    const { eq } = await import('drizzle-orm');

    // A dedicated instrument and source, so nothing real is disturbed.
    const instrument = await m.db
      .insert(schema.instruments)
      .values({
        symbol: TEST_SYMBOL,
        name: 'Integration test instrument',
        sector: 'Test',
        sharesOutstanding: 1_000_000,
      })
      .onConflictDoUpdate({
        target: schema.instruments.symbol,
        set: { name: 'Integration test instrument' },
      })
      .returning();
    instrumentId = instrument[0]!.id;

    const source = await m.db
      .select()
      .from(schema.ingestionSources)
      .where(eq(schema.ingestionSources.type, 'CSV_MANUAL'))
      .limit(1);

    if (source[0]) {
      sourceId = source[0].id;
    } else {
      const created = await m.db
        .insert(schema.ingestionSources)
        .values({ name: 'Integration test source', type: 'CSV_MANUAL' })
        .returning();
      sourceId = created[0]!.id;
    }
  });

  afterAll(async () => {
    if (!m) return;
    const { eq } = await import('drizzle-orm');
    // Cascades remove market_daily and analytics_daily rows.
    await m.db
      .delete(m.schema.instruments)
      .where(eq(m.schema.instruments.symbol, TEST_SYMBOL));
    await m.db
      .delete(m.schema.marketDailySummary)
      .where(eq(m.schema.marketDailySummary.tradingDate, D1));
    await m.db
      .delete(m.schema.marketDailySummary)
      .where(eq(m.schema.marketDailySummary.tradingDate, D2));

    const { getSql } = await import('@/lib/db/client');
    await getSql().end({ timeout: 5 });
  });

  it('inserts a new observation', async () => {
    const counts = await m.market.upsertMarketDaily(
      [
        {
          instrumentId,
          validationStatus: 'VALID',
          validationNotes: [],
          record: {
            symbol: TEST_SYMBOL,
            tradingDate: D1,
            open: null,
            previousClose: 100,
            close: 110,
            high: 112,
            low: 99,
            changePct: 10,
            turnoverTzs: 1_100_000,
            deals: 12,
            volume: 10_000,
            outstandingBidQty: 5_000,
            outstandingOfferQty: 2_000,
            marketCapTzs: 110_000_000,
            sourceTimestamp: null,
          },
        },
      ],
      { sourceId, ingestionRunId: null },
    );

    expect(counts.inserted).toBe(1);
    expect(counts.updated).toBe(0);
  });

  it('is idempotent: re-importing identical data reports unchanged', async () => {
    const input = {
      instrumentId,
      validationStatus: 'VALID' as const,
      validationNotes: [],
      record: {
        symbol: TEST_SYMBOL,
        tradingDate: D1,
        open: null,
        previousClose: 100,
        close: 110,
        high: 112,
        low: 99,
        changePct: 10,
        turnoverTzs: 1_100_000,
        deals: 12,
        volume: 10_000,
        outstandingBidQty: 5_000,
        outstandingOfferQty: 2_000,
        marketCapTzs: 110_000_000,
        sourceTimestamp: null,
      },
    };

    const counts = await m.market.upsertMarketDaily([input], {
      sourceId,
      ingestionRunId: null,
    });

    expect(counts.inserted).toBe(0);
    expect(counts.unchanged).toBe(1);

    // And crucially: still exactly one row for this instrument/date.
    const history = await m.market.instrumentHistory(instrumentId, D1);
    expect(history).toHaveLength(1);
  });

  it('updates in place when a value changes', async () => {
    const counts = await m.market.upsertMarketDaily(
      [
        {
          instrumentId,
          validationStatus: 'VALID',
          validationNotes: [],
          record: {
            symbol: TEST_SYMBOL,
            tradingDate: D1,
            open: null,
            previousClose: 100,
            close: 115, // changed
            high: 116,
            low: 99,
            changePct: 15,
            turnoverTzs: 1_150_000,
            deals: 13,
            volume: 10_000,
            outstandingBidQty: 5_000,
            outstandingOfferQty: 2_000,
            marketCapTzs: 115_000_000,
            sourceTimestamp: null,
          },
        },
      ],
      { sourceId, ingestionRunId: null },
    );

    expect(counts.updated).toBe(1);

    const history = await m.market.instrumentHistory(instrumentId, D1);
    expect(history).toHaveLength(1);
    expect(Number(history[0]!.close)).toBe(115);
  });

  it('stores NUMERIC money exactly, without float drift', async () => {
    // A value that cannot be represented exactly in binary floating point.
    const turnover = 1_442_616_130.07;
    await m.market.upsertMarketDaily(
      [
        {
          instrumentId,
          validationStatus: 'VALID',
          validationNotes: [],
          record: {
            symbol: TEST_SYMBOL,
            tradingDate: D2,
            open: null,
            previousClose: 115,
            close: 120,
            high: 121,
            low: 114,
            changePct: 4.35,
            turnoverTzs: turnover,
            deals: 20,
            volume: 12_000,
            outstandingBidQty: 8_000,
            outstandingOfferQty: 1_000,
            marketCapTzs: 120_000_000,
            sourceTimestamp: null,
          },
        },
      ],
      { sourceId, ingestionRunId: null },
    );

    const rows = await m.market.instrumentHistory(instrumentId, D2, 1);
    // Comes back as a string, preserving the exact decimal.
    expect(rows[0]!.turnoverTzs).toBe('1442616130.0700');
  });

  it('generates analytics and a market summary for a date', async () => {
    const result = await m.pipeline.regenerateAnalyticsForDate(D2);
    expect(result.instrumentsProcessed).toBeGreaterThan(0);
    expect(result.summaryWritten).toBe(true);

    const rows = await m.analytics.analyticsForInstrument(instrumentId, D2, 5);
    expect(rows.length).toBeGreaterThan(0);

    const latest = rows[0]!;
    // 8000 bid / 1000 offer = 8.0
    expect(Number(latest.boRatio)).toBeCloseTo(8, 6);
    expect(latest.boState).toBe('NORMAL');
    // Bid value 8000 x 120 = 960,000 against a 120,000,000 market cap = 0.8%.
    expect(Number(latest.bidPctMcap)).toBeCloseTo(0.8, 4);
    expect(latest.dataConfidenceScore).not.toBeNull();

    const summary = await m.analytics.marketSummaryForDate(D2);
    expect(summary).not.toBeNull();
  });

  it('regenerating analytics is idempotent', async () => {
    await m.pipeline.regenerateAnalyticsForDate(D2);
    await m.pipeline.regenerateAnalyticsForDate(D2);

    const rows = await m.analytics.analyticsForInstrument(instrumentId, D2, 50);
    const forDate = rows.filter((r) => r.tradingDate === D2);
    // The (instrument, date, model_version) constraint must keep this at one.
    expect(forDate).toHaveLength(1);
  });

  it('rejects a duplicate instrument/date at the database level', async () => {
    const { sql } = await import('drizzle-orm');
    await expect(
      m.db.execute(
        sql`insert into market_daily (instrument_id, trading_date, close)
            values (${instrumentId}::uuid, ${D1}::date, 999)`,
      ),
    ).rejects.toThrow();
  });
});
