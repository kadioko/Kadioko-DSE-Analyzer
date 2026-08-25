import 'server-only';
import { asc, eq, inArray, sql as raw } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { instruments, type Instrument, type NewInstrument } from '@/lib/db/schema';
import { toNum } from '@/lib/db/num';

/**
 * Instrument master data access.
 *
 * The instrument list is the gate on ingestion: a market row whose symbol is
 * not here is rejected rather than auto-created, so a typo in a source file
 * cannot silently invent a security.
 */

export async function listInstruments(
  options: { activeOnly?: boolean } = {},
): Promise<Instrument[]> {
  const query = db.select().from(instruments).orderBy(asc(instruments.symbol));
  const rows = options.activeOnly
    ? await query.where(eq(instruments.active, true))
    : await query;
  return rows;
}

export async function getInstrumentBySymbol(
  symbol: string,
): Promise<Instrument | null> {
  const rows = await db
    .select()
    .from(instruments)
    .where(eq(instruments.symbol, symbol.toUpperCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function getInstrumentsBySymbols(
  symbols: readonly string[],
): Promise<Instrument[]> {
  if (symbols.length === 0) return [];
  const upper = symbols.map((s) => s.toUpperCase());
  return db.select().from(instruments).where(inArray(instruments.symbol, upper));
}

/** Symbol -> id, for resolving a parsed import batch in one query. */
export async function symbolIdMap(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: instruments.id, symbol: instruments.symbol })
    .from(instruments);
  return new Map(rows.map((r) => [r.symbol, r.id]));
}

/**
 * Symbol -> declared reporting scale, with where it was read from.
 *
 * A reporting convention belongs to the issuer and is stable across periods, so
 * declaring it once here beats re-deriving it from every statement. Only
 * instruments carrying a declaration appear; the rest fall back to inference.
 */
export async function declaredReportingScales(): Promise<
  Map<string, { scale: number; source: string | null }>
> {
  const rows = await db
    .select({
      symbol: instruments.symbol,
      scale: instruments.reportingScale,
      source: instruments.reportingScaleSource,
    })
    .from(instruments);

  const map = new Map<string, { scale: number; source: string | null }>();
  for (const row of rows) {
    const scale = toNum(row.scale);
    if (scale !== null && scale > 0) {
      map.set(row.symbol, { scale, source: row.source });
    }
  }
  return map;
}

/** Symbol -> shares outstanding, for the market-cap consistency check. */
export async function sharesOutstandingMap(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      symbol: instruments.symbol,
      shares: instruments.sharesOutstanding,
    })
    .from(instruments);

  const map = new Map<string, number>();
  for (const row of rows) {
    const shares = toNum(row.shares);
    // Only instruments with a verified figure participate in the check.
    if (shares !== null && shares > 0) map.set(row.symbol, shares);
  }
  return map;
}

/**
 * Inserts instruments that do not exist and updates descriptive fields on
 * those that do. Never deactivates or deletes: removing a security is an
 * operator decision, not a side effect of re-running a seed.
 */
export async function upsertInstruments(
  records: readonly NewInstrument[],
): Promise<{ inserted: number; updated: number }> {
  if (records.length === 0) return { inserted: 0, updated: 0 };

  const existing = await db
    .select({ symbol: instruments.symbol })
    .from(instruments);
  const known = new Set(existing.map((r) => r.symbol));

  let inserted = 0;
  let updated = 0;
  for (const record of records) {
    if (known.has(record.symbol)) updated += 1;
    else inserted += 1;
  }

  await db
    .insert(instruments)
    .values(records as NewInstrument[])
    .onConflictDoUpdate({
      target: instruments.symbol,
      set: {
        name: raw`excluded.name`,
        securityType: raw`excluded.security_type`,
        sector: raw`excluded.sector`,
        isCrossListed: raw`excluded.is_cross_listed`,
        countryOfIncorporation: raw`excluded.country_of_incorporation`,
        currency: raw`excluded.currency`,
        notes: raw`excluded.notes`,
        updatedAt: new Date(),
      },
    });

  return { inserted, updated };
}

