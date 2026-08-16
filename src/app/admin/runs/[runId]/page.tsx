import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAdminSession } from '@/lib/auth';
import {
  errorSummaryByCode,
  getRun,
  listRunErrors,
} from '@/lib/db/repositories/ingestion';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  Stat,
  TableScroll,
  Td,
  Th,
} from '@/components/ui/primitives';
import { formatNumber, NO_DATA } from '@/lib/format';

export const metadata: Metadata = { title: 'Ingestion run' };
export const dynamic = 'force-dynamic';

/**
 * Ingestion run inspector.
 *
 * Shows every issue recorded for a run, grouped by rule and listed row by row
 * with the raw content that arrived. This is the surface that makes a rejection
 * actionable rather than mysterious.
 */
export default async function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const session = await getAdminSession();
  if (!session) {
    return (
      <Notice tone="warn" title="Authorisation required">
        <Link href="/admin/data" className="text-accent-500 hover:text-accent-400">
          Sign in
        </Link>{' '}
        to inspect ingestion runs.
      </Notice>
    );
  }

  const { runId } = await params;
  const record = await getRun(runId);
  if (!record) notFound();

  const { run, source } = record;
  const [issues, byCode] = await Promise.all([
    listRunErrors(runId),
    errorSummaryByCode(runId),
  ]);

  const durationMs =
    run.completedAt !== null
      ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/admin/data"
            className="text-[13px] text-accent-500 hover:text-accent-400"
          >
            ← Data administration
          </Link>
          <h1 className="mt-2 text-lg font-semibold tracking-tight text-ink-100">
            Ingestion run
          </h1>
          <p className="num mt-1 text-[13px] text-ink-500">{run.id}</p>
        </div>
        <Badge
          tone={
            run.status === 'SUCCESS'
              ? 'up'
              : run.status === 'PARTIAL'
                ? 'warn'
                : run.status === 'FAILED'
                  ? 'down'
                  : 'muted'
          }
        >
          {run.status}
        </Badge>
      </header>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Received" value={formatNumber(run.recordsReceived)} />
        <Stat label="Inserted" value={formatNumber(run.inserted)} tone="up" />
        <Stat label="Updated" value={formatNumber(run.updated)} />
        <Stat label="Unchanged" value={formatNumber(run.unchanged)} />
        <Stat
          label="Rejected"
          value={formatNumber(run.rejected)}
          tone={run.rejected > 0 ? 'down' : 'neutral'}
        />
        <Stat
          label="Warnings"
          value={formatNumber(run.warnings)}
          tone={run.warnings > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <Card>
        <CardHeader title="Run detail" />
        <CardBody>
          <dl className="grid gap-x-8 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Source" value={source.name} />
            <Detail label="Source type" value={source.type} />
            <Detail
              label="Licensed source"
              value={source.isLicensed ? 'Yes' : 'No'}
            />
            <Detail label="File" value={run.fileName ?? NO_DATA} />
            <Detail label="Trading date" value={run.tradingDate ?? NO_DATA} />
            <Detail label="Triggered by" value={run.triggeredBy ?? NO_DATA} />
            <Detail
              label="Started"
              value={new Date(run.startedAt).toLocaleString('en-GB')}
            />
            <Detail
              label="Completed"
              value={
                run.completedAt
                  ? new Date(run.completedAt).toLocaleString('en-GB')
                  : 'Did not complete'
              }
            />
            <Detail
              label="Duration"
              value={durationMs === null ? NO_DATA : `${durationMs} ms`}
            />
            <Detail
              label="Payload checksum"
              value={run.payloadChecksum ?? NO_DATA}
              mono
            />
          </dl>

          {run.errorSummary ? (
            <div className="mt-4">
              <Notice tone="warn" title="Summary">
                {run.errorSummary}
              </Notice>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {byCode.length > 0 ? (
        <Card>
          <CardHeader
            title="Issues by rule"
            description="Grouped by the data-quality rule that fired."
          />
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Rule</Th>
                  <Th>Severity</Th>
                  <Th align="right">Count</Th>
                </tr>
              </thead>
              <tbody>
                {byCode.map((row) => (
                  <tr key={`${row.code}-${row.severity}`}>
                    <Td className="font-medium text-ink-100">{row.code}</Td>
                    <Td>
                      <Badge tone={row.severity === 'ERROR' ? 'down' : 'warn'}>
                        {row.severity}
                      </Badge>
                    </Td>
                    <Td align="right">{formatNumber(row.count)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title={`Issue detail (${issues.length})`}
          description="Errors blocked storage. Warnings were stored and reduce the row's data-confidence score."
        />
        {issues.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No issues recorded"
              description="Every row in this import passed validation cleanly."
            />
          </CardBody>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th align="right">Row</Th>
                  <Th>Symbol</Th>
                  <Th>Severity</Th>
                  <Th>Rule</Th>
                  <Th>Field</Th>
                  <Th>Message</Th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => (
                  <tr key={issue.id}>
                    <Td align="right">{issue.rowNumber ?? NO_DATA}</Td>
                    <Td className="font-medium text-ink-100">
                      {issue.symbol ?? NO_DATA}
                    </Td>
                    <Td>
                      <Badge tone={issue.severity === 'ERROR' ? 'down' : 'warn'}>
                        {issue.severity}
                      </Badge>
                    </Td>
                    <Td className="text-ink-300">{issue.code}</Td>
                    <Td className="text-ink-400">{issue.field ?? NO_DATA}</Td>
                    <Td className="max-w-xl whitespace-normal text-ink-300">
                      {issue.message}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-ink-200 ${mono ? 'num text-xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
