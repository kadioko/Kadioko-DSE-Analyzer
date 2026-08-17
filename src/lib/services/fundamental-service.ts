import 'server-only';
import { and, asc, desc, eq, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  fundamentalScores,
  fundamentals,
  instruments,
  type FundamentalsRow,
  type NewFundamentalScoreRow,
} from '@/lib/db/schema';
import { toNum, toNumeric, toScore } from '@/lib/db/num';
import {
  computeFundamentalScore,
  FUNDAMENTAL_METHODOLOGY_VERSION,
  serializeFundamentalComponents,
  type FundamentalInput,
} from '@/lib/analytics/fundamental';

/**
 * Fundamental score generation.
 *
 * Reads reported figures from `fundamentals`, derives a 0-100 business-quality
 * score, and stores it in `fundamental_scores`. Growth is computed against the
 * prior comparable period of the SAME period type, so a half-year is compared
 * with the previous half-year rather than with a full year.
 *
 * No row is written when the score cannot be computed. An issuer with one
 * reported figure gets no fundamental score, and is therefore excluded from the
 * ranking with a stated reason, rather than being scored on almost nothing.
 */

/** Reads a fundamentals row into the shape the scoring engine expects. */
function toInput(
  current: FundamentalsRow,
  prior: FundamentalsRow | undefined,
): FundamentalInput {
  const revenue = toNum(current.revenue);
  const eps = toNum(current.eps);

  /*
   * Growth is only computed when the two periods were stored at the SAME
   * reporting scale.
   *
   * Monetary figures are normalised to absolute TZS at import, but the scale is
   * inferred per row. If a period resolved to thousands while its comparative
   * resolved to absolute units, the ratio between them would be wrong by a
   * factor of a thousand and would read as 99,900% growth. Comparing across a
   * scale change is refused rather than reported.
   */
  const scalesMatch =
    prior !== undefined &&
    toNum(current.reportingScale) === toNum(prior.reportingScale);

  const priorRevenue = scalesMatch ? toNum(prior?.revenue) : null;
  const priorEps = scalesMatch ? toNum(prior?.eps) : null;

  return {
    roePct: toNum(current.roe),
    netMarginPct: toNum(current.netMargin),
    grossMarginPct: toNum(current.grossMargin),
    debtToEquity: toNum(current.debtToEquity),
    operatingCashFlow: toNum(current.operatingCashFlow),
    netIncome: toNum(current.netIncome),
    payoutRatioPct: toNum(current.payoutRatio),
    dps: toNum(current.dps),
    revenueGrowthPct:
      revenue !== null && priorRevenue !== null && priorRevenue > 0
        ? (revenue / priorRevenue - 1) * 100
        : null,
    epsGrowthPct:
      eps !== null && priorEps !== null && priorEps > 0
        ? (eps / priorEps - 1) * 100
        : null,
    nplRatioPct: toNum(current.nplRatio),
    capitalAdequacyPct: toNum(current.capitalAdequacyRatio),
    costToIncomePct: toNum(current.costToIncomeRatio),
  };
}

export interface FundamentalGenerationResult {
  periodsConsidered: number;
  scoresWritten: number;
  skipped: Array<{ symbol: string; period: string; reason: string }>;
}

/**
 * Recomputes fundamental scores for every stored financial period.
 *
 * Safe to re-run: scores are keyed by
 * (instrument, period, period type, methodology version).
 */
