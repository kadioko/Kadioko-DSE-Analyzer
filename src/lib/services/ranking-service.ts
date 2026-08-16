import 'server-only';
import { and, asc, desc, eq, isNotNull, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  analyticsDaily,
  instruments,
  rankingEntries,
  rankingModels,
  rankingSnapshots,
  type ExclusionReason,
  type InterpretationCode,
  type MarketDemand,
  type NewRankingEntryRow,
  type RankingGrade,
  type RankingModel,
} from '@/lib/db/schema';
import { toNum, toNumeric, toScore } from '@/lib/db/num';
import { ANALYTICS_MODEL_VERSION } from '@/lib/analytics/config';
import {
  assignRanks,
  calculateRankMovement,
  computeRankingEntry,
  DEFAULT_RANKING_CONFIG,
  GRADE_BANDS,
  RANKING_MODEL_VERSION,
  validateWeights,
} from '@/lib/analytics/ranking';

/**
 * Ranking snapshot generation and retrieval.
 *
 * The single most important property of this module is the absence of
 * look-ahead bias: a ranking dated 2026-08-11 may only use financial results
 * that were PUBLISHED on or before 2026-08-11. Ranking a past date with figures
 * the market did not have would make every historical snapshot, and any future
 * backtest built on them, worthless.
 */

/* -------------------------------------------------------------------------- */
/* Model configuration                                                        */
/* -------------------------------------------------------------------------- */

export interface ResolvedRankingModel {
  id: string;
  code: string;
  name: string;
  description: string | null;
  version: string;
  fundamentalWeight: number;
  sentimentWeight: number;
  minimumConfidence: number | null;
  minimumLiquidity: number | null;
  gradeBands: Record<string, number>;
}

/** Loads the active model, creating the default one on first use. */
export async function getRankingModel(
  code: string = DEFAULT_RANKING_CONFIG.code,
  version: string = RANKING_MODEL_VERSION,
): Promise<ResolvedRankingModel> {
  const rows = await db
    .select()
    .from(rankingModels)
    .where(and(eq(rankingModels.code, code), eq(rankingModels.version, version)))
    .limit(1);

  let model: RankingModel | undefined = rows[0];

  if (!model) {
    const created = await db
      .insert(rankingModels)
      .values({
        code: DEFAULT_RANKING_CONFIG.code,
        name: DEFAULT_RANKING_CONFIG.name,
        description: DEFAULT_RANKING_CONFIG.description,
        fundamentalWeight: DEFAULT_RANKING_CONFIG.fundamentalWeight.toFixed(4),
        sentimentWeight: DEFAULT_RANKING_CONFIG.sentimentWeight.toFixed(4),
        minimumConfidence: null,
        minimumLiquidity: null,
        gradeBands: GRADE_BANDS as unknown as Record<string, number>,
        version: RANKING_MODEL_VERSION,
        active: true,
      })
      .onConflictDoNothing()
      .returning();

    model = created[0];

    if (!model) {
      const again = await db
        .select()
        .from(rankingModels)
        .where(
          and(
            eq(rankingModels.code, DEFAULT_RANKING_CONFIG.code),
            eq(rankingModels.version, RANKING_MODEL_VERSION),
          ),
        )
        .limit(1);
      model = again[0];
    }
  }

  if (!model) {
    throw new Error('Could not resolve a ranking model.');
  }

  const fundamentalWeight = toNum(model.fundamentalWeight) ?? 0;
  const sentimentWeight = toNum(model.sentimentWeight) ?? 0;

  // A stored model with broken weights must fail loudly rather than silently
  // producing scores on a scale nobody expects.
  validateWeights({ fundamentalWeight, sentimentWeight });

  return {
    id: model.id,
    code: model.code,
    name: model.name,
    description: model.description,
    version: model.version,
    fundamentalWeight,
    sentimentWeight,
    minimumConfidence: toNum(model.minimumConfidence),
    minimumLiquidity: toNum(model.minimumLiquidity),
    gradeBands:
      Object.keys(model.gradeBands ?? {}).length > 0
        ? model.gradeBands
        : (GRADE_BANDS as unknown as Record<string, number>),
  };
}