/** Updates the shares-outstanding figure an operator has verified. */
export async function setSharesOutstanding(
  symbol: string,
  shares: number | null,
): Promise<void> {
  await db
    .update(instruments)
    .set({ sharesOutstanding: shares, updatedAt: new Date() })
    .where(eq(instruments.symbol, symbol.toUpperCase()));
}

export async function setInstrumentActive(
  symbol: string,
  active: boolean,
): Promise<void> {
  await db
    .update(instruments)
    .set({ active, updatedAt: new Date() })
    .where(eq(instruments.symbol, symbol.toUpperCase()));
}

/** Fields an operator may change on an existing instrument. */
export interface InstrumentEdit {
  name?: string;
  sector?: string | null;
  isCrossListed?: boolean;
  currency?: string;
  countryOfIncorporation?: string;
  active?: boolean;
  sharesOutstanding?: number | null;
  /** Null clears the declaration and returns the issuer to inference. */
  reportingScale?: number | null;
  reportingScaleSource?: string | null;
  notes?: string | null;
}

/**
 * Applies an operator's edit to one instrument.
 *
 * Only the keys actually present are written, so a form that submits one field
 * cannot blank the others. Returns false when the symbol does not exist, which
 * the caller reports as a 404 rather than silently succeeding.
 */
export async function updateInstrument(
  symbol: string,
  edit: InstrumentEdit,
): Promise<boolean> {
  const set: Record<string, unknown> = { updatedAt: new Date() };

  if (edit.name !== undefined) set.name = edit.name;
  if (edit.sector !== undefined) set.sector = edit.sector;
  if (edit.isCrossListed !== undefined) set.isCrossListed = edit.isCrossListed;
  if (edit.currency !== undefined) set.currency = edit.currency.toUpperCase();
  if (edit.countryOfIncorporation !== undefined) {
    set.countryOfIncorporation = edit.countryOfIncorporation.toUpperCase();
  }
  if (edit.active !== undefined) set.active = edit.active;
  if (edit.sharesOutstanding !== undefined) {
    set.sharesOutstanding = edit.sharesOutstanding;
  }
  if (edit.reportingScale !== undefined) {
    // NUMERIC is a string at the driver boundary.
    set.reportingScale =
      edit.reportingScale === null ? null : edit.reportingScale.toFixed(2);
  }
  if (edit.reportingScaleSource !== undefined) {
    set.reportingScaleSource = edit.reportingScaleSource;
  }
  if (edit.notes !== undefined) set.notes = edit.notes;

  const updated = await db
    .update(instruments)
    .set(set)
    .where(eq(instruments.symbol, symbol.toUpperCase()))
    .returning({ symbol: instruments.symbol });

  return updated.length > 0;
}

/**
 * Symbols whose financial statements are in a different currency from the one
 * they trade in.
 *
 * Cross-listed issuers (Kenyan companies on the DSE) report in their home
 * currency while trading in TZS. Any per-share metric that mixes the two is
 * wrong by the exchange rate, and no FX series is held, so those metrics must
 * be withheld rather than computed.
 */
export async function foreignReportingSymbols(): Promise<Set<string>> {
  const rows = await db
    .select({
      symbol: instruments.symbol,
      isCrossListed: instruments.isCrossListed,
      country: instruments.countryOfIncorporation,
    })
    .from(instruments);

  return new Set(
    rows
      .filter((r) => r.isCrossListed || r.country !== 'TZ')
      .map((r) => r.symbol),
  );
}

/** Distinct sectors present in the master, for the market-table filter. */
export async function listSectors(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sector: instruments.sector })
    .from(instruments)
    .orderBy(asc(instruments.sector));
  return rows
    .map((r) => r.sector)
    .filter((s): s is string => s !== null && s !== '');
}
