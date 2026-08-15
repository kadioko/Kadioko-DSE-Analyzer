/**
 * HISTORICAL TEST FIXTURES ONLY.
 *
 * These are observed DSE figures for the 2026-08-11 session, supplied as
 * regression fixtures for the analytics engine. They are used exclusively by
 * the test suite.
 *
 * They must never be seeded into a database, rendered in the application, or
 * used as fallback values. The application displays market data only after it
 * has been imported through the ingestion pipeline.
 */

import type { NormalizedMarketRecord } from '@/lib/types/market';

export const FIXTURE_DATE = '2026-08-11';

export const CRDB_FIXTURE: NormalizedMarketRecord = {
  symbol: 'CRDB',
  tradingDate: FIXTURE_DATE,
  companyName: 'CRDB Bank Plc',
  open: null,
  previousClose: null,
  close: 2600,
  high: null,
  low: null,
  changePct: null,
  turnoverTzs: 1_442_616_130,
  deals: null,
  volume: 553_818,
  outstandingBidQty: 435_736,
  outstandingOfferQty: 138_838,
  marketCapTzs: null,
  sourceTimestamp: null,
};

export const NMB_FIXTURE: NormalizedMarketRecord = {
  symbol: 'NMB',
  tradingDate: FIXTURE_DATE,
  companyName: 'NMB Bank Plc',
  open: null,
  previousClose: null,
  close: 17_600,
  high: null,
  low: null,
  changePct: null,
  turnoverTzs: 2_026_478_370,
  deals: null,
  volume: 115_239,
  outstandingBidQty: 11_414,
  outstandingOfferQty: 58_384,
  marketCapTzs: null,
  sourceTimestamp: null,
};

/** Market-wide totals published for the same session. */
export const MARKET_FIXTURE = {
  tradingDate: FIXTURE_DATE,
  totalTurnoverTzs: 4_102_000_500,
  totalVolume: 1_321_509,
  totalDeals: 77_700,
  countersTraded: 30,
  totalBidQty: 738_199,
  totalOfferQty: 849_973,
} as const;

/** Expected derived values, stated independently of the implementation. */
export const EXPECTED = {
  crdbBoRatio: 435_736 / 138_838, // ≈ 3.1384
  nmbBoRatio: 11_414 / 58_384, // ≈ 0.1955
  marketBoRatio: 738_199 / 849_973, // ≈ 0.8685
} as const;
