import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsvProvider } from '@/lib/providers/csv-provider';
import { NoDataAvailableError, isNoDataAvailable } from '@/lib/providers/errors';

/**
 * The distinction a scheduled job depends on.
 *
 * "Nothing has been published for this date yet" is the normal state on most
 * mornings, and must not be reported as a fault. "The directory is missing" or
 * "the file is unreadable" genuinely is one. Collapsing the two would make a
 * daily job raise an alarm every day, and an alarm that fires every day stops
 * being read.
 */

let dir: string;
let previous: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kadioko-provider-'));
  previous = process.env.INGEST_DIR;
  process.env.INGEST_DIR = dir;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.INGEST_DIR;
  else process.env.INGEST_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

const A_DATE = new Date('2026-08-14T00:00:00Z');

describe('CsvProvider availability', () => {
  it('reports a missing file as no-data-available, not as a failure', async () => {
    const provider = new CsvProvider();

    await expect(provider.fetchDaily(A_DATE)).rejects.toBeInstanceOf(
      NoDataAvailableError,
    );

    const error = await provider.fetchDaily(A_DATE).catch((e: unknown) => e);
    expect(isNoDataAvailable(error)).toBe(true);
    expect((error as NoDataAvailableError).tradingDate).toBe('2026-08-14');
    expect((error as NoDataAvailableError).provider).toBe('csv');
  });

  it('does not treat a file for a different date as this date', async () => {
    await writeFile(
      join(dir, 'dse-eod-2026-08-13.csv'),
      'symbol,close\nCRDB,600\n',
      'utf8',
    );

    const error = await new CsvProvider().fetchDaily(A_DATE).catch((e: unknown) => e);
    expect(isNoDataAvailable(error)).toBe(true);
  });

  it('accepts both the ISO and the compact date form in a filename', async () => {
    await writeFile(
      join(dir, 'DSE_MARKET_20260814.csv'),
      'symbol,close\nCRDB,600\n',
      'utf8',
    );

    // Resolves rather than rejecting: the file was found by its compact date.
    await expect(new CsvProvider().fetchDaily(A_DATE)).resolves.toBeInstanceOf(Array);
  });

  it('reports a missing directory as a real failure, not as no-data', async () => {
    process.env.INGEST_DIR = join(dir, 'does-not-exist');

    const error = await new CsvProvider().fetchDaily(A_DATE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // A directory that is not there is a configuration fault and should be
    // retried and surfaced, unlike a file that has simply not arrived.
    expect(isNoDataAvailable(error)).toBe(false);
  });

  it('reports the directory as unhealthy when it cannot be read', async () => {
    process.env.INGEST_DIR = join(dir, 'does-not-exist');

    const status = await new CsvProvider().healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.provider).toBe('csv');
  });

  it('reports the directory as healthy when it exists, even while empty', async () => {
    const status = await new CsvProvider().healthCheck();
    expect(status.healthy).toBe(true);
    // An empty drop folder is a normal state, not a broken one.
    expect(status.message).toContain('0 CSV file');
  });
});
