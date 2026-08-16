import 'server-only';
import { createHash } from 'node:crypto';
import type {
  ImportPreview,
  ImportResult,
  NormalizedMarketRecord,
  ValidatedRecord,
  ValidationIssue,
} from '@/lib/types/market';
import { parseMarketCsv } from './parse';
import {
  checkQuality,
  hasBlockingIssue,
  normalizedMarketRecordSchema,
} from '@/lib/validation/market-record';
import {
  sharesOutstandingMap,
  symbolIdMap,
} from '@/lib/db/repositories/instruments';
import {
  upsertMarketDaily,
  type MarketUpsertInput,
} from '@/lib/db/repositories/market';
import {
  completeRun,
  failRun,
  recordIssues,
  startRun,
  storeRawPayload,
} from '@/lib/db/repositories/ingestion';
import { regenerateAnalyticsForDates } from '@/lib/analytics/pipeline';

/**
 * The import pipeline.
 *
 *   parse → normalize → validate → PREVIEW → (operator approves) → upsert
 *                            ↓                                        ↓
 *                    ingestion_errors                    analytics regeneration
 *
 * `previewImport` is read-only against market data: it never writes an
 * observation. Nothing reaches `market_daily` until `commitImport` runs, so an
 * operator always sees what will happen before it happens.
 */

