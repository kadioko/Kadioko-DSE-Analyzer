import 'server-only';
import { and, asc, desc, eq, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { corporateActions, instruments } from '@/lib/db/schema';
import { toNum } from '@/lib/db/num';
import type { CorporateActionRow } from '@/lib/db/schema';

/**
 * Corporate actions: dividends, splits, issues and announcements.
 *
 * The dividend logic here is what makes dividend yield real. It sums DECLARED
 * dividends over a trailing twelve months, which is a fact about what was paid,
 * rather than annualising a single interim payment — a company that has
 * declared one interim dividend has not necessarily committed to a second.
 */

/**
 * Trailing twelve-month dividend per share, per instrument, as of a date.
 *
 * Uses the EX-DATE where present, because that is when the dividend detached
 * from the share and therefore when it belongs to a holder. Falls back to the
 * effective date.
 *
 * Returns only instruments that actually declared something. An absent entry
 * means "no dividend on file", which the valuation engine reports distinctly
 * from a declared zero.
 */
export async function trailingDividendsAsOf(
  asOfDate: string,
): Promise<Map<string, { dps: number; payments: number; currency: string }>> {
  const result = await db.execute(raw`
    select
      ca.instrument_id::text                       as instrument_id,
      sum(ca.amount_per_share)::text               as dps,
      count(*)::int                                as payments,
      min(ca.currency)                             as currency
    from corporate_actions ca
    where ca.type = 'DIVIDEND'
      and ca.amount_per_share is not null
      and coalesce(ca.ex_date, ca.effective_date) <= ${asOfDate}::date
      and coalesce(ca.ex_date, ca.effective_date)
            > (${asOfDate}::date - interval '12 months')
    group by ca.instrument_id
  `);

  const rows = result as unknown as Array<Record<string, unknown>>;
  const map = new Map<string, { dps: number; payments: number; currency: string }>();

  for (const r of rows) {
    const instrumentId = r.instrument_id as string | undefined;
    const dps = toNum(r.dps as string | null);
    if (!instrumentId || dps === null) continue;
    map.set(instrumentId, {
      dps,
      payments: Number(r.payments ?? 0),
      currency: (r.currency as string | null) ?? 'TZS',
    });
  }

  return map;
}

/**
 * Ex-dates per instrument, so an extreme price move can be attributed to a
 * dividend detaching rather than flagged as suspect data.
 */
export async function exDatesFor(
  symbols: readonly string[],
): Promise<Map<string, Set<string>>> {
  if (symbols.length === 0) return new Map();

  const rows = await db
    .select({
      symbol: instruments.symbol,
      exDate: corporateActions.exDate,
      effectiveDate: corporateActions.effectiveDate,
      type: corporateActions.type,
    })
    .from(corporateActions)
    .innerJoin(instruments, eq(corporateActions.instrumentId, instruments.id));

  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    // Splits and bonus issues move the price mechanically too, so they count.
    const date = row.exDate ?? row.effectiveDate;
    if (!date) continue;
    const set = map.get(row.symbol) ?? new Set<string>();
    set.add(date);
    map.set(row.symbol, set);
  }
  return map;
}

/** Corporate-action timeline for one security, most recent first. */
export async function actionsForSymbol(
  symbol: string,
  limit = 50,
): Promise<CorporateActionRow[]> {
  return db
    .select({
      id: corporateActions.id,
      instrumentId: corporateActions.instrumentId,
      type: corporateActions.type,
      announcedDate: corporateActions.announcedDate,
      exDate: corporateActions.exDate,
      recordDate: corporateActions.recordDate,
      paymentDate: corporateActions.paymentDate,
      effectiveDate: corporateActions.effectiveDate,
      amountPerShare: corporateActions.amountPerShare,
      currency: corporateActions.currency,
      ratioFrom: corporateActions.ratioFrom,
      ratioTo: corporateActions.ratioTo,
      subscriptionPrice: corporateActions.subscriptionPrice,
      title: corporateActions.title,
      description: corporateActions.description,
      source: corporateActions.source,
      sourceUrl: corporateActions.sourceUrl,
      verified: corporateActions.verified,
      createdAt: corporateActions.createdAt,
      updatedAt: corporateActions.updatedAt,
    })
    .from(corporateActions)
    .innerJoin(instruments, eq(corporateActions.instrumentId, instruments.id))
    .where(eq(instruments.symbol, symbol.toUpperCase()))
    .orderBy(
      desc(
        raw`coalesce(${corporateActions.effectiveDate}, ${corporateActions.announcedDate})`,
      ),
    )
    .limit(limit);
}

/** Upcoming actions across the market, for the dashboard and reports. */
export async function upcomingActions(fromDate: string, limit = 20) {
  return db
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      type: corporateActions.type,
      title: corporateActions.title,
      exDate: corporateActions.exDate,
      paymentDate: corporateActions.paymentDate,
      effectiveDate: corporateActions.effectiveDate,
      amountPerShare: corporateActions.amountPerShare,
      currency: corporateActions.currency,
    })
    .from(corporateActions)
    .innerJoin(instruments, eq(corporateActions.instrumentId, instruments.id))
    .where(
      and(
        raw`coalesce(${corporateActions.exDate}, ${corporateActions.effectiveDate}) >= ${fromDate}::date`,
      ),
    )
    .orderBy(
      asc(
        raw`coalesce(${corporateActions.exDate}, ${corporateActions.effectiveDate})`,
      ),
    )
    .limit(limit);
}

/** Whether any corporate action exists at all, for empty-state messaging. */
export async function hasAnyCorporateActions(): Promise<boolean> {
  const rows = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(corporateActions)
    .limit(1);
  return (rows[0]?.count ?? 0) > 0;
}
