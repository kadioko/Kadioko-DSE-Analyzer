import type { Metadata } from 'next';
import Link from 'next/link';
import { getAdminSession } from '@/lib/auth';
import { getEnv, isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
import { pingDatabase } from '@/lib/db/client';
import { listRuns, listSources } from '@/lib/db/repositories/ingestion';
import { latestTradingDate } from '@/lib/db/repositories/market';
import { listInstruments } from '@/lib/db/repositories/instruments';
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
import { formatDate, formatNumber, NO_DATA } from '@/lib/format';
import { LoginForm } from './login-form';
import { ImportPanel } from './import-panel';

export const metadata: Metadata = { title: 'Data administration' };
export const dynamic = 'force-dynamic';

/**
 * Admin data console.
 *
 * Authorisation is checked here, on the server, before any data is fetched.
 * An unauthenticated visitor receives the sign-in form and nothing else - no
 * counts, no run history, no instrument list.
 */
export default async function AdminDataPage() {
  if (!isDatabaseConfigured()) return <SetupRequired />;

  const session = await getAdminSession();

  if (!session) {
    const configured = Boolean(getEnv().ADMIN_TOKEN && getEnv().ADMIN_EMAIL);
    return (
      <div className="py-10">
        <LoginForm configured={configured} />
      </div>
    );
  }

  const health = await pingDatabase();
  if (!health.ok) {
    return (
      <Notice tone="down" title="Database unreachable">
        {health.error ?? 'The database did not respond.'} Check DATABASE_URL and
        that the Railway PostgreSQL service is running.
      </Notice>
    );
  }

  const [instruments, sources, runs, latestDate] = await Promise.all([
    listInstruments(),
    listSources(),
    listRuns(15),
    latestTradingDate(),
  ]);

  const withoutShares = instruments.filter(
    (i) => i.sharesOutstanding === null,
  ).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-100">
            Data administration
          </h1>
          <p className="mt-1 text-[13px] text-ink-400">
            Signed in as {session.email}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/admin/instruments"
            className="text-xs text-accent-400 hover:text-accent-300"
          >
            Instruments &rarr;
          </Link>
          <Badge tone="accent">Database {health.latencyMs} ms</Badge>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Instruments"
          value={formatNumber(instruments.length)}
          sub={`${instruments.filter((i) => i.active).length} active`}
        />
        <Stat
          label="Latest trading date"
          value={latestDate ? formatDate(latestDate) : NO_DATA}
          sub={latestDate ? undefined : 'No market data imported yet'}
        />
        <Stat
          label="Ingestion runs"
          value={formatNumber(runs.length)}
          sub="Most recent 15 shown"
        />
        <Stat
          label="Missing shares outstanding"
          value={formatNumber(withoutShares)}
          tone={withoutShares > 0 ? 'warn' : 'neutral'}
          sub="Needed for market-cap checks"
        />
      </div>

      {instruments.length === 0 ? (
        <Notice tone="warn" title="No instruments in the master">
          Run <code className="text-ink-200">npm run db:seed</code> before
          importing. Market rows for unknown symbols are rejected by design — the
          importer will not create a security from a market file.
        </Notice>
      ) : null}

      <ImportPanel />

      <Card>
        <CardHeader
          title="Data sources"
          description="Unconfigured providers report their status honestly rather than being stubbed."
        />
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Source</Th>
                <Th>Type</Th>
                <Th align="center">Enabled</Th>
                <Th align="center">Licensed</Th>
                <Th align="right">Priority</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <Td className="font-medium text-ink-100">{source.name}</Td>
                  <Td className="text-ink-400">{source.type}</Td>
                  <Td align="center">
                    <Badge tone={source.enabled ? 'up' : 'muted'}>
                      {source.enabled ? 'Yes' : 'No'}
                    </Badge>
                  </Td>
                  <Td align="center">
                    <Badge tone={source.isLicensed ? 'accent' : 'muted'}>
                      {source.isLicensed ? 'Yes' : 'No'}
                    </Badge>
                  </Td>
                  <Td align="right">{source.priority}</Td>
                  <Td className="text-ink-400">
                    {String(
                      (source.configuration as Record<string, unknown>)?.status ??
                        source.lastHealthStatus ??
                        'Ready',
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Card>

      <Card>
        <CardHeader
          title="Recent ingestion runs"
          description="Every import attempt is recorded, successful or not."
        />
        {runs.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No imports yet"
              description="Upload a DSE end-of-day CSV above. Nothing is stored until you approve the preview."
            />
          </CardBody>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Started</Th>
                  <Th>Source</Th>
                  <Th>File</Th>
                  <Th align="right">Received</Th>
                  <Th align="right">Inserted</Th>
                  <Th align="right">Updated</Th>
                  <Th align="right">Rejected</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {runs.map(({ run, source }) => (
                  <tr key={run.id}>
                    <Td className="text-ink-300">
                      {new Date(run.startedAt).toLocaleString('en-GB')}
                    </Td>
                    <Td className="text-ink-400">{source.name}</Td>
                    <Td className="max-w-[220px] truncate" title={run.fileName ?? ''}>
                      {run.fileName ?? NO_DATA}
                    </Td>
                    <Td align="right">{formatNumber(run.recordsReceived)}</Td>
                    <Td align="right">{formatNumber(run.inserted)}</Td>
                    <Td align="right">{formatNumber(run.updated)}</Td>
                    <Td align="right">
                      <span className={run.rejected > 0 ? 'text-down-400' : ''}>
                        {formatNumber(run.rejected)}
                      </span>
                    </Td>
                    <Td>
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
                    </Td>
                    <Td>
                      <Link
                        href={`/admin/runs/${run.id}`}
                        className="text-accent-500 hover:text-accent-400"
                      >
                        Inspect
                      </Link>
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
