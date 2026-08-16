import { describe, expect, it } from 'vitest';
import {
  assignRanks,
  calculateOverallScore,
  calculateRankMovement,
  compareForRanking,
  computeRankingEntry,
  evaluateEligibility,
  getInterpretation,
  getLiquidityBand,
  getMarketDemand,
  getOverallGrade,
  RankingValidationError,
  roundScore,
  validateWeights,
  type RankableEntry,
} from '@/lib/analytics/ranking';

const W = { fundamentalWeight: 0.7, sentimentWeight: 0.3 };

/**
 * HISTORICAL TEST FIXTURES ONLY.
 * These figures exist to pin the arithmetic. They are never seeded into the
 * database and never presented as current market values.
 */
const FIXTURES = [
  { symbol: 'NICO', fundamental: 85.1, sentiment: 86, expected: 85.4 },
  { symbol: 'CRDB', fundamental: 78.4, sentiment: 80, expected: 78.9 },
  { symbol: 'DSE', fundamental: 74.8, sentiment: 86, expected: 78.2 },
  { symbol: 'NMB', fundamental: 69.6, sentiment: 86, expected: 74.5 },
  { symbol: 'TPCC', fundamental: 54.2, sentiment: 93, expected: 65.8 },
] as const;

describe('overall score', () => {
  it.each(FIXTURES)(
    '$symbol: fundamental $fundamental + sentiment $sentiment = $expected',
    ({ fundamental, sentiment, expected }) => {
      const score = calculateOverallScore({
        fundamentalScore: fundamental,
        sentimentScore: sentiment,
        ...W,
      });
      expect(roundScore(score)).toBe(expected);
    },
  );

  it('applies the 70/30 weighting exactly', () => {
    expect(
      calculateOverallScore({ fundamentalScore: 100, sentimentScore: 0, ...W }),
    ).toBeCloseTo(70, 10);
    expect(
      calculateOverallScore({ fundamentalScore: 0, sentimentScore: 100, ...W }),
    ).toBeCloseTo(30, 10);
  });

  it('stores higher precision than it displays', () => {
    const score = calculateOverallScore({
      fundamentalScore: 85.1,
      sentimentScore: 86,
      ...W,
    });
    expect(score).toBeCloseTo(85.37, 10);
    expect(roundScore(score)).toBe(85.4);
  });

  it('rejects a missing fundamental score rather than treating it as zero', () => {
    expect(() =>
      calculateOverallScore({ fundamentalScore: null, sentimentScore: 80, ...W }),
    ).toThrow(RankingValidationError);
  });

  it('rejects a missing sentiment score rather than treating it as zero', () => {
    expect(() =>
      calculateOverallScore({ fundamentalScore: 80, sentimentScore: null, ...W }),
    ).toThrow(RankingValidationError);
  });

  it('rejects component scores outside 0-100', () => {
    expect(() =>
      calculateOverallScore({ fundamentalScore: 101, sentimentScore: 50, ...W }),
    ).toThrow(/between 0 and 100/);
    expect(() =>
      calculateOverallScore({ fundamentalScore: -1, sentimentScore: 50, ...W }),
    ).toThrow(/between 0 and 100/);
  });
});

describe('weight validation', () => {
  it('accepts weights that sum to 1', () => {
    expect(() => validateWeights(W)).not.toThrow();
    expect(() =>
      validateWeights({ fundamentalWeight: 0.5, sentimentWeight: 0.5 }),
    ).not.toThrow();
  });

  it('rejects weights that do not sum to 1', () => {
    expect(() =>
      validateWeights({ fundamentalWeight: 0.7, sentimentWeight: 0.4 }),
    ).toThrow(/sum to 1/);
    expect(() =>
      validateWeights({ fundamentalWeight: 0.6, sentimentWeight: 0.3 }),
    ).toThrow(/sum to 1/);
  });

  it('rejects negative weights', () => {
    expect(() =>
      validateWeights({ fundamentalWeight: 1.2, sentimentWeight: -0.2 }),
    ).toThrow(/negative/);
  });

  it('tolerates floating-point representation error', () => {
    expect(() =>
      validateWeights({ fundamentalWeight: 0.1 + 0.6, sentimentWeight: 0.3 }),
    ).not.toThrow();
  });
});

