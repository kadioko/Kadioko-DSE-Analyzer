import 'server-only';
import { desc, eq, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  ingestionErrors,
  ingestionRuns,
  ingestionSources,
  rawMarketPayloads,
  type IngestionRun,
  type IngestionSource,
  type NewIngestionErrorRow,
} from '@/lib/db/schema';
import type { ValidationIssue } from '@/lib/types/market';

/**
 * Ingestion bookkeeping.
 *
 * Every import attempt is recorded, successful or not. That record is what
 * makes a number on screen auditable: each market observation carries the run
 * id that produced it, and each run carries its source, checksum and counts.
 */

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

export async function listSources(): Promise<IngestionSource[]> {
  return db
    .select()
    .from(ingestionSources)
    .orderBy(ingestionSources.priority, ingestionSources.name);
}

export async function getSourceByName(
  name: string,
): Promise<IngestionSource | null> {
  const rows = await db
    .select()
    .from(ingestionSources)
    .where(eq(ingestionSources.name, name))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSourceById(
  id: string,
): Promise<IngestionSource | null> {
  const rows = await db
    .select()
    .from(ingestionSources)
    .where(eq(ingestionSources.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function recordHealthCheck(
  sourceId: string,
  status: string,
): Promise<void> {
  await db
    .update(ingestionSources)
    .set({
      lastHealthCheckAt: new Date(),
      lastHealthStatus: status.slice(0, 20),
      updatedAt: new Date(),
    })
    .where(eq(ingestionSources.id, sourceId));
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export interface StartRunInput {
  sourceId: string;
  tradingDate?: string | null;
  fileName?: string | null;
  payloadChecksum?: string | null;
  triggeredBy?: string | null;
  status?: 'RUNNING' | 'PREVIEW';
}

export async function startRun(input: StartRunInput): Promise<IngestionRun> {
  const rows = await db
    .insert(ingestionRuns)
    .values({
      sourceId: input.sourceId,
      tradingDate: input.tradingDate ?? null,
      fileName: input.fileName ?? null,
      payloadChecksum: input.payloadChecksum ?? null,
      triggeredBy: input.triggeredBy ?? null,
      status: input.status ?? 'RUNNING',
    })
    .returning();

  const run = rows[0];
  if (!run) throw new Error('Failed to create ingestion run.');
  return run;
}

export interface CompleteRunInput {
  runId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'PREVIEW' | 'SKIPPED';
  recordsReceived: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  warnings: number;
  errorSummary?: string | null;
  tradingDate?: string | null;
}

export async function completeRun(input: CompleteRunInput): Promise<void> {
  await db
    .update(ingestionRuns)
    .set({
      status: input.status,
      completedAt: new Date(),
      recordsReceived: input.recordsReceived,
      inserted: input.inserted,
      updated: input.updated,
      unchanged: input.unchanged,
      rejected: input.rejected,
      warnings: input.warnings,
      errorSummary: input.errorSummary ?? null,
      ...(input.tradingDate ? { tradingDate: input.tradingDate } : {}),
    })
    .where(eq(ingestionRuns.id, input.runId));
}

export async function failRun(
  runId: string,
  message: string,
): Promise<void> {
  await db
    .update(ingestionRuns)
    .set({
      status: 'FAILED',
      completedAt: new Date(),
      errorSummary: message.slice(0, 4000),
    })
    .where(eq(ingestionRuns.id, runId));
}

export async function listRuns(limit = 50) {
  return db
    .select({
      run: ingestionRuns,
      source: ingestionSources,
    })
    .from(ingestionRuns)
    .innerJoin(ingestionSources, eq(ingestionRuns.sourceId, ingestionSources.id))
    .orderBy(desc(ingestionRuns.startedAt))
    .limit(limit);
}

export async function getRun(runId: string) {
  const rows = await db
    .select({ run: ingestionRuns, source: ingestionSources })
    .from(ingestionRuns)
    .innerJoin(ingestionSources, eq(ingestionRuns.sourceId, ingestionSources.id))
    .where(eq(ingestionRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Whether a byte-identical payload has already been imported successfully.
 * Lets the admin screen warn "you have already imported this exact file".
 */
export async function findRunByChecksum(
  checksum: string,
): Promise<IngestionRun | null> {
  const rows = await db
    .select()
    .from(ingestionRuns)
    .where(eq(ingestionRuns.payloadChecksum, checksum))
    .orderBy(desc(ingestionRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export async function recordIssues(
  runId: string,
  issues: ReadonlyArray<
    ValidationIssue & { rawRow?: Record<string, unknown>; tradingDateRaw?: string }
  >,
): Promise<void> {
  if (issues.length === 0) return;

  const rows: NewIngestionErrorRow[] = issues.map((issue) => ({
    ingestionRunId: runId,
    rowNumber: issue.rowNumber ?? null,
    symbol: issue.symbol ?? null,
    tradingDate: issue.tradingDateRaw ?? null,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    field: issue.field ?? null,
    rawRow: issue.rawRow ?? null,
  }));

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(ingestionErrors).values(rows.slice(i, i + CHUNK));
  }
}

export async function listRunErrors(runId: string, limit = 500) {
  return db
    .select()
    .from(ingestionErrors)
    .where(eq(ingestionErrors.ingestionRunId, runId))
    .orderBy(ingestionErrors.rowNumber)
    .limit(limit);
}

/** Error counts grouped by rule code, for the admin summary. */
export async function errorSummaryByCode(runId: string) {
  return db
    .select({
      code: ingestionErrors.code,
      severity: ingestionErrors.severity,
      count: raw<number>`count(*)::int`,
    })
    .from(ingestionErrors)
    .where(eq(ingestionErrors.ingestionRunId, runId))
    .groupBy(ingestionErrors.code, ingestionErrors.severity)
    .orderBy(raw`count(*) desc`);
}

/* -------------------------------------------------------------------------- */
/* Raw payloads                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Retains the payload exactly as received. Never served publicly - it exists
 * so a disputed figure can be traced back to the bytes that produced it.
 */
export async function storeRawPayload(input: {
  ingestionRunId: string;
  sourceId: string | null;
  tradingDate: string | null;
  contentType: string;
  checksum: string;
  payload: string;
}): Promise<void> {
  await db.insert(rawMarketPayloads).values({
    ingestionRunId: input.ingestionRunId,
    sourceId: input.sourceId,
    tradingDate: input.tradingDate,
    contentType: input.contentType,
    checksum: input.checksum,
    byteSize: Buffer.byteLength(input.payload, 'utf8'),
    payload: input.payload,
  });
}
