import 'server-only';
import type {
  MarketDataProvider,
  NormalizedMarketRecord,
  ProviderStatus,
} from '@/lib/types/market';

/**
 * Third-party market data vendor.
 *
 * DECLARED, NOT IMPLEMENTED. No vendor has been selected and no commercial
 * terms exist, so there is no API to write against.
 *
 * As with the official feed, this reports its true state rather than returning
 * fabricated records. See dse-official.ts for the reasoning.
 */
export class ThirdPartyProvider implements MarketDataProvider {
  readonly id = 'third_party';
  readonly displayName = 'Third-party market data API';
  /** Licensing depends entirely on the vendor agreement, which does not exist. */
  readonly licensed = false;

  async fetchDaily(_date: Date): Promise<NormalizedMarketRecord[]> {
    throw new Error(
      'No third-party market data vendor has been selected. This provider is a declared interface, not an implementation.',
    );
  }

  async healthCheck(): Promise<ProviderStatus> {
    return {
      healthy: false,
      provider: this.id,
      licensed: this.licensed,
      message:
        'Not configured. Awaiting vendor selection and commercial terms.',
      checkedAt: new Date(),
    };
  }
}