describe('grades', () => {
  it.each([
    [100, 'BORA_SANA'],
    [80, 'BORA_SANA'],
    [79.99, 'NZURI_SANA'],
    [70, 'NZURI_SANA'],
    [69.99, 'NZURI'],
    [60, 'NZURI'],
    [59.99, 'WASTANI'],
    [50, 'WASTANI'],
    [49.99, 'DHAIFU'],
    [40, 'DHAIFU'],
    [39.99, 'DHAIFU_SANA'],
    [0, 'DHAIFU_SANA'],
  ])('scores %s as %s', (score, grade) => {
    expect(getOverallGrade(score)).toBe(grade);
  });

  it('returns null for a missing score rather than the lowest grade', () => {
    expect(getOverallGrade(null)).toBeNull();
  });

  it('grades the documented fixtures', () => {
    expect(getOverallGrade(85.4)).toBe('BORA_SANA');
    expect(getOverallGrade(78.9)).toBe('NZURI_SANA');
    expect(getOverallGrade(65.8)).toBe('NZURI');
  });
});

describe('market demand', () => {
  it.each([
    [100, 'DEMAND_KUBWA_SANA'],
    [80, 'DEMAND_KUBWA_SANA'],
    [79.99, 'DEMAND_KUBWA'],
    [50, 'DEMAND_KUBWA'],
    [49.99, 'DEMAND_WASTANI'],
    [30, 'DEMAND_WASTANI'],
    [29.99, 'DEMAND_NDOGO_SANA'],
    [0, 'DEMAND_NDOGO_SANA'],
  ])('sentiment %s is %s', (sentiment, demand) => {
    expect(getMarketDemand(sentiment)).toBe(demand);
  });

  it('is derived from sentiment, not the overall score', () => {
    // Weak business, excited market: demand is strong even though the overall
    // score is poor. Conflating the two is exactly what this prevents.
    expect(getMarketDemand(93)).toBe('DEMAND_KUBWA_SANA');
    expect(getOverallGrade(roundScore(calculateOverallScore({
      fundamentalScore: 14, sentimentScore: 93, ...W,
    })))).toBe('DHAIFU_SANA');
  });

  it('returns null when sentiment is unavailable', () => {
    expect(getMarketDemand(null)).toBeNull();
  });
});

describe('interpretation rules', () => {
  it('rule 1: strong quality and strong sentiment align', () => {
    const r = getInterpretation(75, 75);
    expect(r?.code).toBe('QUALITY_AND_TREND_ALIGNED');
    expect(r?.sw).toBe('Nunua: ubora na mwelekeo vinaungana');
    expect(r?.en).toContain('Accumulate');
  });

  it('rule 2: strong quality, unconfirmed direction', () => {
    const r = getInterpretation(75, 69.99);
    expect(r?.code).toBe('QUALITY_AWAITING_TREND');
    expect(r?.en).toContain('Watch');
  });

  it('rule 3: average quality with some demand', () => {
    const r = getInterpretation(60, 40);
    expect(r?.code).toBe('AVERAGE_QUALITY');
  });

  it('rule 4: average quality with weak demand', () => {
    const r = getInterpretation(60, 29.99);
    expect(r?.code).toBe('AVERAGE_QUALITY_WEAK_TREND');
  });

  it('rule 5: weak quality', () => {
    const r = getInterpretation(49.99, 95);
    expect(r?.code).toBe('WEAK_QUALITY');
    expect(r?.sw).toBe('Epuka: ubora dhaifu');
  });

  it('never produces accumulate language on high sentiment alone', () => {
    // This is the load-bearing guarantee of the interpretation engine.
    for (const fundamental of [0, 10, 25, 40, 49.9, 55, 65, 69.9]) {
      const r = getInterpretation(fundamental, 100);
      expect(r?.code).not.toBe('QUALITY_AND_TREND_ALIGNED');
      expect(r?.en.toLowerCase()).not.toContain('accumulate');
      expect(r?.sw.toLowerCase()).not.toContain('nunua');
    }
  });

  it('returns null when either input is missing', () => {
    expect(getInterpretation(null, 80)).toBeNull();
    expect(getInterpretation(80, null)).toBeNull();
  });

  it('supplies both Kiswahili and English for every rule', () => {
    const cases: Array<[number, number]> = [
      [80, 80], [80, 50], [60, 50], [60, 10], [30, 90],
    ];
    for (const [f, s] of cases) {
      const r = getInterpretation(f, s);
      expect(r?.sw.length).toBeGreaterThan(10);
      expect(r?.en.length).toBeGreaterThan(10);
    }
  });
});

