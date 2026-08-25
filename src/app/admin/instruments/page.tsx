import type { Metadata } from 'next';
import Link from 'next/link';
import { getAdminSession } from '@/lib/auth';
import { getEnv, isDatabaseConfigured } from '@/lib/env';
import { SetupRequired } from '@/components/setup-required';
import { listInstruments } from '@/lib/db/repositories/instruments';
import { db } from '@/lib/db/client';
import { fundamentals, instruments as instrumentsTable } from '@/lib/db/schema';
import { eq, sql as raw } from 'drizzle-orm';
import { Notice } from '@/components/ui/primitives';
import { LoginForm } from '../data/login-form';
import { InstrumentTable, type InstrumentRow } from './instrument-table';

export const metadata: Metadata = { title: 'Instruments' };
export const dynamic = 'force-dynamic';

/**
 * Instrument administration.
 *
 * Authorisation is checked here, on the server, before anything is read. An
 * unauthenticated visitor gets the sign-in form and nothing else.
 *
 * As well as the master itself, this page surfaces which issuers still have
 * their reporting unit *inferred* rather than declared, because that is the
 * one field an operator can materially improve by looking something up.
 */
export default async function AdminInstrumentsPage() {
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

  const rows = await listInstruments({ activeOnly: false });

  /*
   * What the importer most recently concluded for issuers that have not
   * declared a scale. Only INFERRED counts: NOT_APPLICABLE means the question
   * could not be asked, and UNDETERMINED means it was asked and refused.
   */
  const inferredRows = await db
    .select({
      symbol: instrumentsTable.symbol,
      scale: raw<string>`max(${fundamentals.reportingScale})`,
    })
    .from(fundamentals)
    .innerJoin(instrumentsTable, eq(instrumentsTable.id, fundamentals.instrumentId))
    .where(eq(fundamentals.scaleSource, 'INFERRED'))
    .groupBy(instrumentsTable.symbol);

  const inferred: Record<string, number> = {};
  for (const row of inferredRows) {
    const value = Number(row.scale);
    if (Number.isFinite(value) && value > 0) inferred[row.symbol] = value;
  }

  const instruments: InstrumentRow[] = rows.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    securityType: r.securityType,
    sector: r.sector,
    isCrossListed: r.isCrossListed,
    currency: r.currency,
    active: r.active,
    sharesOutstanding:
      r.sharesOutstanding === null ? null : Number(r.sharesOutstanding),
    reportingScale: r.reportingScale,
    reportingScaleSource: r.reportingScaleSource,
  }));

  return (
    <div className="flex flex-col gap-5 py-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-100">Instruments</h1>
          <p className="mt-1 text-[13px] text-ink-400">
            The security master every observation, valuation and ranking joins on.
          </p>
        </div>
        <Link
          href="/admin/data"
          className="text-xs text-accent-400 hover:text-accent-300"
        >
          Data console →
        </Link>
      </header>

      <InstrumentTable instruments={instruments} inferred={inferred} />

      <Notice tone="neutral" title="Why a symbol cannot be changed here">
        A symbol is the identity every stored row joins on. Renaming one would
        re-attribute an entire price history to a different company without any
        error being raised. If a security genuinely re-tickers, add the new
        symbol and deactivate the old one, so both histories stay intact and
        separately attributable.
      </Notice>
    </div>
  );
}