export async function regenerateFundamentalScores(
  options: { instrumentId?: string } = {},
): Promise<FundamentalGenerationResult> {
  const conditions = options.instrumentId
    ? [eq(fundamentals.instrumentId, options.instrumentId)]
    : [];

  const rows = await db
    .select({ f: fundamentals, symbol: instruments.symbol })
    .from(fundamentals)
    .innerJoin(instruments, eq(fundamentals.instrumentId, instruments.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      asc(fundamentals.instrumentId),
      asc(fundamentals.periodType),
      asc(fundamentals.periodEnd),
    );

  // Group by instrument + period type so growth compares like with like.
  const groups = new Map<string, Array<{ f: FundamentalsRow; symbol: string }>>();
  for (const row of rows) {
    const key = `${row.f.instrumentId}|${row.f.periodType}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const toWrite: NewFundamentalScoreRow[] = [];
  const skipped: FundamentalGenerationResult['skipped'] = [];

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      const entry = group[i];
      if (!entry) continue;
      // Ordered ascending, so the prior comparable period is the one before it.
      const prior = i > 0 ? group[i - 1]?.f : undefined;

      const result = computeFundamentalScore(toInput(entry.f, prior));

      if (result.score === null) {
        skipped.push({
          symbol: entry.symbol,
          period: entry.f.periodEnd,
          reason: `Only ${result.dataCompleteness.toFixed(0)}% of the model had data. Missing: ${result.missing.join(', ') || 'unknown'}.`,
        });
        continue;
      }

      toWrite.push({
        instrumentId: entry.f.instrumentId,
        financialPeriod: entry.f.periodEnd,
        periodType: entry.f.periodType,
        fundamentalsId: entry.f.id,
        score: toNumeric(result.score, 4) as string,
        dataCompleteness: toScore(result.dataCompleteness) as string,
        components: serializeFundamentalComponents(result.components),
        methodologyVersion: result.methodologyVersion,
        sourceStatus: entry.f.verified ? 'VERIFIED' : 'UNVERIFIED',
        // Falls back to the period end when no publication date is recorded.
        // That is the conservative choice: it can only make results available
        // LATER than reality, never earlier, so it cannot create look-ahead.
        publishedAt: entry.f.publishedAt,
        calculatedAt: new Date(),
      });
    }
  }

  if (toWrite.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < toWrite.length; i += CHUNK) {
      await db
        .insert(fundamentalScores)
        .values(toWrite.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [
            fundamentalScores.instrumentId,
            fundamentalScores.financialPeriod,
            fundamentalScores.periodType,
            fundamentalScores.methodologyVersion,
          ],
          set: {
            score: raw`excluded.score`,
            dataCompleteness: raw`excluded.data_completeness`,
            components: raw`excluded.components`,
            sourceStatus: raw`excluded.source_status`,
            publishedAt: raw`excluded.published_at`,
            fundamentalsId: raw`excluded.fundamentals_id`,
            calculatedAt: new Date(),
          },
        });
    }
  }

  return {
    periodsConsidered: rows.length,
    scoresWritten: toWrite.length,
    skipped,
  };
}

/** Whether any fundamental score exists at all, for empty-state messaging. */
export async function hasAnyFundamentalScores(): Promise<boolean> {
  const rows = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(fundamentalScores)
    .limit(1);
  return (rows[0]?.count ?? 0) > 0;
}

/** Fundamental score history for one security, newest first. */
export async function fundamentalScoreHistory(symbol: string, limit = 20) {
  const rows = await db
    .select({
      financialPeriod: fundamentalScores.financialPeriod,
      periodType: fundamentalScores.periodType,
      score: fundamentalScores.score,
      dataCompleteness: fundamentalScores.dataCompleteness,
      sourceStatus: fundamentalScores.sourceStatus,
      publishedAt: fundamentalScores.publishedAt,
      components: fundamentalScores.components,
      methodologyVersion: fundamentalScores.methodologyVersion,
    })
    .from(fundamentalScores)
    .innerJoin(instruments, eq(fundamentalScores.instrumentId, instruments.id))
    .where(eq(instruments.symbol, symbol.toUpperCase()))
    .orderBy(desc(fundamentalScores.financialPeriod))
    .limit(limit);

  return rows.map((r) => ({
    financialPeriod: r.financialPeriod,
    periodType: r.periodType,
    score: toNum(r.score),
    dataCompleteness: toNum(r.dataCompleteness),
    sourceStatus: r.sourceStatus,
    publishedAt: r.publishedAt,
    components: r.components,
    methodologyVersion: r.methodologyVersion,
  }));
}

export { FUNDAMENTAL_METHODOLOGY_VERSION };