describe('required fixture: weak fundamentals, excellent sentiment', () => {
  const score = calculateOverallScore({
    fundamentalScore: 14,
    sentimentScore: 93,
    ...W,
  });

  it('scores 37.7', () => {
    expect(roundScore(score)).toBe(37.7);
  });

  it('grades DHAIFU_SANA', () => {
    expect(getOverallGrade(score)).toBe('DHAIFU_SANA');
  });

  it('does not produce a buy-style interpretation', () => {
    const r = getInterpretation(14, 93);
    expect(r?.code).toBe('WEAK_QUALITY');
    expect(r?.en.toLowerCase()).not.toContain('accumulate');
    expect(r?.en.toLowerCase()).not.toContain('buy');
  });

  it('still reports very strong market demand, without endorsing it', () => {
    // Demand and quality are independent facts; the ranking shows both.
    expect(getMarketDemand(93)).toBe('DEMAND_KUBWA_SANA');
  });
});

describe('eligibility', () => {
  const base = {
    active: true,
    fundamentalScore: 70,
    sentimentScore: 60,
    liquidityScore: 50,
    dataConfidence: 80,
  };

  it('accepts a complete, active security', () => {
    expect(evaluateEligibility(base)).toEqual({ eligible: true, reason: null });
  });

  it('excludes a security with no fundamental score', () => {
    expect(evaluateEligibility({ ...base, fundamentalScore: null })).toEqual({
      eligible: false,
      reason: 'MISSING_FUNDAMENTALS',
    });
  });

  it('excludes a security with no sentiment score', () => {
    expect(evaluateEligibility({ ...base, sentimentScore: null })).toEqual({
      eligible: false,
      reason: 'MISSING_SENTIMENT',
    });
  });

  it('excludes stale fundamentals', () => {
    expect(
      evaluateEligibility({ ...base, fundamentalsStale: true }).reason,
    ).toBe('STALE_FUNDAMENTALS');
  });

  it('excludes an inactive instrument', () => {
    expect(evaluateEligibility({ ...base, active: false }).reason).toBe(
      'INSTRUMENT_INACTIVE',
    );
  });

  it('applies the configured minimum confidence and liquidity', () => {
    expect(
      evaluateEligibility({ ...base, dataConfidence: 30, minimumConfidence: 50 })
        .reason,
    ).toBe('BELOW_MINIMUM_CONFIDENCE');
    expect(
      evaluateEligibility({ ...base, liquidityScore: 10, minimumLiquidity: 20 })
        .reason,
    ).toBe('BELOW_MINIMUM_LIQUIDITY');
  });

  it('ignores thresholds that are not configured', () => {
    expect(
      evaluateEligibility({
        ...base,
        dataConfidence: 1,
        liquidityScore: 1,
        minimumConfidence: null,
        minimumLiquidity: null,
      }).eligible,
    ).toBe(true);
  });
});

describe('computeRankingEntry', () => {
  it('produces a null score and no grade for an ineligible security', () => {
    const result = computeRankingEntry({
      active: true,
      fundamentalScore: null,
      sentimentScore: 90,
      liquidityScore: 60,
      dataConfidence: 70,
      ...W,
    });
    expect(result.overallScore).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.interpretation).toBeNull();
    expect(result.eligible).toBe(false);
    expect(result.exclusionReason).toBe('MISSING_FUNDAMENTALS');
    // Demand is still reported: it describes the order book, which is known.
    expect(result.marketDemand).toBe('DEMAND_KUBWA_SANA');
  });

  it('produces a full result for an eligible security', () => {
    const result = computeRankingEntry({
      active: true,
      fundamentalScore: 85.1,
      sentimentScore: 86,
      liquidityScore: 60,
      dataConfidence: 70,
      ...W,
    });
    expect(roundScore(result.overallScore)).toBe(85.4);
    expect(result.grade).toBe('BORA_SANA');
    expect(result.marketDemand).toBe('DEMAND_KUBWA_SANA');
    expect(result.interpretation?.code).toBe('QUALITY_AND_TREND_ALIGNED');
    expect(result.eligible).toBe(true);
  });
});

