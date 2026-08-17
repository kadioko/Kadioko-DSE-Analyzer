import 'server-only';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getEnv } from '@/lib/env';
import { parseMarketCsv, PARSE_LIMITS } from '@/lib/ingestion/parse';
import type {
  MarketDataProvider,
  NormalizedMarketRecord,
  ProviderStatus,
} from '@/lib/types/market';

/**
 * File-drop CSV provider.
 *
 * Reads DSE end-of-day files from a directory an operator controls
 * (`INGEST_DIR`, default `./data/incoming`). This is what makes scheduled
 * ingestion real without a licensed feed: a file lands in the directory, and
 * the worker picks it up.
 *
 * It performs no validation of its own. Parsing produces candidate records and
 * the ingestion engine applies the data-quality rules, so a file arriving by
 * schedule is held to exactly the same standard as one uploaded by hand.
 */
export class CsvProvider implements MarketDataProvider {
  readonly id = 'csv';
  readonly displayName = 'CSV file drop';
  /** Operator-supplied files carry no redistribution licence of their own. */
  readonly licensed = false;

  private get directory(): string {
    return resolve(process.env.INGEST_DIR ?? './data/incoming');
  }

  /**
   * Finds and parses the file for a date.
   *
   * A file matches if its name contains the ISO date (2026-08-14) or the
   * compact form (20260814). When several match, the most recently modified
   * wins — a corrected re-drop should supersede the original.
   */
  async fetchDaily(date: Date): Promise<NormalizedMarketRecord[]> {
    const iso = date.toISOString().slice(0, 10);
    const compact = iso.replace(/-/g, '');

    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      throw new Error(
        `Ingest directory ${this.directory} does not exist. Create it, or set INGEST_DIR to the folder your DSE files land in.`,
      );
    }

    const candidates = entries.filter(
      (name) =>
        /\.csv$/i.test(name) && (name.includes(iso) || name.includes(compact)),
    );

    if (candidates.length === 0) {
      throw new Error(
        `No CSV for ${iso} in ${this.directory}. Expected a filename containing "${iso}" or "${compact}".`,
      );
    }

    const withTimes = await Promise.all(
      candidates.map(async (name) => {
        const path = join(this.directory, name);
        const info = await stat(path);
        return { path, name, mtime: info.mtimeMs, size: info.size };
      }),
    );
    withTimes.sort((a, b) => b.mtime - a.mtime);

    const chosen = withTimes[0];
    if (!chosen) throw new Error(`No readable CSV for ${iso}.`);

    if (chosen.size > PARSE_LIMITS.maxBytes) {
      throw new Error(
        `${chosen.name} is ${(chosen.size / 1_048_576).toFixed(1)} MB, above the ${PARSE_LIMITS.maxBytes / 1_048_576} MB limit.`,
      );
    }

    const content = await readFile(chosen.path, 'utf8');
    const parsed = parseMarketCsv(content, { defaultTradingDate: iso });

    if (parsed.fatalError) {
      throw new Error(`${chosen.name}: ${parsed.fatalError}`);
    }

    // Rows that could not be read at all are dropped here; the ingestion
    // engine records and reports every rejection it makes on the rest.
    return parsed.records
      .map((r) => r.record)
      .filter((r): r is NormalizedMarketRecord => r !== null);
  }

  /** Reports what the operator actually needs to know: is the directory usable. */
  async healthCheck(): Promise<ProviderStatus> {
    const started = Date.now();
    try {
      const entries = await readdir(this.directory);
      const csvCount = entries.filter((n) => /\.csv$/i.test(n)).length;
      return {
        healthy: true,
        provider: this.id,
        licensed: this.licensed,
        message: `${this.directory} is readable and contains ${csvCount} CSV file(s).`,
        checkedAt: new Date(),
        latencyMs: Date.now() - started,
      };
    } catch {
      return {
        healthy: false,
        provider: this.id,
        licensed: this.licensed,
        message: `Ingest directory ${this.directory} is not readable. Create it or set INGEST_DIR.`,
        checkedAt: new Date(),
        latencyMs: Date.now() - started,
      };
    }
  }
}

/** Kept so the class can read configuration without importing env at module load. */
export function csvProviderDirectory(): string {
  getEnv();
  return resolve(process.env.INGEST_DIR ?? './data/incoming');
}