/* -------------------------------------------------------------------------- */
/* Snapshot generation                                                        */
/* -------------------------------------------------------------------------- */

export interface GenerateResult {
  snapshotId: string;
  tradingDate: string;
  considered: number;
  ranked: number;
  excluded: number;
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  exclusionBreakdown: Record<string, number>;
}

/**
 * Generates (or regenerates) the ranking snapshot for one trading date.
 *
 * Re-running is safe: the snapshot is keyed by (model, date, version) and its
 * entries are replaced, so a recalculation corrects rather than duplicates.
 */
export async function generateRankingSnapshot(
  tradingDate: string,
  options: { modelCode?: string; modelVersion?: string } = {},
): Promise<GenerateResult> {
  const model = await getRankingModel(options.modelCode, options.modelVersion);

  /* -- 1. Active instruments ------------------------------------------------ */
  const allInstruments = await db
    .select({
      id: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
      sector: instruments.sector,
      active: instruments.active,
    })
    .from(instruments)
    .orderBy(asc(instruments.symbol));

  /* -- 2. Sentiment, liquidity and confidence for this session -------------- */
  const analytics = await db
    .select({
      instrumentId: analyticsDaily.instrumentId,
      pressureScore: analyticsDaily.pressureScore,
      liquidityScore: analyticsDaily.liquidityScore,
      dataConfidenceScore: analyticsDaily.dataConfidenceScore,
    })
    .from(analyticsDaily)
    .where(
      and(
        eq(analyticsDaily.tradingDate, tradingDate),
        eq(analyticsDaily.modelVersion, ANALYTICS_MODEL_VERSION),
      ),
    );

  const analyticsByInstrument = new Map(
    analytics.map((a) => [a.instrumentId, a]),
  );

  /* -- 3. Fundamental score as of the ranking date -------------------------- */
  const fundamentals = await latestFundamentalScoresAsOf(tradingDate);

  /* -- 4. Previous snapshot, for rank movement ------------------------------ */
  const previousRanks = await previousRankMap(tradingDate, model.id, model.version);

  /* -- 5. Per-security computation ------------------------------------------ */
  interface Row {
    instrumentId: string;
    symbol: string;
    fundamentalScore: number | null;
    sentimentScore: number | null;
    overallScore: number | null;
    dataConfidence: number | null;
    liquidityScore: number | null;
    eligible: boolean;
    exclusionReason: ExclusionReason | null;
    grade: RankingGrade | null;
    marketDemand: MarketDemand | null;
    interpretationCode: InterpretationCode | null;
    interpretationEn: string | null;
    interpretationSw: string | null;
    fundamentalPeriod: string | null;
  }

  const rows: Row[] = allInstruments.map((instrument) => {
    const a = analyticsByInstrument.get(instrument.id);
    const f = fundamentals.get(instrument.id);

    const sentimentScore = toNum(a?.pressureScore ?? null);
    const liquidityScore = toNum(a?.liquidityScore ?? null);
    const dataConfidence = toNum(a?.dataConfidenceScore ?? null);
    const fundamentalScore = f?.score ?? null;

    const computed = computeRankingEntry({
      active: instrument.active,
      fundamentalScore,
      sentimentScore,
      liquidityScore,
      dataConfidence,
      minimumConfidence: model.minimumConfidence,
      minimumLiquidity: model.minimumLiquidity,
      fundamentalWeight: model.fundamentalWeight,
      sentimentWeight: model.sentimentWeight,
    });

    return {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      fundamentalScore,
      sentimentScore,
      overallScore: computed.overallScore,
      dataConfidence,
      liquidityScore,
      eligible: computed.eligible,
      exclusionReason: computed.exclusionReason,
      grade: computed.grade,
      marketDemand: computed.marketDemand,
      interpretationCode: computed.interpretation?.code ?? null,
      interpretationEn: computed.interpretation?.en ?? null,
      interpretationSw: computed.interpretation?.sw ?? null,
      fundamentalPeriod: f?.financialPeriod ?? null,
    };
  });

  /* -- 6. Rank ------------------------------------------------------------- */
  const ranked = assignRanks(rows);

  const exclusionBreakdown: Record<string, number> = {};
  for (const row of ranked) {
    if (!row.eligible && row.exclusionReason) {
      exclusionBreakdown[row.exclusionReason] =
        (exclusionBreakdown[row.exclusionReason] ?? 0) + 1;
    }
  }

  const rankedCount = ranked.filter((r) => r.rank !== null).length;
  const excludedCount = ranked.length - rankedCount;

  const latestPeriod = ranked
    .map((r) => r.fundamentalPeriod)
    .filter((p): p is string => p !== null)
    .sort()
    .at(-1) ?? null;

  /* -- 7. Persist ---------------------------------------------------------- */
  const snapshotRows = await db
    .insert(rankingSnapshots)
    .values({
      rankingModelId: model.id,
      tradingDate,
      fundamentalPeriod: latestPeriod,
      modelVersion: model.version,
      status: 'GENERATING',
      instrumentsConsidered: ranked.length,
      instrumentsRanked: rankedCount,
      instrumentsExcluded: excludedCount,
    })
    .onConflictDoUpdate({
      target: [
        rankingSnapshots.rankingModelId,
        rankingSnapshots.tradingDate,
        rankingSnapshots.modelVersion,
      ],
      set: {
        fundamentalPeriod: raw`excluded.fundamental_period`,
        generatedAt: new Date(),
        status: 'GENERATING',
        instrumentsConsidered: ranked.length,
        instrumentsRanked: rankedCount,
        instrumentsExcluded: excludedCount,
      },
    })
    .returning();

  const snapshot = snapshotRows[0];
  if (!snapshot) throw new Error('Failed to create ranking snapshot.');

  // Replace entries wholesale so a regeneration cannot leave stale rows behind
  // for a security that has since become ineligible.
  await db
    .delete(rankingEntries)
    .where(eq(rankingEntries.rankingSnapshotId, snapshot.id));

  const entryRows: NewRankingEntryRow[] = ranked.map((row) => {
    const movement = calculateRankMovement(
      row.rank,
      previousRanks.get(row.instrumentId),
    );

    return {
      rankingSnapshotId: snapshot.id,
      instrumentId: row.instrumentId,
      rank: row.rank,
      previousRank: movement.previousRank,
      rankChange: movement.rankChange,
      isNewEntrant: movement.isNewEntrant,
      fundamentalScore: toNumeric(row.fundamentalScore, 4),
      sentimentScore: toNumeric(row.sentimentScore, 4),
      overallScore: toNumeric(row.overallScore, 4),
      grade: row.grade,
      marketDemand: row.marketDemand,
      interpretationCode: row.interpretationCode,
      interpretationEn: row.interpretationEn,
      interpretationSw: row.interpretationSw,
      liquidityScore: toScore(row.liquidityScore),
      dataConfidence: toScore(row.dataConfidence),
      fundamentalPeriod: row.fundamentalPeriod,
      eligible: row.eligible,
      exclusionReason: row.exclusionReason,
    };
  });

  const CHUNK = 300;
  for (let i = 0; i < entryRows.length; i += CHUNK) {
    await db.insert(rankingEntries).values(entryRows.slice(i, i + CHUNK));
  }

  const status: GenerateResult['status'] =
    rankedCount === 0 ? 'FAILED' : excludedCount > 0 ? 'PARTIAL' : 'COMPLETE';

  const notes =
    rankedCount === 0
      ? 'No security could be ranked. The most common cause is that no fundamental scores exist yet: enter published financial results before rankings can be produced.'
      : excludedCount > 0
        ? `${excludedCount} of ${ranked.length} securities were excluded. See each entry's exclusion reason.`
        : null;

  await db
    .update(rankingSnapshots)
    .set({ status, notes })
    .where(eq(rankingSnapshots.id, snapshot.id));

  return {
    snapshotId: snapshot.id,
    tradingDate,
    considered: ranked.length,
    ranked: rankedCount,
    excluded: excludedCount,
    status,
    exclusionBreakdown,
  };
}

