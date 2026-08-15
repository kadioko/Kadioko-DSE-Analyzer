/**
 * Versioned scoring configuration.
 *
 * Every weight, threshold and window used by a published score lives here and
 * is rendered verbatim on /methodology. Changing a number means minting a new
 * model version, so a score stored last month can always be reproduced.
 *
 * Nothing in this file is instrument-specific. There is deliberately no branch
 * anywhere in the analytics engine keyed on a ticker symbol.
 */

export const PRESSURE_MODEL_VERSION = 'pressure-v1';
export const OPPORTUNITY_MODEL_VERSION = 'opportunity-v1';
export const LIQUIDITY_MODEL_VERSION = 'liquidity-v1';
export const CONFIDENCE_MODEL_VERSION = 'confidence-v1';

/** Version stamped on rows in analytics_daily / market_daily_summary. */
export const ANALYTICS_MODEL_VERSION = 'v1';

/* -------------------------------------------------------------------------- */
/* Windows                                                                    */
/* -------------------------------------------------------------------------- */

export const WINDOWS = {
  /** Trailing sessions used for the B/O momentum baseline. */
  boMomentum: 5,
  /** Minimum trailing B/O observations before momentum is reported at all. */
  boMomentumMinObservations: 3,
  shortVolume: 5,
  longVolume: 20,
  /** Minimum sessions before a 20-day volume statistic is considered usable. */
  longVolumeMinObservations: 10,
  returnsShort: 5,
  returnsLong: 20,
  volatility: 20,
} as const;

/* -------------------------------------------------------------------------- */
/* Market pressure                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Market Pressure measures order-book and flow imbalance only.
 *
 * 0   = extreme supply-side (sell) pressure
 * 50  = balanced
 * 100 = extreme demand-side (buy) pressure
 *
 * It is NOT a measure of investment quality and must never be presented as a
 * buy signal on its own. See OPPORTUNITY_WEIGHTS for the quality score.
 */
export const PRESSURE_WEIGHTS = {
  /** Level of the bid/offer ratio right now. */
  orderBook: 30,
  /** Direction and size of the B/O change vs its own recent history. */
  boMomentum: 22,
  /** Session price move - confirms or contradicts the book. */
  price: 16,
  /** Whether volume backs the move up. */
  volume: 16,
  /** Size of resting bid vs offer relative to market cap. */
  depth: 9,
  /** How tradeable the counter is; thin books are less informative. */
  liquidity: 7,
} as const;

export const PRESSURE_THRESHOLDS = {
  /**
   * B/O ratio is mapped through log10 so that 0.5x and 2x are symmetric
   * distances from balance. +/-1.0 in log10 space (0.1x .. 10x) saturates.
   */
  boLogSaturation: 1.0,
  /** B/O momentum in percent that saturates the momentum component. */
  boMomentumSaturationPct: 150,
  /** Daily price move in percent that saturates the price component. */
  priceSaturationPct: 5,
  /** Volume ratio treated as "normal". */
  volumeNeutralRatio: 1.0,
  /** Volume ratio at which the volume component saturates. */
  volumeSaturationRatio: 3.0,
  /** Net (bid-offer) depth as % of market cap that saturates the depth term. */
  depthSaturationPctMcap: 0.5,
  /** Signal band edges on the 0-100 pressure scale. */
  signalBands: {
    strongSupply: 25,
    supply: 42,
    demand: 58,
    strongDemand: 75,
  },
  /** Below this coverage the score is withheld rather than published. */
  minCoverage: 45,
} as const;

/* -------------------------------------------------------------------------- */
/* Liquidity                                                                  */
/* -------------------------------------------------------------------------- */

export const LIQUIDITY_WEIGHTS = {
  /** Turnover in TZS - the single best liquidity proxy on the DSE. */
  turnover: 40,
  /** Number of deals - many small deals beat one block trade. */
  deals: 25,
  /** Volume relative to the counter's own history. */
  consistency: 20,
  /** Depth of resting orders on both sides. */
  bookDepth: 15,
} as const;

export const LIQUIDITY_THRESHOLDS = {
  /**
   * Log10 TZS turnover mapped to 0-100. 10^6 TZS (~1m) scores 0,
   * 10^10 TZS (~10bn) scores 100. Chosen to spread the DSE's actual range.
   */
  turnoverLogMin: 6,
  turnoverLogMax: 10,
  dealsLogMin: 0,
  dealsLogMax: 4,
  /** Fraction of the last 20 sessions with any trade at all. */
  minTradedFraction: 0,
  bookDepthLogMin: 3,
  bookDepthLogMax: 7,
} as const;

/* -------------------------------------------------------------------------- */
/* Opportunity                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Opportunity Score is a composite investment-context score. It is a different
 * thing from Market Pressure and is displayed separately everywhere.
 *
 * When a pillar has no data it is EXCLUDED from the total and reported in
 * `missing` - it is never filled in with a neutral or invented value. The
 * score is then renormalised over the pillars that did have data, and the
 * confidence score falls accordingly.
 */
export const OPPORTUNITY_WEIGHTS = {
  fundamentals: 30,
  valuation: 20,
  momentum: 15,
  liquidity: 10,
  marketPressure: 10,
  dividend: 10,
  risk: 5,
} as const;

