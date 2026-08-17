import 'server-only';
import { getProvider } from '@/lib/providers';
import { getSourceByName } from '@/lib/db/repositories/ingestion';
import { recordHealthCheck } from '@/lib/db/repositories/ingestion';
import { symbolIdMap, sharesOutstandingMap } from '@/lib/db/repositories/instruments';
import { upsertMarketDaily, type MarketUpsertInput } from '@/lib/db/repositories/market';
import { startRun, completeRun, failRun, recordIssues } from '@/lib/db/repositories/ingestion';
import { regenerateAnalyticsForDates } from '@/lib/analytics/pipeline';
import { generateRankingSnapshot } from '@/lib/services/ranking-service';
import { validateRecord } from './importer';
import type { ValidationIssue } from '@/lib/types/market';

/**
 * Scheduled ingestion.
 *
 * The path a trading day takes without a human:
 *
 *   provider.fetchDaily → validate → store → analytics → valuations → ranking
 *
 * Shared by the Railway worker (`npm run ingest`) and the HTTP cron endpoint,
 * so both behave identically. It applies exactly the same data-quality rules as
 * the manual importer: arriving on a schedule earns a file no leniency.
 *
 * Idempotent by construction. Re-running a date updates the same rows via the
 * (instrument_id, trading_date) constraint and records a fresh ingestion run.
 */

const SOURCE_NAMES: Record<string, string> = {
  csv: 'Manual CSV upload',
  dse_official: 'DSE official feed',
  third_party: 'Third-party market data API',
};

export interface ScheduledRunResult {
  tradingDate: string;
  provider: string;
  runId: string | null;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  recordsReceived: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  warnings: number;
  message: string | null;
}

export interface ScheduledRunOptions {
  /** Defaults to today in East Africa Time. */
  date?: Date;
  providerId?: string;
  /** Skip analytics/ranking regeneration (used by tests). */
  skipDerived?: boolean;
  triggeredBy?: string;
}

/**
 * The DSE trades in East Africa Time (UTC+3). Using the server's local date
 * would ingest the wrong session whenever the worker runs on a UTC host near
 * midnight, which is exactly when an end-of-day job is scheduled.
 */
export function eatToday(now: Date = new Date()): Date {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate()),
  );
}

