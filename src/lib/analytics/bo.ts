/**
 * Bid / Offer analytics.
 *
 * The outstanding bid and offer quantities published by the DSE describe the
 * resting order book at the close: how many shares buyers still want versus how
 * many sellers still have on the board.
 *
 * The single most important rule in this module: when the ratio is
 * mathematically undefined we return null and say why in `state`. We never
 * fabricate a sentinel such as 999999, because such a value would flow into
 * averages, momentum and scores and corrupt everything downstream.
 */

import type { BoResult, BoState } from '@/lib/types/market';
import { safeDiv } from '@/lib/db/num';

export interface BoInput {
  bidQty: number | null;
  offerQty: number | null;
  /** Close price, used to value the resting order book in TZS. */
  close?: number | null;
  marketCapTzs?: number | null;
}

/**
 * Classifies the order book.
 *
 *  - bid > 0, offer > 0 -> NORMAL,    ratio = bid / offer
 *  - bid = 0, offer > 0 -> NO_BID,    ratio = 0 (there genuinely is no demand)
 *  - bid > 0, offer = 0 -> NO_OFFER,  ratio = null (undefined, not infinite)
 *  - bid = 0, offer = 0 -> EMPTY_BOOK, ratio = null
 */
export function classifyBook(
  bidQty: number | null,
  offerQty: number | null,
): BoState {
  if (bidQty === null || offerQty === null) return 'EMPTY_BOOK';
  const hasBid = bidQty > 0;
  const hasOffer = offerQty > 0;
  if (hasBid && hasOffer) return 'NORMAL';
  if (!hasBid && hasOffer) return 'NO_BID';
  if (hasBid && !hasOffer) return 'NO_OFFER';
  return 'EMPTY_BOOK';
}

/**
 * The bid/offer ratio itself.
 * Returns 0 for NO_BID (a real, meaningful zero) and null for NO_OFFER and
 * EMPTY_BOOK (undefined). Callers must read `state` alongside the number.
 */
export function boRatio(
  bidQty: number | null,
  offerQty: number | null,
): { ratio: number | null; state: BoState } {
  const state = classifyBook(bidQty, offerQty);
  switch (state) {
    case 'NORMAL':
      return { ratio: safeDiv(bidQty, offerQty), state };
    case 'NO_BID':
      return { ratio: 0, state };
    case 'NO_OFFER':
    case 'EMPTY_BOOK':
      return { ratio: null, state };
  }
}

/**
 * Full order-book analysis: ratio, state, TZS values of each side, and each
 * side expressed as a percentage of market capitalisation.
 *
 * Normalising by market cap is what makes a 435,736-share bid on a 2,600 TZS
 * counter comparable with an 11,414-share bid on a 17,600 TZS counter.
 */
export function analyzeOrderBook(input: BoInput): BoResult {
  const { bidQty, offerQty, close = null, marketCapTzs = null } = input;
  const { ratio, state } = boRatio(bidQty, offerQty);

  const bidValueTzs =
    bidQty !== null && close !== null ? bidQty * close : null;
  const offerValueTzs =
    offerQty !== null && close !== null ? offerQty * close : null;

  const bidPctMcap =
    bidValueTzs !== null && marketCapTzs !== null && marketCapTzs > 0
      ? (bidValueTzs / marketCapTzs) * 100
      : null;
  const offerPctMcap =
    offerValueTzs !== null && marketCapTzs !== null && marketCapTzs > 0
      ? (offerValueTzs / marketCapTzs) * 100
      : null;

  return {
    ratio,
    state,
    bidQty,
    offerQty,
    bidValueTzs,
    offerValueTzs,
    bidPctMcap,
    offerPctMcap,
  };
}

/**
 * Net order-book imbalance as a percentage of market cap.
 * Positive means more resting demand than supply. Used by the depth component
 * of the pressure score.
 */
export function netDepthPctMcap(result: BoResult): number | null {
  if (result.bidPctMcap === null || result.offerPctMcap === null) return null;
  return result.bidPctMcap - result.offerPctMcap;
}

/**
 * Whether a B/O observation may be used in a trailing average.
 * Only NORMAL and NO_BID produce a defined ratio; the other states contribute
 * nothing rather than being coerced to a number.
 */
export function isUsableForAverage(
  ratio: number | null,
  state: BoState,
): ratio is number {
  return ratio !== null && (state === 'NORMAL' || state === 'NO_BID');
}

/** Short human-readable label for a book state, used in tables and tooltips. */
export function boStateLabel(state: BoState): string {
  switch (state) {
    case 'NORMAL':
      return 'Two-sided';
    case 'NO_BID':
      return 'No bids';
    case 'NO_OFFER':
      return 'No offers';
    case 'EMPTY_BOOK':
      return 'No orders';
  }
}