/**
 * The most recent fundamental score per instrument that was PUBLISHED on or
 * before `asOfDate`.
 *
 * This is the look-ahead guard. Two conditions matter:
 *   - the financial period must end on or before the ranking date; and
 *   - the results must have been published on or before it too.
 *
 * A December year-end published in March is not available to a January ranking,
 * and this query is what enforces that.
 */
export async function latestFundamentalScoresAsOf(
  asOfDate: string,
): Promise<
  Map<string, { score: number; financialPeriod: string; dataCompleteness: number }>
> {
  const result = await db.execute(raw`
    select distinct on (fs.instrument_id)
      fs.instrument_id,
      fs.score,
      fs.financial_period::text as financial_period,
      fs.data_completeness
    from fundamental_scores fs
    where fs.financial_period <= ${asOfDate}::date
      and (
        fs.published_at is null
        or fs.published_at::date <= ${asOfDate}::date
      )
    order by fs.instrument_id, fs.financial_period desc, fs.calculated_at desc
  `);

  const rows = result as unknown as Array<Record<string, unknown>>;
  const map = new Map<
    string,
    { score: number; financialPeriod: string; dataCompleteness: number }
  >();

  for (const row of rows) {
    const score = toNum(row.score as string | null);
    if (score === null) continue;
    map.set(String(row.instrument_id), {
      score,
      financialPeriod: String(row.financial_period),
      dataCompleteness: toNum(row.data_completeness as string | null) ?? 0,
    });
  }

  return map;
}

