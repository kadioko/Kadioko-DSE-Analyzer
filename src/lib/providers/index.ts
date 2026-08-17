import 'server-only';
import { getEnv } from '@/lib/env';
import type { MarketDataProvider } from '@/lib/types/market';
import { CsvProvider } from './csv-provider';
import { DseOfficialProvider } from './dse-official';
import { ThirdPartyProvider } from './third-party';

/**
 * Market data provider registry.
 *
 * Every source implements the same `MarketDataProvider` contract, so nothing
 * downstream of ingestion knows or cares where a record came from.
 *
 * Only `CsvProvider` is implemented. The other two are declared and report
 * `healthy: false` with the reason, because faking a feed that appears to work
 * but returns invented data would be far worse than one that plainly says it is
 * not configured. They exist so the wiring is proven and swapping in a licensed
 * feed is a single file, not an architectural change.
 */

export function getProvider(id?: string): MarketDataProvider {
  const requested = id ?? getEnv().DATA_PROVIDER;

  switch (requested) {
    case 'csv':
      return new CsvProvider();
    case 'dse_official':
      return new DseOfficialProvider();
    case 'third_party':
      return new ThirdPartyProvider();
    default:
      throw new Error(
        `Unknown data provider "${requested}". Valid values: csv, dse_official, third_party.`,
      );
  }
}

/** Every provider, for the admin source-status screen. */
export function allProviders(): MarketDataProvider[] {
  return [new CsvProvider(), new DseOfficialProvider(), new ThirdPartyProvider()];
}

export { CsvProvider, DseOfficialProvider, ThirdPartyProvider };
export type { MarketDataProvider };
