/**
 * Domain types shared between the ingestion engine, the analytics engine and
 * the API layer. No database or React imports here - this module is safe to
 * import from anywhere, including client components.
 */

import type { BoState, PressureSignal } from '@/lib/db/schema';

export type { BoState, PressureSignal };

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The canonical shape every data source must produce. Adapters translate their
 * own payloads into this; nothing downstream knows which source data came from.
 *
 * Numbers are plain JS numbers at this stage. They are converted to exact
 * NUMERIC strings at the moment of persistence.
 */
export interface NormalizedMarketRecord {
  /** DSE ticker, uppercased and trimmed, e.g. "CRDB". */
  symbol: string;
  /** ISO date, YYYY-MM-DD, in East Africa Time. */
  tradingDate: string;
  open: number | null;
  previousClose: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  changePct: number | null;
  turnoverTzs: number | null;
  deals: number | null;
  volume: number | null;
  outstandingBidQty: number | null;
  outstandingOfferQty: number | null;
  marketCapTzs: number | null;
  /** Timestamp the source itself asserts for this observation, if any. */
  sourceTimestamp: Date | null;
  /** Company name, when the source carries one - used to detect new listings. */
  companyName?: string | null;
}

export interface ProviderStatus {
  healthy: boolean;
  /** Provider identifier, e.g. "csv", "dse_official". */
  provider: string;
  message: string;
  checkedAt: Date;
  /** Present when the provider is licensed for commercial redistribution. */
  licensed: boolean;
  latencyMs?: number;
}

/**
 * The contract every market data source implements.
 * Implementations live in src/lib/providers/.
 */
export interface MarketDataProvider {
  readonly id: string;
  readonly displayName: string;
  readonly licensed: boolean;
  fetchDaily(date: Date): Promise<NormalizedMarketRecord[]>;
  healthCheck(): Promise<ProviderStatus>;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type ValidationSeverity = 'WARNING' | 'ERROR';

export interface ValidationIssue {
  /** Stable machine-readable rule id, e.g. CLOSE_OUTSIDE_HIGH_LOW. */
  code: string;
  severity: ValidationSeverity;
  message: string;
  field?: string;
  rowNumber?: number;
  symbol?: string;
}

export interface ValidatedRecord {
  record: NormalizedMarketRecord;
  issues: ValidationIssue[];
  /** ERROR-level issues mean the row is not stored at all. */
  accepted: boolean;
  rowNumber: number;
  /** The raw row exactly as parsed, retained for the admin error inspector. */
  raw: Record<string, unknown>;
}

export interface ImportPreview {
  runId: string | null;
  fileName: string | null;
  checksum: string;
  totalRows: number;
  accepted: number;
  rejected: number;
  warnings: number;
  tradingDates: string[];
  unknownSymbols: string[];
  records: ValidatedRecord[];
  issues: ValidationIssue[];
}

export interface ImportResult {
  runId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  recordsReceived: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  warnings: number;
  tradingDates: string[];
  errorSummary: string | null;
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Bid/offer result. `ratio` is null whenever the ratio is mathematically
 * undefined; `state` always says why. No sentinel numbers are ever produced.
 */
export interface BoResult {
  ratio: number | null;
  state: BoState;
  bidQty: number | null;
  offerQty: number | null;
  bidValueTzs: number | null;
  offerValueTzs: number | null;
  bidPctMcap: number | null;
  offerPctMcap: number | null;
}

export interface BoMomentumResult {
  /** Percentage change of current B/O vs the trailing average. Null if unusable. */
  momentumPct: number | null;
  avgBo: number | null;
  /** Number of usable trailing observations actually found. */
  observations: number;
  /** Minimum observations required before a value is returned. */
  requiredObservations: number;
  reason: string | null;
}

export interface VolumeProfile {
  volume: number | null;
  avgVolume5d: number | null;
  avgVolume20d: number | null;
  medianVolume20d: number | null;
  /** Current volume / 20d average. */
  volumeRatio: number | null;
  turnoverRatio: number | null;
  avgDealSize: number | null;
  liquidityPercentile: number | null;
  observations: number;
}

export interface ReturnsProfile {
  return1d: number | null;
  return5d: number | null;
  return20d: number | null;
  rangePct: number | null;
  volatility20d: number | null;
}

/** A single named contribution to a composite score. */
export interface ScoreComponent {
  /** Points this component contributed to the final 0-100 score. */
  contribution: number;
  /** Maximum points this component could have contributed. */
  weight: number;
  /** The component's own 0-100 sub-score before weighting, null if unavailable. */
  raw: number | null;
  /** Plain-language description shown on /methodology and in tooltips. */
  explanation: string;
  available: boolean;
}

export interface PressureResult {
  pressureScore: number | null;
  signal: PressureSignal;
  components: Record<string, ScoreComponent>;
  /** Sum of the weights that had data, out of 100. */
  coverage: number;
  modelVersion: string;
}

export interface OpportunityResult {
  opportunityScore: number | null;
  components: Record<string, ScoreComponent>;
  coverage: number;
  /** Human-readable list of what could not be evaluated, e.g. fundamentals. */
  missing: string[];
  modelVersion: string;
}

export interface ConfidenceResult {
  score: number;
  factors: Array<{
    code: string;
    penalty: number;
    detail: string;
  }>;
  modelVersion: string;
}

export interface LiquidityResult {
  liquidityScore: number | null;
  components: Record<string, ScoreComponent>;
  coverage: number;
  modelVersion: string;
}

/* -------------------------------------------------------------------------- */
/* API projections                                                            */
/* -------------------------------------------------------------------------- */

/** One row of the /market table. Everything the table needs, nothing more. */
export interface MarketRow {
  instrumentId: string;
  symbol: string;
  name: string;
  sector: string | null;
  tradingDate: string;
  close: number | null;
  previousClose: number | null;
  changePct: number | null;
  turnoverTzs: number | null;
  volume: number | null;
  deals: number | null;
  bidQty: number | null;
  offerQty: number | null;
  marketCapTzs: number | null;
  boRatio: number | null;
  boState: BoState;
  boMomentumPct: number | null;
  volumeRatio: number | null;
  pressureScore: number | null;
  pressureSignal: PressureSignal;
  liquidityScore: number | null;
  opportunityScore: number | null;
  dataConfidenceScore: number | null;
}

export interface MarketSummary {
  tradingDate: string;
  totalTurnoverTzs: number | null;
  totalVolume: number | null;
  totalDeals: number | null;
  countersTraded: number | null;
  countersListed: number | null;
  totalBidQty: number | null;
  totalOfferQty: number | null;
  marketBoRatio: number | null;
  marketBoState: BoState;
  totalMarketCapTzs: number | null;
  gainers: number | null;
  losers: number | null;
  unchanged: number | null;
  marketPressureScore: number | null;
  marketPressureSignal: PressureSignal;
  breadthComponents: Record<string, number | null>;
  dataConfidenceScore: number | null;
}

export type PeriodRange = '1M' | '3M' | '6M' | '1Y' | '3Y' | 'MAX';

export interface HistoryPoint {
  tradingDate: string;
  close: number | null;
  volume: number | null;
  turnoverTzs: number | null;
  bidQty: number | null;
  offerQty: number | null;
  boRatio: number | null;
  boState: BoState;
  boMomentumPct: number | null;
  pressureScore: number | null;
  volumeRatio: number | null;
  changePct: number | null;
}
