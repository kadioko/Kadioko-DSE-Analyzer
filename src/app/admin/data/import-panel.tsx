'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Notice,
  Stat,
  TableScroll,
  Td,
  Th,
} from '@/components/ui/primitives';
import { formatDate, formatNumber, NO_DATA } from '@/lib/format';
import type { ValidatedRecord, ValidationIssue } from '@/lib/types/market';

/**
 * Upload → preview → approve.
 *
 * The preview step is not cosmetic: the server parses and validates the file
 * without writing a single market row, so an operator sees exactly what will be
 * stored and exactly what will be rejected before anything happens.
 */

interface PreviewResponse {
  fileName: string | null;
  checksum: string;
  totalRows: number;
  accepted: number;
  rejected: number;
  warnings: number;
  tradingDates: string[];
  unknownSymbols: string[];
  issues: ValidationIssue[];
  sample: ValidatedRecord[];
  rejectedRows: ValidatedRecord[];
  previouslyImported: { runId: string; startedAt: string; status: string } | null;
}

interface CommitResponse {
  runId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  recordsReceived: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  warnings: number;
  tradingDates: string[];
  errorSummary: string | null;
}

export function ImportPanel() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [tradingDate, setTradingDate] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [result, setResult] = useState<CommitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);

  async function send(mode: 'preview' | 'commit') {
    if (!file) return;
    setBusy(mode);
    setError(null);

    const form = new FormData();
    form.set('file', file);
    form.set('mode', mode);
    if (tradingDate) form.set('tradingDate', tradingDate);

    try {
      const response = await fetch('/api/admin/import', {
        method: 'POST',
        body: form,
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload?.error?.message ?? 'The import request failed.');
        return;
      }

      if (mode === 'preview') {
        setPreview(payload.data as PreviewResponse);
        setResult(null);
      } else {
        setResult(payload.data as CommitResponse);
        setPreview(null);
        router.refresh();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    setPreview(null);
    setResult(null);
    setError(null);
    setFile(null);
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Import DSE end-of-day data"
          description="The file is parsed and validated first. Nothing is stored until you approve the preview."
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label
                htmlFor="csv-file"
                className="block text-[13px] font-medium text-ink-300"
              >
                CSV file
              </label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setPreview(null);
                  setResult(null);
                }}
                className="mt-1.5 w-full rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-200 file:mr-3 file:rounded file:border-0 file:bg-navy-700 file:px-3 file:py-1 file:text-sm file:text-ink-100"
              />
            </div>

            <div>
              <label
                htmlFor="fallback-date"
                className="block text-[13px] font-medium text-ink-300"
              >
                Trading date{' '}
                <span className="font-normal text-ink-500">(if not in file)</span>
              </label>
              <input
                id="fallback-date"
                type="date"
                value={tradingDate}
                onChange={(e) => setTradingDate(e.target.value)}
                className="mt-1.5 rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-100"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!file || busy !== null}
              onClick={() => send('preview')}
              className="rounded bg-navy-700 px-4 py-2 text-sm font-medium text-ink-100 transition-colors hover:bg-navy-600 disabled:opacity-50"
            >
              {busy === 'preview' ? 'Validating…' : 'Validate and preview'}
            </button>

            {preview && preview.accepted > 0 ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => send('commit')}
                className="rounded bg-up-600 px-4 py-2 text-sm font-medium text-ink-100 transition-colors hover:bg-up-500 disabled:opacity-50"
              >
                {busy === 'commit'
                  ? 'Importing…'
                  : `Approve and import ${preview.accepted} row${preview.accepted === 1 ? '' : 's'}`}
              </button>
            ) : null}

            {preview || result ? (
              <button
                type="button"
                onClick={reset}
                className="rounded border border-navy-600 px-4 py-2 text-sm text-ink-300 hover:bg-navy-800"
              >
                Clear
              </button>
            ) : null}
          </div>

          {error ? <Notice tone="down">{error}</Notice> : null}
        </CardBody>
      </Card>

      {result ? <CommitSummary result={result} /> : null}
      {preview ? <PreviewSummary preview={preview} /> : null}
    </div>
  );
}

function CommitSummary({ result }: { result: CommitResponse }) {
  const tone =
    result.status === 'SUCCESS' ? 'up' : result.status === 'PARTIAL' ? 'warn' : 'down';

  return (
    <Card>
      <CardHeader
        title="Import complete"
        action={<Badge tone={tone}>{result.status}</Badge>}
      />
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Inserted" value={formatNumber(result.inserted)} tone="up" />
          <Stat label="Updated" value={formatNumber(result.updated)} />
          <Stat
            label="Unchanged"
            value={formatNumber(result.unchanged)}
            sub="Re-import with identical values"
          />
          <Stat
            label="Rejected"
            value={formatNumber(result.rejected)}
            tone={result.rejected > 0 ? 'down' : 'neutral'}
          />
          <Stat
            label="Warnings"
            value={formatNumber(result.warnings)}
            tone={result.warnings > 0 ? 'warn' : 'neutral'}
          />
        </div>

        <p className="text-[13px] text-ink-400">
          Trading date(s):{' '}
          <span className="text-ink-200">
            {result.tradingDates.map(formatDate).join(', ') || NO_DATA}
          </span>
          . Analytics and the market summary were regenerated for{' '}
          {result.tradingDates.length === 1 ? 'this date' : 'these dates'}.
        </p>

        {result.errorSummary ? (
          <Notice tone="warn" title="Rejection reasons">
            {result.errorSummary}
          </Notice>
        ) : null}

        <a
          href={`/admin/runs/${result.runId}`}
          className="inline-block text-[13px] text-accent-500 hover:text-accent-400"
        >
          Inspect this ingestion run →
        </a>
      </CardBody>
    </Card>
  );
}

