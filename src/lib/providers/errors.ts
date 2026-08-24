/**
 * Provider error types.
 *
 * The distinction that matters to a scheduler: "no data has been published for
 * this date yet" is a NORMAL outcome, while "the source is broken" is not.
 * Collapsing the two makes a daily job cry wolf every morning, and an alert
 * that fires every day is an alert nobody reads.
 */

/**
 * Thrown when a provider is healthy but has nothing for the requested date.
 *
 * A scheduled run treats this as SKIPPED, not FAILED. It is the expected state
 * on any day before the exchange file has been obtained.
 */
export class NoDataAvailableError extends Error {
  readonly provider: string;
  readonly tradingDate: string;

  constructor(provider: string, tradingDate: string, detail: string) {
    super(detail);
    this.name = 'NoDataAvailableError';
    this.provider = provider;
    this.tradingDate = tradingDate;
  }
}

/** True when the failure is "nothing published yet" rather than a fault. */
export function isNoDataAvailable(error: unknown): error is NoDataAvailableError {
  return error instanceof NoDataAvailableError;
}
