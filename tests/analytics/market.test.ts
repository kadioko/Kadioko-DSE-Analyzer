import { describe, expect, it } from 'vitest';
import {
  buildMarketSummary,
  computeBreadth,
  computeMarketPressure,
  computeMarketTotals,
  marketBoRatio,
  type MarketConstituent,
} from '@/lib/analytics/market';
import { EXPECTED, MARKET_FIXTURE } from '../fixtures/dse-2026-08-11';

const constituent = (
  overrides: Partial<MarketConstituent> & { symbol: string },
): MarketConstituent => ({
  instrumentId: `id-${overrides.symbol}`,
  close: null,
  previousClose: null,
  changePct: null,
  turnoverTzs: null,
  volume: null,
  deals: null,
  bidQty: null,
  offerQty: null,
  marketCapTzs: null,
  pressureScore: null,
  ...overrides,
});

describe('market B/O ratio', () => {
  it('reproduces the 2026-08-11 market ratio of approximately 0.87', () => {
    // Split the published market totals across two synthetic counters; the
    // aggregate must be independent of how the totals are distributed.
    const constituents = [
      constituent({ symbol: 'A', bidQty: 400_000, offerQty: 400_000 }),
      constituent({
        symbol: 'B',
        bidQty: MARKET_FIXTURE.totalBidQty - 400_000,
        offerQty: MARKET_FIXTURE.totalOfferQty - 400_000,
      }),
    ];

    const result = marketBoRatio(constituents);
    expect(result.totalBid).toBe(MARKET_FIXTURE.totalBidQty);
    expect(result.totalOffer).toBe(MARKET_FIXTURE.totalOfferQty);
    expect(result.ratio as number).toBeCloseTo(EXPECTED.marketBoRatio, 10);
    expect(Number((result.ratio as number).toFixed(2))).toBe(0.87);
  });

  it('is quantity-weighted, not an average of per-counter ratios', () => {
    // One huge balanced counter and one tiny extremely lopsided one.
    const constituents = [
      constituent({ symbol: 'BIG', bidQty: 1_000_000, offerQty: 1_000_000 }),
      constituent({ symbol: 'TINY', bidQty: 100, offerQty: 1 }),
    ];
    const result = marketBoRatio(constituents);
    // The mean of the individual ratios would be ~50. The correct answer is ~1.
    expect(result.ratio as number).toBeCloseTo(1.0001, 3);
  });

  it('reports NO_OFFER rather than a sentinel when the market has no offers', () => {
    const result = marketBoRatio([
      constituent({ symbol: 'A', bidQty: 500, offerQty: 0 }),
    ]);
    expect(result.ratio).toBeNull();
    expect(result.state).toBe('NO_OFFER');
  });
});

describe('market breadth', () => {
  it('counts gainers, losers and unchanged among traded counters only', () => {
    const constituents = [
      constituent({ symbol: 'UP', volume: 100, changePct: 2.5 }),
      constituent({ symbol: 'UP2', volume: 100, changePct: 0.1 }),
      constituent({ symbol: 'DOWN', volume: 100, changePct: -1.5 }),
      constituent({ symbol: 'FLAT', volume: 100, changePct: 0 }),
      // Did not trade: excluded from breadth entirely.
      constituent({ symbol: 'QUIET', volume: 0, changePct: null }),
    ];

    const breadth = computeBreadth(constituents);
    expect(breadth.gainers).toBe(2);
    expect(breadth.losers).toBe(1);
    expect(breadth.unchanged).toBe(1);
    expect(breadth.countersTraded).toBe(4);
    expect(breadth.advanceDeclineRatio).toBeCloseTo((2 - 1) / 3, 10);
  });

  it('does not count an untraded counter as unchanged', () => {
    const breadth = computeBreadth([
      constituent({ symbol: 'QUIET', volume: 0, deals: 0, changePct: null }),
    ]);
    expect(breadth.unchanged).toBe(0);
    expect(breadth.countersTraded).toBe(0);
    expect(breadth.advanceDeclineRatio).toBeNull();
  });

  it('derives the change from prices when the source omits it', () => {
    const breadth = computeBreadth([
      constituent({
        symbol: 'A',
        volume: 100,
        close: 110,
        previousClose: 100,
        changePct: null,
      }),
    ]);
    expect(breadth.gainers).toBe(1);
  });
});

describe('market totals', () => {
  it('sums turnover, volume, deals and market cap treating nulls as absent', () => {
    const totals = computeMarketTotals([
      constituent({ symbol: 'A', turnoverTzs: 1000, volume: 10, deals: 2 }),
      constituent({ symbol: 'B', turnoverTzs: null, volume: 5, deals: null }),
    ]);
    expect(totals.totalTurnoverTzs).toBe(1000);
    expect(totals.totalVolume).toBe(15);
    expect(totals.totalDeals).toBe(2);
  });
});

describe('market pressure', () => {
  it('weights per-counter pressure by turnover', () => {
    const constituents = [
      constituent({
        symbol: 'BIG',
        volume: 1,
        turnoverTzs: 1_000_000_000,
        pressureScore: 90,
        bidQty: 100,
        offerQty: 100,
      }),
      constituent({
        symbol: 'SMALL',
        volume: 1,
        turnoverTzs: 1_000,
        pressureScore: 10,
        bidQty: 100,
        offerQty: 100,
      }),
    ];
    const breadth = computeBreadth(constituents);
    const book = marketBoRatio(constituents);
    const result = computeMarketPressure(constituents, breadth, book);
    // Turnover-weighted average is dominated by BIG, so ~90 not the ~50 mean.
    expect(result.components.turnoverWeightedPressure as number).toBeGreaterThan(85);
  });

  it('withholds the score when nothing can be measured', () => {
    const constituents = [constituent({ symbol: 'A' })];
    const breadth = computeBreadth(constituents);
    const book = marketBoRatio(constituents);
    const result = computeMarketPressure(constituents, breadth, book);
    expect(result.score).toBeNull();
    expect(result.signal).toBe('INSUFFICIENT_DATA');
  });
});

describe('market summary assembly', () => {
  it('produces totals that agree with the counters beneath them', () => {
    const constituents = [
      constituent({
        symbol: 'A',
        volume: 553_818,
        turnoverTzs: 1_442_616_130,
        bidQty: 435_736,
        offerQty: 138_838,
        changePct: 1.2,
        close: 2600,
      }),
      constituent({
        symbol: 'B',
        volume: 115_239,
        turnoverTzs: 2_026_478_370,
        bidQty: 11_414,
        offerQty: 58_384,
        changePct: -0.5,
        close: 17_600,
      }),
    ];

    const summary = buildMarketSummary('2026-08-11', constituents, 30, 82);

    expect(summary.totalVolume).toBe(553_818 + 115_239);
    expect(summary.totalTurnoverTzs).toBe(1_442_616_130 + 2_026_478_370);
    expect(summary.totalBidQty).toBe(435_736 + 11_414);
    expect(summary.countersTraded).toBe(2);
    expect(summary.gainers).toBe(1);
    expect(summary.losers).toBe(1);
    expect(summary.countersListed).toBe(30);
    expect(summary.dataConfidenceScore).toBe(82);
  });
});
