/**
 * Seeds reference data: instruments, ingestion sources and scoring models.
 *
 *   npm run db:seed
 *
 * This script creates NO market data. Prices, volumes and order-book figures
 * only ever enter the database through the ingestion pipeline, so that every
 * number in the application is traceable to a source file and an ingestion run.
 *
 * Safe to re-run: instruments are upserted by symbol, sources and scoring
 * models by their unique name/version. Nothing is deleted or deactivated.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as raw } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../src/lib/db/schema';
import { MODEL_REGISTRY } from '../src/lib/analytics/config';
import { parseDeclaredScale } from '../src/lib/analytics/units';

loadEnv({ path: '.env', quiet: true });

type SecurityType = (typeof schema.securityTypeEnum.enumValues)[number];

interface SeedInstrument {
  symbol: string;
  name: string;
  securityType: SecurityType;
  sector: string | null;
  isCrossListed: boolean;
  countryOfIncorporation: string;
  currency: string;
  sharesOutstanding: number | null;
  /** Stored as text: the column is NUMERIC, which Drizzle types as string. */
  reportingScale: string | null;
  reportingScaleSource: string | null;
  notes: string | null;
}

/**
 * Reads data/instruments.seed.csv.
 *
 * Deliberately a plain hand-rolled reader rather than the market CSV parser:
 * this is reference data with a fixed shape, and keeping it separate means a
 * change to market-file parsing can never alter what the instrument master
 * means. Lines starting with # are comments.
 */