/** Ranks from the most recent snapshot strictly BEFORE `tradingDate`. */
async function previousRankMap(
  tradingDate: string,
  modelId: string,
  modelVersion: string,
): Promise<Map<string, number>> {
  const prior = await db
    .select({ id: rankingSnapshots.id })
    .from(rankingSnapshots)
    .where(
      and(
        eq(rankingSnapshots.rankingModelId, modelId),
        eq(rankingSnapshots.modelVersion, modelVersion),
        raw`${rankingSnapshots.tradingDate} < ${tradingDate}`,
      ),
    )
    .orderBy(desc(rankingSnapshots.tradingDate))
    .limit(1);

  const snapshotId = prior[0]?.id;
  if (!snapshotId) return new Map();

  const entries = await db
    .select({
      instrumentId: rankingEntries.instrumentId,
      rank: rankingEntries.rank,
    })
    .from(rankingEntries)
    .where(
      and(
        eq(rankingEntries.rankingSnapshotId, snapshotId),
        isNotNull(rankingEntries.rank),
      ),
    );

  return new Map(
    entries
      .filter((e) => e.rank !== null)
      .map((e) => [e.instrumentId, e.rank as number]),
  );
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export interface RankingRow {
  rank: number | null;
  previousRank: number | null;
  rankChange: number | null;
  isNewEntrant: boolean;
  instrumentId: string;
  symbol: string;
  name: string;
  sector: string | null;
  fundamentalScore: number | null;
  sentimentScore: number | null;
  overallScore: number | null;
  grade: RankingGrade | null;
  marketDemand: MarketDemand | null;
  interpretationCode: InterpretationCode | null;
  interpretationEn: string | null;
  interpretationSw: string | null;
  liquidityScore: number | null;
  dataConfidence: number | null;
  fundamentalPeriod: string | null;
  eligible: boolean;
  exclusionReason: ExclusionReason | null;
}

export interface RankingSnapshotView {
  snapshotId: string;
  tradingDate: string;
  fundamentalPeriod: string | null;
  generatedAt: Date;
  status: string;
  notes: string | null;
  model: {
    code: string;
    name: string;
    version: string;
    fundamentalWeight: number;
    sentimentWeight: number;
  };
  considered: number;
  ranked: number;
  excluded: number;
  rows: RankingRow[];
}

/** The most recent snapshot, or null when none has been generated. */
export async function latestRankingDate(): Promise<string | null> {
  const rows = await db
    .select({ tradingDate: rankingSnapshots.tradingDate })
    .from(rankingSnapshots)
    .orderBy(desc(rankingSnapshots.tradingDate))
    .limit(1);
  return rows[0]?.tradingDate ?? null;
}

/** Dates that have a stored snapshot, for the date selector. */
export async function availableRankingDates(limit = 60): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tradingDate: rankingSnapshots.tradingDate })
    .from(rankingSnapshots)
    .orderBy(desc(rankingSnapshots.tradingDate))
    .limit(limit);
  return rows.map((r) => r.tradingDate);
}