export const OPPORTUNITY_THRESHOLDS = {
  /** Below this weight-coverage the composite is withheld entirely. */
  minCoverage: 40,
  /** P/E band mapped to the valuation sub-score (lower is better). */
  peAttractive: 6,
  peExpensive: 25,
  /** P/B band. */
  pbAttractive: 0.6,
  pbExpensive: 3.5,
  /** Dividend yield in percent mapped to the dividend sub-score. */
  dividendYieldMinPct: 0,
  dividendYieldMaxPct: 12,
  /** ROE in percent mapped to the fundamentals sub-score. */
  roeMinPct: 0,
  roeMaxPct: 30,
  netMarginMinPct: 0,
  netMarginMaxPct: 30,
  /** Debt/equity above this is treated as maximum balance-sheet risk. */
  debtToEquityMax: 3,
  /** 20-day return band mapped to the momentum sub-score. */
  return20dMinPct: -20,
  return20dMaxPct: 20,
  /** Annualised-style 20d volatility band for the risk sub-score. */
  volatilityLowPct: 1,
  volatilityHighPct: 8,
} as const;

/* -------------------------------------------------------------------------- */
/* Data confidence                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Confidence starts at 100 and is reduced by named, additive penalties.
 * Every published investment-oriented score carries one of these.
 */
export const CONFIDENCE_PENALTIES = {
  /** A required market field was absent from the source row. */
  missingCoreField: 12,
  /** No market cap, so all normalised depth metrics are unavailable. */
  missingMarketCap: 10,
  /** Fewer trailing sessions than the analytics windows need. */
  insufficientHistory: 15,
  /** Very short history - almost nothing can be computed. */
  severelyInsufficientHistory: 30,
  /** Latest observation is older than STALE_DAYS trading days. */
  staleData: 20,
  /** The counter did not trade in the latest session. */
  noTradeInSession: 10,
  /** Turnover far below the market median - metrics are noisy. */
  lowLiquidity: 12,
  /** The row was stored with WARNING-level validation issues. */
  validationWarning: 15,
  /** Data came from an unlicensed or development-only source. */
  unlicensedSource: 10,
  /** No fundamentals on file for the instrument. */
  noFundamentals: 8,
  /** Fundamentals exist but nobody has verified them against the filing. */
  unverifiedFundamentals: 5,
} as const;

export const CONFIDENCE_THRESHOLDS = {
  /** Calendar days after which the latest observation counts as stale. */
  staleDays: 5,
  /** Turnover in TZS below which a counter is treated as thinly traded. */
  lowLiquidityTurnoverTzs: 5_000_000,
  /** Sessions of history considered adequate. */
  adequateHistorySessions: 20,
  severeHistorySessions: 5,
} as const;

/* -------------------------------------------------------------------------- */
/* Unusual activity detection                                                 */
/* -------------------------------------------------------------------------- */

export const SCANNER_THRESHOLDS = {
  /** Volume ratio above which a session counts as unusual volume. */
  unusualVolumeRatio: 2.0,
  /** B/O momentum above which demand is accelerating. */
  boAccelerationPct: 50,
  /** B/O momentum below which demand is deteriorating. */
  boDeteriorationPct: -40,
  /** 5-day return that qualifies as positive/negative momentum. */
  momentumReturnPct: 5,
  /**
   * A "possible reversal" requires ALL of: price and B/O disagreeing in sign,
   * the B/O move exceeding reversalBoPct, and volume confirmation. Nothing is
   * labelled a reversal on price action alone.
   */
  reversalBoPct: 60,
  reversalVolumeRatio: 1.3,
  reversalReturnPct: 3,
} as const;

/* -------------------------------------------------------------------------- */
/* Data quality bounds (used by the ingestion validator)                      */
/* -------------------------------------------------------------------------- */

export const QUALITY_BOUNDS = {
  /** Daily move beyond this is flagged for review, not silently accepted. */
  extremeMovePct: 30,
  /** Market cap differing from close x shares outstanding by more than this. */
  marketCapTolerancePct: 5,
  /** Earliest plausible trading date for a DSE observation. */
  earliestTradingDate: '1998-01-01',
} as const;

/** Every model version published by this build, for /methodology and the API. */
export const MODEL_REGISTRY = [
  {
    version: PRESSURE_MODEL_VERSION,
    family: 'pressure',
    description:
      'Order-book and flow imbalance score, 0 (extreme supply) to 100 (extreme demand). Not an investment recommendation.',
    weights: PRESSURE_WEIGHTS as unknown as Record<string, number>,
    parameters: PRESSURE_THRESHOLDS as unknown as Record<string, unknown>,
  },
  {
    version: OPPORTUNITY_MODEL_VERSION,
    family: 'opportunity',
    description:
      'Composite investment-context score combining fundamentals, valuation, momentum, liquidity, pressure, dividend and risk. Pillars without data are excluded, never imputed.',
    weights: OPPORTUNITY_WEIGHTS as unknown as Record<string, number>,
    parameters: OPPORTUNITY_THRESHOLDS as unknown as Record<string, unknown>,
  },
  {
    version: LIQUIDITY_MODEL_VERSION,
    family: 'liquidity',
    description:
      'How readily a counter can be traded, from turnover, deal count, volume consistency and book depth.',
    weights: LIQUIDITY_WEIGHTS as unknown as Record<string, number>,
    parameters: LIQUIDITY_THRESHOLDS as unknown as Record<string, unknown>,
  },
  {
    version: CONFIDENCE_MODEL_VERSION,
    family: 'confidence',
    description:
      'Starts at 100 and subtracts named penalties for missing, stale, thin or unverified data.',
    weights: CONFIDENCE_PENALTIES as unknown as Record<string, number>,
    parameters: CONFIDENCE_THRESHOLDS as unknown as Record<string, unknown>,
  },
] as const;