function readInstrumentSeed(): SeedInstrument[] {
  const path = resolve(process.cwd(), 'data/instruments.seed.csv');
  const content = readFileSync(path, 'utf8');

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  const header = lines.shift();
  if (!header) throw new Error('data/instruments.seed.csv has no header row.');

  const columns = header.split(',').map((c) => c.trim());
  const indexOf = (name: string) => columns.indexOf(name);

  const iSymbol = indexOf('symbol');
  const iName = indexOf('name');
  const iType = indexOf('security_type');
  const iSector = indexOf('sector');
  const iCross = indexOf('is_cross_listed');
  const iCountry = indexOf('country_of_incorporation');
  const iCurrency = indexOf('currency');
  const iShares = indexOf('shares_outstanding');
  const iScale = indexOf('reporting_scale');
  const iScaleSource = indexOf('reporting_scale_source');
  const iNotes = indexOf('notes');

  if (iSymbol === -1 || iName === -1) {
    throw new Error(
      'data/instruments.seed.csv must contain at least "symbol" and "name" columns.',
    );
  }

  const validTypes = new Set<string>(schema.securityTypeEnum.enumValues);
  const seen = new Set<string>();
  const instruments: SeedInstrument[] = [];

  for (const line of lines) {
    const cells = line.split(',').map((c) => c.trim());
    const symbol = (cells[iSymbol] ?? '').toUpperCase();
    const name = cells[iName] ?? '';
    if (!symbol || !name) continue;

    if (seen.has(symbol)) {
      throw new Error(
        `data/instruments.seed.csv contains ${symbol} more than once. Fix the file rather than letting one row silently win.`,
      );
    }
    seen.add(symbol);

    const rawType = cells[iType] ?? 'EQUITY';
    if (!validTypes.has(rawType)) {
      throw new Error(
        `Unknown security_type "${rawType}" for ${symbol}. Valid values: ${[...validTypes].join(', ')}.`,
      );
    }

    instruments.push({
      symbol,
      name,
      securityType: rawType as SecurityType,
      sector: cells[iSector] || null,
      isCrossListed: (cells[iCross] ?? '').toLowerCase() === 'true',
      countryOfIncorporation: (cells[iCountry] || 'TZ').toUpperCase(),
      currency: (cells[iCurrency] || 'TZS').toUpperCase(),
      // Absent or unparseable stays NULL. A guessed share count would produce
      // false MARKET_CAP_ANOMALY warnings on every import.
      sharesOutstanding: (() => {
        if (iShares === -1) return null;
        const raw = (cells[iShares] ?? '').replace(/[,\s]/g, '');
        if (raw === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      })(),
      // The multiplier turning this issuer's reported figures into absolute
      // currency. Blank means undeclared, and the importer infers instead.
      // Accepts a number or a statement's own wording ("TZS'000").
      reportingScale: (() => {
        if (iScale === -1) return null;
        const parsed = parseDeclaredScale(cells[iScale] ?? null);
        return parsed === null ? null : parsed.toFixed(2);
      })(),
      reportingScaleSource:
        iScaleSource === -1 ? null : cells[iScaleSource] || null,
      notes: iNotes === -1 ? null : cells[iNotes] || null,
    });
  }

  return instruments;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL is not set. Copy .env.example to .env and add your Railway connection string.',
    );
    process.exit(1);
  }

  const client = postgres(url, {
    max: 1,
    ssl: url.includes('localhost') ? false : 'require',
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });

  try {
    /* -- Instruments ----------------------------------------------------- */
    const seedInstruments = readInstrumentSeed();
    console.log(`Seeding ${seedInstruments.length} instruments ...`);

    const existing = await db
      .select({ symbol: schema.instruments.symbol })
      .from(schema.instruments);
    const known = new Set(existing.map((r) => r.symbol));
    const newCount = seedInstruments.filter((i) => !known.has(i.symbol)).length;

    await db
      .insert(schema.instruments)
      .values(seedInstruments)
      .onConflictDoUpdate({
        target: schema.instruments.symbol,
        set: {
          name: raw`excluded.name`,
          securityType: raw`excluded.security_type`,
          sector: raw`excluded.sector`,
          isCrossListed: raw`excluded.is_cross_listed`,
          countryOfIncorporation: raw`excluded.country_of_incorporation`,
          currency: raw`excluded.currency`,
          notes: raw`excluded.notes`,
          // Only overwrite when the seed actually carries a figure, so a value
          // an operator entered by hand is never wiped by a re-seed.
          sharesOutstanding: raw`coalesce(excluded.shares_outstanding, ${schema.instruments.sharesOutstanding})`,
          // Same rule: a declaration made by hand survives a re-seed.
          reportingScale: raw`coalesce(excluded.reporting_scale, ${schema.instruments.reportingScale})`,
          reportingScaleSource: raw`coalesce(excluded.reporting_scale_source, ${schema.instruments.reportingScaleSource})`,
          updatedAt: new Date(),
        },
      });

    console.log(
      `  ${newCount} new, ${seedInstruments.length - newCount} updated.`,
    );
    const withShares = seedInstruments.filter(
      (i) => i.sharesOutstanding !== null,
    ).length;
    console.log(
      `  ${withShares} of ${seedInstruments.length} carry a shares-outstanding figure.`,
    );

    /* -- Ingestion sources ------------------------------------------------ */
    const sources = [
      {
        name: 'Manual CSV upload',
        type: 'CSV_MANUAL' as const,
        endpoint: null,
        enabled: true,
        priority: 10,
        isLicensed: false,
        configuration: {
          description:
            'Operator-uploaded DSE end-of-day file, reviewed in the admin preview before it is stored.',
        },
        credentialsEnvKey: null,
      },
      {
        name: 'DSE official feed',
        type: 'DSE_OFFICIAL' as const,
        endpoint: null,
        // Disabled until a data licence, endpoint specification and credentials
        // exist. It is not stubbed with a fabricated implementation.
        enabled: false,
        priority: 1,
        isLicensed: true,
        configuration: {
          description:
            'Licensed exchange feed. Awaiting data licence and endpoint specification.',
          status: 'NOT_CONFIGURED',
        },
        credentialsEnvKey: 'DSE_API_KEY',
      },
      {
        name: 'Third-party market data API',
        type: 'THIRD_PARTY_API' as const,
        endpoint: null,
        enabled: false,
        priority: 50,
        isLicensed: false,
        configuration: {
          description:
            'Vendor feed. Awaiting vendor selection and commercial terms.',
          status: 'NOT_CONFIGURED',
        },
        credentialsEnvKey: null,
      },
    ];

    console.log(`Seeding ${sources.length} ingestion sources ...`);
    await db
      .insert(schema.ingestionSources)
      .values(sources)
      .onConflictDoUpdate({
        target: schema.ingestionSources.name,
        set: {
          type: raw`excluded.type`,
          priority: raw`excluded.priority`,
          isLicensed: raw`excluded.is_licensed`,
          configuration: raw`excluded.configuration`,
          credentialsEnvKey: raw`excluded.credentials_env_key`,
          updatedAt: new Date(),
        },
      });

    /* -- Scoring models --------------------------------------------------- */
    console.log(`Seeding ${MODEL_REGISTRY.length} scoring models ...`);
    await db
      .insert(schema.scoringModels)
      .values(
        MODEL_REGISTRY.map((m) => ({
          version: m.version,
          family: m.family,
          description: m.description,
          weights: m.weights,
          parameters: m.parameters,
          active: true,
        })),
      )
      .onConflictDoUpdate({
        target: schema.scoringModels.version,
        set: {
          family: raw`excluded.family`,
          description: raw`excluded.description`,
          weights: raw`excluded.weights`,
          parameters: raw`excluded.parameters`,
          active: raw`excluded.active`,
        },
      });

    console.log('\nSeed complete. No market data was created.');
    console.log('Import a DSE end-of-day file at /admin/data to populate the market.');
  } catch (error) {
    console.error('Seed failed:');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main();
