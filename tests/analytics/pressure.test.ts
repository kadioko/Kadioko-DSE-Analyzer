import { describe, expect, it } from 'vitest';
import { analyzeOrderBook } from '@/lib/analytics/bo';
import {
  boRatioToScore,
  computePressure,
  pressureSignalFor,
} from '@/lib/analytics/pressure';
import { PRESSURE_WEIGHTS } from '@/lib/analytics/config';
import { CRDB_FIXTURE, NMB_FIXTURE } from '../fixtures/dse-2026-08-11';

describe('B/O ratio to score mapping', () => {
  it('maps a balanced book to the midpoint', () => {
    expect(boRatioToScore(1)).toBeCloseTo(50, 10);
  });

  it('is symmetric in log space: 2x and 0.5x are equidistant from 50', () => {
    const up = boRatioToScore(2) as number;
    const down = boRatioToScore(0.5) as number;
    expect(up - 50).toBeCloseTo(50 - down, 10);
  });

  it('saturates at the configured bounds', () => {
    expect(boRatioToScore(10)).toBeCloseTo(100, 10);
    expect(boRatioToScore(0.1)).toBeCloseTo(0, 10);
    expect(boRatioToScore(1000)).toBeCloseTo(100, 10);
  });

  it('scores a no-bid book at zero', () => {
    expect(boRatioToScore(0)).toBe(0);
  });

  it('returns null for an undefined ratio', () => {
    expect(boRatioToScore(null)).toBeNull();
  });
});

describe('pressure score', () => {
  const crdbBook = analyzeOrderBook({
    bidQty: CRDB_FIXTURE.outstandingBidQty,
    offerQty: CRDB_FIXTURE.outstandingOfferQty,
    close: CRDB_FIXTURE.close,
  });

  const nmbBook = analyzeOrderBook({
    bidQty: NMB_FIXTURE.outstandingBidQty,
    offerQty: NMB_FIXTURE.outstandingOfferQty,
    close: NMB_FIXTURE.close,
  });

  it('scores a demand-heavy book above the midpoint', () => {
    const result = computePressure({
      book: crdbBook,
      boMomentumPct: 127.5,
      changePct: 1.2,
      volumeRatio: 1.63,
      liquidityScore: 70,
    });
    expect(result.pressureScore).not.toBeNull();
    expect(result.pressureScore as number).toBeGreaterThan(50);
    expect(['DEMAND', 'STRONG_DEMAND']).toContain(result.signal);
  });

  it('scores a supply-heavy book below the midpoint', () => {
    const result = computePressure({
      book: nmbBook,
      boMomentumPct: -30,
      changePct: -0.8,
      volumeRatio: 0.9,
      liquidityScore: 70,
    });
    expect(result.pressureScore as number).toBeLessThan(50);
    expect(['SUPPLY', 'STRONG_SUPPLY']).toContain(result.signal);
  });

  it('exposes every component with its weight and contribution', () => {
    const result = computePressure({
      book: crdbBook,
      boMomentumPct: 50,
      changePct: 1,
      volumeRatio: 1.5,
      liquidityScore: 60,
    });

    expect(Object.keys(result.components).sort()).toEqual(
      ['boMomentum', 'depth', 'liquidity', 'orderBook', 'price', 'volume'].sort(),
    );

    for (const [name, component] of Object.entries(result.components)) {
      expect(component.explanation.length).toBeGreaterThan(20);
      expect(component.weight).toBe(
        PRESSURE_WEIGHTS[name as keyof typeof PRESSURE_WEIGHTS],
      );
      if (component.available) {
        expect(component.contribution).toBeLessThanOrEqual(component.weight + 1e-9);
        expect(component.contribution).toBeGreaterThanOrEqual(0);
      } else {
        expect(component.contribution).toBe(0);
        expect(component.raw).toBeNull();
      }
    }
  });

  it('stays within 0-100 across a wide input sweep', () => {
    const ratios = [0, 0.05, 0.5, 1, 2, 10, 100];
    const momenta = [-500, -100, 0, 100, 500, null];
    for (const r of ratios) {
      for (const m of momenta) {
        const book = analyzeOrderBook({
          bidQty: r === 0 ? 0 : Math.round(r * 1000),
          offerQty: 1000,
          close: 1000,
          marketCapTzs: 1e11,
        });
        const result = computePressure({
          book,
          boMomentumPct: m,
          changePct: 3,
          volumeRatio: 2,
          liquidityScore: 50,
        });
        if (result.pressureScore !== null) {
          expect(result.pressureScore).toBeGreaterThanOrEqual(0);
          expect(result.pressureScore).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('withholds the score entirely when coverage is too low', () => {
    const emptyBook = analyzeOrderBook({ bidQty: 0, offerQty: 0, close: null });
    const result = computePressure({
      book: emptyBook,
      boMomentumPct: null,
      changePct: null,
      volumeRatio: null,
      liquidityScore: null,
    });
    expect(result.pressureScore).toBeNull();
    expect(result.signal).toBe('INSUFFICIENT_DATA');
  });

  it('reports reduced coverage when momentum is unavailable', () => {
    const withMomentum = computePressure({
      book: crdbBook,
      boMomentumPct: 20,
      changePct: 1,
      volumeRatio: 1.2,
      liquidityScore: 50,
    });
    const withoutMomentum = computePressure({
      book: crdbBook,
      boMomentumPct: null,
      changePct: 1,
      volumeRatio: 1.2,
      liquidityScore: 50,
    });
    expect(withoutMomentum.coverage).toBeLessThan(withMomentum.coverage);
    expect(withoutMomentum.components.boMomentum?.available).toBe(false);
  });

  it('is not biased upward by a no-offer book', () => {
    // A book with bids and no offers must not read as maximum demand pressure
    // via a fabricated infinite ratio.
    const noOffer = analyzeOrderBook({
      bidQty: 500_000,
      offerQty: 0,
      close: 1000,
      marketCapTzs: 1e11,
    });
    const result = computePressure({
      book: noOffer,
      boMomentumPct: null,
      changePct: 0,
      volumeRatio: 1,
      liquidityScore: 50,
    });
    expect(result.components.orderBook?.available).toBe(false);
  });
});

describe('signal banding', () => {
  it('labels the extremes and the middle correctly', () => {
    expect(pressureSignalFor(10, 100)).toBe('STRONG_SUPPLY');
    expect(pressureSignalFor(35, 100)).toBe('SUPPLY');
    expect(pressureSignalFor(50, 100)).toBe('BALANCED');
    expect(pressureSignalFor(65, 100)).toBe('DEMAND');
    expect(pressureSignalFor(90, 100)).toBe('STRONG_DEMAND');
  });

  it('reports insufficient data for a null score or thin coverage', () => {
    expect(pressureSignalFor(null, 100)).toBe('INSUFFICIENT_DATA');
    expect(pressureSignalFor(80, 10)).toBe('INSUFFICIENT_DATA');
  });
});