/**
 * Loads a stored snapshot.
 *
 * Historical rankings always come from the saved snapshot, never recomputed on
 * the fly, so what is shown is exactly what was published on that date.
 */
export async function getRankingSnapshot(
  tradingDate: string,
  options: { modelCode?: string; modelVersion?: string } = {},
): Promise<RankingSnapshotView | null> {
  const model = await getRankingModel(options.modelCode, options.modelVersion);

  const snapshots = await db
    .select()
    .from(rankingSnapshots)
    .where(
      and(
        eq(rankingSnapshots.rankingModelId, model.id),
        eq(rankingSnapshots.tradingDate, tradingDate),
        eq(rankingSnapshots.modelVersion, model.version),
      ),
    )
    .limit(1);

  const snapshot = snapshots[0];
  if (!snapshot) return null;

  const entries = await db
    .select({
      entry: rankingEntries,
      instrument: instruments,
    })
    .from(rankingEntries)
    .innerJoin(instruments, eq(rankingEntries.instrumentId, instruments.id))
    .where(eq(rankingEntries.rankingSnapshotId, snapshot.id))
    .orderBy(
      // Nulls last so unranked securities follow the ranked ones.
      raw`${rankingEntries.rank} asc nulls last`,
      asc(instruments.symbol),
    );

  return {
    snapshotId: snapshot.id,
    tradingDate: snapshot.tradingDate,
    fundamentalPeriod: snapshot.fundamentalPeriod,
    generatedAt: snapshot.generatedAt,
    status: snapshot.status,
    notes: snapshot.notes,
    model: {
      code: model.code,
      name: model.name,
      version: model.version,
      fundamentalWeight: model.fundamentalWeight,
      sentimentWeight: model.sentimentWeight,
    },
    considered: snapshot.instrumentsConsidered,
    ranked: snapshot.instrumentsRanked,
    excluded: snapshot.instrumentsExcluded,
    rows: entries.map(({ entry, instrument }) => ({
      rank: entry.rank,
      previousRank: entry.previousRank,
      rankChange: entry.rankChange,
      isNewEntrant: entry.isNewEntrant,
      instrumentId: entry.instrumentId,
      symbol: instrument.symbol,
      name: instrument.name,
      sector: instrument.sector,
      fundamentalScore: toNum(entry.fundamentalScore),
      sentimentScore: toNum(entry.sentimentScore),
      overallScore: toNum(entry.overallScore),
      grade: entry.grade,
      marketDemand: entry.marketDemand,
      interpretationCode: entry.interpretationCode,
      interpretationEn: entry.interpretationEn,
      interpretationSw: entry.interpretationSw,
      liquidityScore: toNum(entry.liquidityScore),
      dataConfidence: toNum(entry.dataConfidence),
      fundamentalPeriod: entry.fundamentalPeriod,
      eligible: entry.eligible,
      exclusionReason: entry.exclusionReason,
    })),
  };
}