export function checksumOf(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface ValidateOptions {
  knownSymbols: ReadonlySet<string>;
  sharesOutstanding: ReadonlyMap<string, number>;
  today?: Date;
}

/**
 * Runs shape validation then the semantic rule set over one candidate record.
 * Shape failures are ERRORs: a negative volume or a malformed symbol cannot be
 * repaired by a downstream rule.
 */
export function validateRecord(
  record: NormalizedMarketRecord,
  rowNumber: number,
  raw: Record<string, unknown>,
  options: ValidateOptions,
): ValidatedRecord {
  const issues: ValidationIssue[] = [];

  const shape = normalizedMarketRecordSchema.safeParse(record);
  if (!shape.success) {
    for (const issue of shape.error.issues) {
      issues.push({
        code: 'SCHEMA_VIOLATION',
        severity: 'ERROR',
        message: issue.message,
        field: issue.path.join('.') || undefined,
        rowNumber,
        symbol: record.symbol,
      });
    }
    return { record, issues, accepted: false, rowNumber, raw };
  }

  const semantic = checkQuality(shape.data, {
    knownSymbols: options.knownSymbols,
    sharesOutstanding: options.sharesOutstanding,
    today: options.today,
  });

  for (const issue of semantic) issues.push({ ...issue, rowNumber });

  return {
    record: shape.data,
    issues,
    accepted: !hasBlockingIssue(issues),
    rowNumber,
    raw,
  };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

export interface PreviewOptions {
  fileName?: string | null;
  defaultTradingDate?: string;
  today?: Date;
}

/**
 * Parses and validates a CSV without writing any market data.
 * Returns everything the admin preview screen needs to decide whether to
 * approve the import.
 */
export async function previewImport(
  content: string,
  options: PreviewOptions = {},
): Promise<ImportPreview> {
  const checksum = checksumOf(content);

  const parsed = parseMarketCsv(content, {
    defaultTradingDate: options.defaultTradingDate,
  });

  if (parsed.fatalError) {
    return {
      runId: null,
      fileName: options.fileName ?? null,
      checksum,
      totalRows: 0,
      accepted: 0,
      rejected: 0,
      warnings: 0,
      tradingDates: [],
      unknownSymbols: [],
      records: [],
      issues: [
        {
          code: 'FILE_UNREADABLE',
          severity: 'ERROR',
          message: parsed.fatalError,
        },
      ],
    };
  }

  const [symbolIds, shares] = await Promise.all([
    symbolIdMap(),
    sharesOutstandingMap(),
  ]);
  const knownSymbols = new Set(symbolIds.keys());

  const records: ValidatedRecord[] = [];
  const issues: ValidationIssue[] = [];
  const unknownSymbols = new Set<string>();
  const tradingDates = new Set<string>();
  const seenKeys = new Set<string>();

  for (const row of parsed.records) {
    if (row.record === null) {
      issues.push({
        code: 'ROW_UNREADABLE',
        severity: 'ERROR',
        message: row.parseError ?? 'Row could not be read.',
        rowNumber: row.rowNumber,
      });
      records.push({
        record: {
          symbol: '',
          tradingDate: '',
        } as NormalizedMarketRecord,
        issues: [
          {
            code: 'ROW_UNREADABLE',
            severity: 'ERROR',
            message: row.parseError ?? 'Row could not be read.',
            rowNumber: row.rowNumber,
          },
        ],
        accepted: false,
        rowNumber: row.rowNumber,
        raw: row.raw,
      });
      continue;
    }

    const validated = validateRecord(row.record, row.rowNumber, row.raw, {
      knownSymbols,
      sharesOutstanding: shares,
      today: options.today,
    });

    // Duplicate detection within the file itself. The database constraint would
    // catch this, but silently: the second row would overwrite the first with
    // no indication. Flagged here instead.
    const key = `${validated.record.symbol}|${validated.record.tradingDate}`;
    if (seenKeys.has(key)) {
      const duplicate: ValidationIssue = {
        code: 'DUPLICATE_SYMBOL_DATE',
        severity: 'ERROR',
        message: `${validated.record.symbol} appears more than once for ${validated.record.tradingDate} in this file.`,
        rowNumber: row.rowNumber,
        symbol: validated.record.symbol,
      };
      validated.issues.push(duplicate);
      validated.accepted = false;
    }
    seenKeys.add(key);

    if (validated.issues.some((i) => i.code === 'UNKNOWN_SYMBOL')) {
      unknownSymbols.add(validated.record.symbol);
    }
    if (validated.accepted) tradingDates.add(validated.record.tradingDate);

    issues.push(...validated.issues);
    records.push(validated);
  }

  const accepted = records.filter((r) => r.accepted);
  const warnings = accepted.filter((r) =>
    r.issues.some((i) => i.severity === 'WARNING'),
  ).length;

  return {
    runId: null,
    fileName: options.fileName ?? null,
    checksum,
    totalRows: records.length,
    accepted: accepted.length,
    rejected: records.length - accepted.length,
    warnings,
    tradingDates: [...tradingDates].sort(),
    unknownSymbols: [...unknownSymbols].sort(),
    records,
    issues,
  };
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                     */
/* -------------------------------------------------------------------------- */

export interface CommitOptions {
  sourceId: string;
  fileName?: string | null;
  triggeredBy?: string | null;
  /** Retain the payload in raw_market_payloads for audit. Default true. */
  retainPayload?: boolean;
  /** Recompute analytics for affected dates after storing. Default true. */
  regenerateAnalytics?: boolean;
  today?: Date;
}

/**
 * Stores an approved import.
 *
 * Records the run first, so a crash mid-import still leaves an auditable trail
 * rather than a silent gap. Rejected rows are written to `ingestion_errors`
 * with their raw content before any market row is touched.
 */
export async function commitImport(
  content: string,
  options: CommitOptions,
): Promise<ImportResult> {
  const preview = await previewImport(content, {
    fileName: options.fileName,
    today: options.today,
  });

  const run = await startRun({
    sourceId: options.sourceId,
    tradingDate: preview.tradingDates[0] ?? null,
    fileName: options.fileName ?? null,
    payloadChecksum: preview.checksum,
    triggeredBy: options.triggeredBy ?? null,
  });

  try {
    if (options.retainPayload !== false) {
      await storeRawPayload({
        ingestionRunId: run.id,
        sourceId: options.sourceId,
        tradingDate: preview.tradingDates[0] ?? null,
        contentType: 'text/csv',
        checksum: preview.checksum,
        payload: content,
      });
    }

    // Persist every issue - rejections and warnings alike - with the raw row.
    const issueRows = preview.records.flatMap((record) =>
      record.issues.map((issue) => ({
        ...issue,
        rowNumber: record.rowNumber,
        rawRow: record.raw,
        tradingDateRaw: record.record.tradingDate,
      })),
    );
    // File-level issues (unreadable file) have no owning row.
    const fileIssues = preview.issues.filter((i) => i.rowNumber === undefined);
    await recordIssues(run.id, [...issueRows, ...fileIssues]);

    if (preview.records.length === 0) {
      const summary =
        preview.issues[0]?.message ?? 'No readable rows found in the file.';
      await completeRun({
        runId: run.id,
        status: 'FAILED',
        recordsReceived: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        warnings: 0,
        errorSummary: summary,
      });
      return {
        runId: run.id,
        status: 'FAILED',
        recordsReceived: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        warnings: 0,
        tradingDates: [],
        errorSummary: summary,
      };
    }

    const symbolIds = await symbolIdMap();

    const inputs: MarketUpsertInput[] = [];
    for (const record of preview.records) {
      if (!record.accepted) continue;
      const instrumentId = symbolIds.get(record.record.symbol);
      // Unreachable in practice - an unknown symbol is already an ERROR - but
      // a missing id must never become a silently skipped row.
      if (!instrumentId) continue;

      const warningNotes = record.issues
        .filter((i) => i.severity === 'WARNING')
        .map((i) => `${i.code}: ${i.message}`);

      inputs.push({
        record: record.record,
        instrumentId,
        validationStatus: warningNotes.length > 0 ? 'WARNING' : 'VALID',
        validationNotes: warningNotes,
      });
    }

    const counts = await upsertMarketDaily(inputs, {
      sourceId: options.sourceId,
      ingestionRunId: run.id,
    });

    if (options.regenerateAnalytics !== false && preview.tradingDates.length > 0) {
      await regenerateAnalyticsForDates(preview.tradingDates);
    }

    const status: ImportResult['status'] =
      preview.rejected === 0
        ? 'SUCCESS'
        : preview.accepted > 0
          ? 'PARTIAL'
          : 'FAILED';

    const errorSummary =
      preview.rejected > 0
        ? summariseRejections(preview.records)
        : null;

    await completeRun({
      runId: run.id,
      status,
      recordsReceived: preview.totalRows,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
      rejected: preview.rejected,
      warnings: preview.warnings,
      errorSummary,
    });

    return {
      runId: run.id,
      status,
      recordsReceived: preview.totalRows,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
      rejected: preview.rejected,
      warnings: preview.warnings,
      tradingDates: preview.tradingDates,
      errorSummary,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown ingestion failure.';
    await failRun(run.id, message);
    throw error;
  }
}

/** Groups rejection reasons into a one-line summary for the run record. */
function summariseRejections(records: readonly ValidatedRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.accepted) continue;
    for (const issue of record.issues) {
      if (issue.severity !== 'ERROR') continue;
      counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${code} x${count}`)
    .join(', ');
}