export async function runScheduledIngestion(
  options: ScheduledRunOptions = {},
): Promise<ScheduledRunResult> {
  const date = options.date ?? eatToday();
  const iso = date.toISOString().slice(0, 10);
  const provider = getProvider(options.providerId);

  const base: ScheduledRunResult = {
    tradingDate: iso,
    provider: provider.id,
    runId: null,
    status: 'FAILED',
    recordsReceived: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    warnings: 0,
    message: null,
  };

  // The DSE does not trade at weekends. Skipping is reported, not silent, so a
  // scheduler log shows why nothing happened.
  const dayOfWeek = date.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      ...base,
      status: 'SKIPPED',
      message: `${iso} is a weekend; the DSE does not trade.`,
    };
  }

  const sourceName = SOURCE_NAMES[provider.id];
  const source = sourceName ? await getSourceByName(sourceName) : null;
  if (!source) {
    return {
      ...base,
      status: 'FAILED',
      message: `Ingestion source "${sourceName ?? provider.id}" is not configured. Run npm run db:seed.`,
    };
  }

  // Health is recorded whatever the outcome, so the admin console shows the
  // last known state of every source rather than only successful ones.
  const health = await provider.healthCheck();
  await recordHealthCheck(source.id, health.healthy ? 'OK' : 'UNHEALTHY');

  if (!health.healthy) {
    return {
      ...base,
      status: 'FAILED',
      message: `${provider.displayName}: ${health.message}`,
    };
  }

  const run = await startRun({
    sourceId: source.id,
    tradingDate: iso,
    triggeredBy: options.triggeredBy ?? 'scheduler',
    fileName: null,
  });

  try {
    const records = await provider.fetchDaily(date);

    if (records.length === 0) {
      await completeRun({
        runId: run.id,
        status: 'FAILED',
        recordsReceived: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        warnings: 0,
        errorSummary: `${provider.displayName} returned no records for ${iso}.`,
      });
      return {
        ...base,
        runId: run.id,
        status: 'FAILED',
        message: `No records returned for ${iso}.`,
      };
    }

    const [symbolIds, shares] = await Promise.all([
      symbolIdMap(),
      sharesOutstandingMap(),
    ]);
    const knownSymbols = new Set(symbolIds.keys());

    const inputs: MarketUpsertInput[] = [];
    const issues: Array<ValidationIssue & { rawRow?: Record<string, unknown> }> = [];
    let rejected = 0;
    let warnings = 0;

    records.forEach((record, index) => {
      const validated = validateRecord(
        record,
        index + 1,
        record as unknown as Record<string, unknown>,
        { knownSymbols, sharesOutstanding: shares },
      );

      issues.push(
        ...validated.issues.map((i) => ({
          ...i,
          rawRow: record as unknown as Record<string, unknown>,
        })),
      );

      if (!validated.accepted) {
        rejected += 1;
        return;
      }

      const instrumentId = symbolIds.get(validated.record.symbol);
      if (!instrumentId) {
        rejected += 1;
        return;
      }

      const warningNotes = validated.issues
        .filter((i) => i.severity === 'WARNING')
        .map((i) => `${i.code}: ${i.message}`);
      if (warningNotes.length > 0) warnings += 1;

      inputs.push({
        record: validated.record,
        instrumentId,
        validationStatus: warningNotes.length > 0 ? 'WARNING' : 'VALID',
        validationNotes: warningNotes,
      });
    });

    await recordIssues(run.id, issues);

    const counts = await upsertMarketDaily(inputs, {
      sourceId: source.id,
      ingestionRunId: run.id,
    });

    if (!options.skipDerived && inputs.length > 0) {
      const dates = [...new Set(inputs.map((i) => i.record.tradingDate))];
      // Analytics regenerates valuations too; the ranking consumes both.
      await regenerateAnalyticsForDates(dates);
      for (const d of dates) {
        try {
          await generateRankingSnapshot(d);
        } catch (error) {
          console.error(`[scheduler] ranking failed for ${d}`, error);
        }
      }
    }

    const status: ScheduledRunResult['status'] =
      rejected === 0 ? 'SUCCESS' : inputs.length > 0 ? 'PARTIAL' : 'FAILED';

    await completeRun({
      runId: run.id,
      status,
      recordsReceived: records.length,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
      rejected,
      warnings,
      errorSummary:
        rejected > 0 ? `${rejected} record(s) failed validation.` : null,
    });

    return {
      tradingDate: iso,
      provider: provider.id,
      runId: run.id,
      status,
      recordsReceived: records.length,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
      rejected,
      warnings,
      message: null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown ingestion failure.';
    await failRun(run.id, message);
    return { ...base, runId: run.id, status: 'FAILED', message };
  }
}

/**
 * Retries transient failures with linear backoff.
 *
 * A validation failure is NOT transient and is returned immediately: retrying a
 * malformed file just produces the same rejections three times. Only an absent
 * file or an unreachable provider is worth waiting for.
 */
export async function runScheduledIngestionWithRetry(
  options: ScheduledRunOptions & { attempts?: number; delayMs?: number } = {},
): Promise<ScheduledRunResult> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 30_000;

  let last: ScheduledRunResult | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await runScheduledIngestion(options);

    if (last.status !== 'FAILED') return last;

    const transient =
      last.message !== null &&
      /No CSV for|not readable|does not exist|returned no records|ECONN|timeout/i.test(
        last.message,
      );

    if (!transient || attempt === attempts) return last;

    console.warn(
      `[scheduler] attempt ${attempt}/${attempts} failed (${last.message}). Retrying in ${delayMs / 1000}s.`,
    );
    await new Promise((r) => setTimeout(r, delayMs * attempt));
  }

  return last as ScheduledRunResult;
}