/** One security's entry in the latest snapshot, plus its percentile. */
export async function getRankingForSymbol(
  symbol: string,
  tradingDate?: string,
): Promise<(RankingRow & {
  tradingDate: string;
  totalRanked: number;
  percentile: number | null;
}) | null> {
  const date = tradingDate ?? (await latestRankingDate());
  if (!date) return null;

  const snapshot = await getRankingSnapshot(date);
  if (!snapshot) return null;

  const row = snapshot.rows.find(
    (r) => r.symbol === symbol.toUpperCase(),
  );
  if (!row) return null;

  // Percentile among RANKED securities only; including unranked ones would
  // flatter every rank as the excluded list grows.
  const percentile =
    row.rank !== null && snapshot.ranked > 0
      ? ((snapshot.ranked - row.rank + 1) / snapshot.ranked) * 100
      : null;

  return {
    ...row,
    tradingDate: snapshot.tradingDate,
    totalRanked: snapshot.ranked,
    percentile,
  };
}

/** Rank history for one security across stored snapshots, oldest first. */
export async function getRankingHistory(
  symbol: string,
  limit = 120,
): Promise<
  Array<{
    tradingDate: string;
    rank: number | null;
    overallScore: number | null;
    fundamentalScore: number | null;
    sentimentScore: number | null;
    grade: RankingGrade | null;
  }>
> {
  const rows = await db
    .select({
      tradingDate: rankingSnapshots.tradingDate,
      rank: rankingEntries.rank,
      overallScore: rankingEntries.overallScore,
      fundamentalScore: rankingEntries.fundamentalScore,
      sentimentScore: rankingEntries.sentimentScore,
      grade: rankingEntries.grade,
    })
    .from(rankingEntries)
    .innerJoin(
      rankingSnapshots,
      eq(rankingEntries.rankingSnapshotId, rankingSnapshots.id),
    )
    .innerJoin(instruments, eq(rankingEntries.instrumentId, instruments.id))
    .where(eq(instruments.symbol, symbol.toUpperCase()))
    .orderBy(desc(rankingSnapshots.tradingDate))
    .limit(limit);

  return rows
    .map((r) => ({
      tradingDate: r.tradingDate,
      rank: r.rank,
      overallScore: toNum(r.overallScore),
      fundamentalScore: toNum(r.fundamentalScore),
      sentimentScore: toNum(r.sentimentScore),
      grade: r.grade,
    }))
    .reverse();
}

/** Top N ranked securities from the latest snapshot, for the dashboard. */
export async function getTopRanked(
  limit = 5,
): Promise<{ tradingDate: string; rows: RankingRow[] } | null> {
  const date = await latestRankingDate();
  if (!date) return null;

  const snapshot = await getRankingSnapshot(date);
  if (!snapshot) return null;

  return {
    tradingDate: snapshot.tradingDate,
    rows: snapshot.rows.filter((r) => r.rank !== null).slice(0, limit),
  };
}

/**
 * Trading dates that have analytics but no ranking snapshot yet.
 * Used by the post-ingestion hook to keep rankings in step with market data.
 */
export async function datesMissingRankings(
  modelId: string,
  modelVersion: string,
  limit = 30,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tradingDate: analyticsDaily.tradingDate })
    .from(analyticsDaily)
    .where(eq(analyticsDaily.modelVersion, ANALYTICS_MODEL_VERSION))
    .orderBy(desc(analyticsDaily.tradingDate))
    .limit(limit);

  const existing = await db
    .select({ tradingDate: rankingSnapshots.tradingDate })
    .from(rankingSnapshots)
    .where(
      and(
        eq(rankingSnapshots.rankingModelId, modelId),
        eq(rankingSnapshots.modelVersion, modelVersion),
      ),
    );

  const have = new Set(existing.map((e) => e.tradingDate));
  return rows.map((r) => r.tradingDate).filter((d) => !have.has(d));
}
