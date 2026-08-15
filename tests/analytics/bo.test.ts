import { describe, expect, it } from 'vitest';
import {
  analyzeOrderBook,
  boRatio,
  classifyBook,
  isUsableForAverage,
  netDepthPctMcap,
} from '@/lib/analytics/bo';
import {
  CRDB_FIXTURE,
  EXPECTED,
  NMB_FIXTURE,
} from '../fixtures/dse-2026-08-11';

describe('order book classification', () => {
  it('classifies a two-sided book as NORMAL', () => {
    expect(classifyBook(100, 50)).toBe('NORMAL');
  });

  it('classifies zero bid with offers present as NO_BID', () => {
    expect(classifyBook(0, 50)).toBe('NO_BID');
  });

  it('classifies zero offer with bids present as NO_OFFER', () => {
    expect(classifyBook(100, 0)).toBe('NO_OFFER');
  });

  it('classifies an empty book', () => {
    expect(classifyBook(0, 0)).toBe('EMPTY_BOOK');
  });

  it('treats null quantities as an empty book rather than guessing', () => {
    expect(classifyBook(null, 50)).toBe('EMPTY_BOOK');
    expect(classifyBook(100, null)).toBe('EMPTY_BOOK');
  });
});

describe('bid/offer ratio', () => {
  it('divides bid by offer for a two-sided book', () => {
    expect(boRatio(300, 100).ratio).toBeCloseTo(3, 10);
  });

  it('returns exactly 0 when there are no bids', () => {
    const result = boRatio(0, 500);
    expect(result.ratio).toBe(0);
    expect(result.state).toBe('NO_BID');
  });

  it('returns null - never a sentinel - when there are no offers', () => {
    const result = boRatio(500, 0);
    expect(result.ratio).toBeNull();
    expect(result.state).toBe('NO_OFFER');
    // Guard against the 999999-style placeholder this codebase forbids.
    expect(result.ratio).not.toBe(999999);
  });

  it('returns null for an empty book', () => {
    expect(boRatio(0, 0).ratio).toBeNull();
  });

  it('never produces a non-finite ratio for any quantity combination', () => {
    const quantities = [0, 1, 1000, 435_736];
    for (const bid of quantities) {
      for (const offer of quantities) {
        const { ratio } = boRatio(bid, offer);
        if (ratio !== null) expect(Number.isFinite(ratio)).toBe(true);
      }
    }
  });
});

describe('CRDB fixture (2026-08-11)', () => {
  const book = analyzeOrderBook({
    bidQty: CRDB_FIXTURE.outstandingBidQty,
    offerQty: CRDB_FIXTURE.outstandingOfferQty,
    close: CRDB_FIXTURE.close,
  });

  it('produces a B/O ratio of approximately 3.14', () => {
    expect(book.ratio).not.toBeNull();
    expect(book.ratio as number).toBeCloseTo(EXPECTED.crdbBoRatio, 10);
    expect(Number((book.ratio as number).toFixed(2))).toBe(3.14);
  });

  it('values the resting book in TZS at the close', () => {
    expect(book.bidValueTzs).toBe(435_736 * 2600);
    expect(book.offerValueTzs).toBe(138_838 * 2600);
  });

  it('withholds market-cap percentages when market cap is unknown', () => {
    expect(book.bidPctMcap).toBeNull();
    expect(book.offerPctMcap).toBeNull();
    expect(netDepthPctMcap(book)).toBeNull();
  });
});

describe('NMB fixture (2026-08-11)', () => {
  const book = analyzeOrderBook({
    bidQty: NMB_FIXTURE.outstandingBidQty,
    offerQty: NMB_FIXTURE.outstandingOfferQty,
    close: NMB_FIXTURE.close,
  });

  it('produces a B/O ratio below 1, reflecting more supply than demand', () => {
    expect(book.ratio as number).toBeCloseTo(EXPECTED.nmbBoRatio, 10);
    expect(book.ratio as number).toBeLessThan(1);
  });
});

describe('market-cap normalisation', () => {
  it('makes counters of different prices comparable', () => {
    // Two counters with identical bid VALUE but very different share counts.
    const cheap = analyzeOrderBook({
      bidQty: 1_000_000,
      offerQty: 500_000,
      close: 100,
      marketCapTzs: 10_000_000_000,
    });
    const dear = analyzeOrderBook({
      bidQty: 10_000,
      offerQty: 5_000,
      close: 10_000,
      marketCapTzs: 10_000_000_000,
    });

    expect(cheap.bidPctMcap).toBeCloseTo(dear.bidPctMcap as number, 10);
    expect(cheap.bidPctMcap).toBeCloseTo(1, 10);
  });

  it('withholds percentages when market cap is zero rather than dividing by it', () => {
    const book = analyzeOrderBook({
      bidQty: 100,
      offerQty: 100,
      close: 500,
      marketCapTzs: 0,
    });
    expect(book.bidPctMcap).toBeNull();
  });
});

describe('averaging eligibility', () => {
  it('accepts NORMAL and NO_BID observations', () => {
    expect(isUsableForAverage(3.14, 'NORMAL')).toBe(true);
    expect(isUsableForAverage(0, 'NO_BID')).toBe(true);
  });

  it('rejects undefined observations so they cannot pollute an average', () => {
    expect(isUsableForAverage(null, 'NO_OFFER')).toBe(false);
    expect(isUsableForAverage(null, 'EMPTY_BOOK')).toBe(false);
  });
});