function PreviewSummary({ preview }: { preview: PreviewResponse }) {
  const fileLevel = preview.issues.filter((i) => i.rowNumber === undefined);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Preview"
          description={`${preview.fileName ?? 'Uploaded file'} · checksum ${preview.checksum.slice(0, 12)}…`}
        />
        <CardBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Rows read" value={formatNumber(preview.totalRows)} />
            <Stat
              label="Will be stored"
              value={formatNumber(preview.accepted)}
              tone="up"
            />
            <Stat
              label="Will be rejected"
              value={formatNumber(preview.rejected)}
              tone={preview.rejected > 0 ? 'down' : 'neutral'}
            />
            <Stat
              label="Stored with warnings"
              value={formatNumber(preview.warnings)}
              tone={preview.warnings > 0 ? 'warn' : 'neutral'}
            />
          </div>

          {preview.tradingDates.length > 0 ? (
            <p className="text-[13px] text-ink-400">
              Trading date(s):{' '}
              <span className="text-ink-200">
                {preview.tradingDates.map(formatDate).join(', ')}
              </span>
            </p>
          ) : null}

          {preview.previouslyImported ? (
            <Notice tone="warn" title="This exact file has been imported before">
              A byte-identical payload was imported on{' '}
              {new Date(preview.previouslyImported.startedAt).toLocaleString('en-GB')} (
              {preview.previouslyImported.status}). Re-importing is safe and
              idempotent — it will update the same rows rather than duplicate them.
            </Notice>
          ) : null}

          {preview.unknownSymbols.length > 0 ? (
            <Notice tone="down" title="Unknown symbols">
              These symbols are not in the instrument master and their rows will
              be rejected:{' '}
              <span className="text-ink-100">
                {preview.unknownSymbols.join(', ')}
              </span>
              . Add the instruments first — the importer will not create a
              security from a market file.
            </Notice>
          ) : null}

          {fileLevel.map((issue, i) => (
            <Notice key={i} tone="down" title={issue.code}>
              {issue.message}
            </Notice>
          ))}

          {preview.accepted === 0 && preview.totalRows > 0 ? (
            <Notice tone="down" title="Nothing would be stored">
              Every row failed validation. Fix the issues listed below and upload
              again.
            </Notice>
          ) : null}
        </CardBody>
      </Card>

      {preview.rejectedRows.length > 0 ? (
        <Card>
          <CardHeader
            title={`Rejected rows (${preview.rejected})`}
            description="Each rejection names the rule that blocked it."
          />
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th align="right">Row</Th>
                  <Th>Symbol</Th>
                  <Th>Date</Th>
                  <Th>Rule</Th>
                  <Th>Reason</Th>
                </tr>
              </thead>
              <tbody>
                {preview.rejectedRows.map((row) =>
                  row.issues
                    .filter((i) => i.severity === 'ERROR')
                    .map((issue, index) => (
                      <tr key={`${row.rowNumber}-${index}`}>
                        <Td align="right">{row.rowNumber}</Td>
                        <Td>{row.record.symbol || NO_DATA}</Td>
                        <Td>{row.record.tradingDate || NO_DATA}</Td>
                        <Td>
                          <Badge tone="down">{issue.code}</Badge>
                        </Td>
                        <Td className="whitespace-normal text-ink-300">
                          {issue.message}
                        </Td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}

      {preview.sample.length > 0 ? (
        <Card>
          <CardHeader
            title="Sample of parsed rows"
            description="How the file was interpreted. An em dash means the column carried no value — it is not a zero."
          />
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Symbol</Th>
                  <Th>Date</Th>
                  <Th align="right">Close</Th>
                  <Th align="right">Turnover</Th>
                  <Th align="right">Volume</Th>
                  <Th align="right">Bid</Th>
                  <Th align="right">Offer</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row) => {
                  const warnings = row.issues.filter((i) => i.severity === 'WARNING');
                  return (
                    <tr key={row.rowNumber}>
                      <Td className="font-medium text-ink-100">
                        {row.record.symbol || NO_DATA}
                      </Td>
                      <Td>{row.record.tradingDate || NO_DATA}</Td>
                      <Td align="right">{formatNumber(row.record.close)}</Td>
                      <Td align="right">{formatNumber(row.record.turnoverTzs)}</Td>
                      <Td align="right">{formatNumber(row.record.volume)}</Td>
                      <Td align="right">
                        {formatNumber(row.record.outstandingBidQty)}
                      </Td>
                      <Td align="right">
                        {formatNumber(row.record.outstandingOfferQty)}
                      </Td>
                      <Td>
                        {!row.accepted ? (
                          <Badge tone="down">Rejected</Badge>
                        ) : warnings.length > 0 ? (
                          <Badge
                            tone="warn"
                            title={warnings.map((w) => w.message).join('\n')}
                          >
                            {warnings.length} warning
                            {warnings.length === 1 ? '' : 's'}
                          </Badge>
                        ) : (
                          <Badge tone="up">Valid</Badge>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}
    </div>
  );
}