describe('sorting and tie breaking', () => {
  const entry = (o: Partial<RankableEntry> & { symbol: string }): RankableEntry => ({
    fundamentalScore: 50,
    sentimentScore: 50,
    overallScore: 50,
    dataConfidence: 50,
    eligible: true,
    ...o,
  });

  it('sorts by overall score descending', () => {
    const sorted = [
      entry({ symbol: 'LOW', overallScore: 40 }),
      entry({ symbol: 'HIGH', overallScore: 90 }),
      entry({ symbol: 'MID', overallScore: 65 }),
    ].sort(compareForRanking);
    expect(sorted.map((e) => e.symbol)).toEqual(['HIGH', 'MID', 'LOW']);
  });

  it('breaks ties on fundamental score', () => {
    const sorted = [
      entry({ symbol: 'B', overallScore: 70, fundamentalScore: 60 }),
      entry({ symbol: 'A', overallScore: 70, fundamentalScore: 80 }),
    ].sort(compareForRanking);
    expect(sorted[0]?.symbol).toBe('A');
  });

  it('breaks a fundamental tie on sentiment', () => {
    const sorted = [
      entry({ symbol: 'B', overallScore: 70, fundamentalScore: 70, sentimentScore: 40 }),
      entry({ symbol: 'A', overallScore: 70, fundamentalScore: 70, sentimentScore: 90 }),
    ].sort(compareForRanking);
    expect(sorted[0]?.symbol).toBe('A');
  });

  it('breaks a sentiment tie on data confidence', () => {
    const sorted = [
      entry({ symbol: 'B', dataConfidence: 40 }),
      entry({ symbol: 'A', dataConfidence: 95 }),
    ].sort(compareForRanking);
    expect(sorted[0]?.symbol).toBe('A');
  });

  it('falls back to symbol so the order is fully deterministic', () => {
    const sorted = [
      entry({ symbol: 'ZZZ' }),
      entry({ symbol: 'AAA' }),
    ].sort(compareForRanking);
    expect(sorted.map((e) => e.symbol)).toEqual(['AAA', 'ZZZ']);
  });

  it('produces an identical order on repeated runs', () => {
    const entries = [
      entry({ symbol: 'A' }), entry({ symbol: 'B' }),
      entry({ symbol: 'C' }), entry({ symbol: 'D' }),
    ];
    const first = [...entries].sort(compareForRanking).map((e) => e.symbol);
    const second = [...entries].reverse().sort(compareForRanking).map((e) => e.symbol);
    expect(second).toEqual(first);
  });
});

describe('rank assignment', () => {
  const entry = (symbol: string, overall: number | null, eligible = true): RankableEntry => ({
    symbol,
    fundamentalScore: overall,
    sentimentScore: 50,
    overallScore: overall,
    dataConfidence: 50,
    eligible,
  });

  it('numbers eligible entries from 1 in score order', () => {
    const ranked = assignRanks([
      entry('C', 60), entry('A', 90), entry('B', 75),
    ]);
    expect(ranked.map((e) => [e.symbol, e.rank])).toEqual([
      ['A', 1], ['B', 2], ['C', 3],
    ]);
  });

  it('gives ineligible entries a null rank and lists them last', () => {
    const ranked = assignRanks([
      entry('GOOD', 80),
      entry('NODATA', null, false),
      entry('OTHER', 70),
    ]);
    expect(ranked.map((e) => e.symbol)).toEqual(['GOOD', 'OTHER', 'NODATA']);
    expect(ranked[2]?.rank).toBeNull();
    // Crucially, an unranked security does not occupy rank 3 and push others down.
    expect(ranked[1]?.rank).toBe(2);
  });
});

describe('rank movement', () => {
  it('reports improvement as positive', () => {
    // The documented convention: current 2, previous 5 -> +3.
    expect(calculateRankMovement(2, 5)).toEqual({
      previousRank: 5,
      rankChange: 3,
      isNewEntrant: false,
    });
  });

  it('reports decline as negative', () => {
    expect(calculateRankMovement(8, 3).rankChange).toBe(-5);
  });

  it('reports no change as zero', () => {
    expect(calculateRankMovement(4, 4).rankChange).toBe(0);
  });

  it('marks a security with no previous rank as a new entrant', () => {
    const movement = calculateRankMovement(1, null);
    expect(movement.isNewEntrant).toBe(true);
    expect(movement.rankChange).toBeNull();
    expect(movement.previousRank).toBeNull();
  });

  it('does not compute movement for an unranked security', () => {
    expect(calculateRankMovement(null, 5)).toEqual({
      previousRank: 5,
      rankChange: null,
      isNewEntrant: false,
    });
  });
});

describe('liquidity bands', () => {
  it.each([
    [90, 'HIGH'],
    [70, 'HIGH'],
    [69.9, 'MEDIUM'],
    [50, 'MEDIUM'],
    [49.9, 'LOW'],
    [30, 'LOW'],
    [29.9, 'VERY_LOW'],
    [0, 'VERY_LOW'],
  ])('liquidity %s is %s', (score, band) => {
    expect(getLiquidityBand(score)).toBe(band);
  });

  it('reports unknown rather than assuming the worst', () => {
    expect(getLiquidityBand(null)).toBe('UNKNOWN');
  });
});
