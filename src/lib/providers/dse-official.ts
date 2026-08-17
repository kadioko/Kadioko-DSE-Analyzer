import 'server-only';
import { getEnv } from '@/lib/env';
import type {
  MarketDataProvider,
  NormalizedMarketRecord,
  ProviderStatus,
} from '@/lib/types/market';

/**
 * Licensed DSE exchange feed.
 *
 * DECLARED, NOT IMPLEMENTED. There is no endpoint specification and no data
 * licence, so there is nothing to implement against.
 *
 * `fetchDaily` throws and `healthCheck` reports unhealthy with the reason. That
 * is deliberate: a stub returning plausible-looking data would make the
 * platform appear to have a live exchange feed while publishing fiction, which
 * is the single worst failure mode this project can have.
 *
 * When a licence and specification exist, only this file changes.
 */
export class DseOfficialProvider implements MarketDataProvider {
  readonly id = 'dse_official';
  readonly displayName = 'DSE official feed (licensed)';
  readonly licensed = true;

  private get configured(): boolean {
    const env = getEnv();
    return Boolean(env.DSE_API_URL && env.DSE_API_KEY);
  }

  async fetchDaily(_date: Date): Promise<NormalizedMarketRecord[]> {
    throw new Error(
      this.configured
        ? 'The DSE official feed has credentials configured but no implementation. The endpoint specification is required before this provider can be written; it will not be guessed.'
        : 'The DSE official feed is not configured. It requires a data licence, an endpoint specification and credentials (DSE_API_URL, DSE_API_KEY).',
    );
  }

  async healthCheck(): Promise<ProviderStatus> {
    return {
      healthy: false,
      provider: this.id,
      licensed: this.licensed,
      message: this.configured
        ? 'Credentials are present but this provider has no implementation. Awaiting the exchange endpoint specification.'
        : 'Not configured. Requires a DSE data licence, endpoint specification and credentials.',
      checkedAt: new Date(),
    };
  }
}
