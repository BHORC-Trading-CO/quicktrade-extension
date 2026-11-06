/**
 * The buy-attempt journal on the QTS server (QUICK-226, R-C5): one row per attempt under the account's `clerkId`, written
 * before the extension sends anything (`pending`) and settled with the executor's result. For support, statistics and
 * the buy-order budget: platform, listing, item, confirmed price in cents, who asked, the outcome and the raw status
 * of the market's answer with a trimmed, cookie-free digest of its body. The server imports this module as types only
 * and repeats the value lists; a typed copy fails on drift.
 */
import type { MarketBuyOutcome } from './market-buy';
import type { MarketSource } from './market-views';

/** `pending` until the result arrives; a pending row older than `MARKET_BUY_PENDING_STALE_MS` counts as `unknown`. */
export type MarketBuyAttemptState = 'pending' | MarketBuyOutcome;

/** `POST /api/market/buy-attempts`: opened right before the page asks the extension to buy. */
export interface MarketBuyAttemptOpen {
  /** The attempt's UUID (the executor's replay key too). Opening the same id twice is answered with the first row. */
  attemptId: string;
  source: MarketSource;
  listingId: string;
  marketHashName: string;
  /** The item's float, when it has one. */
  floatValue?: number;
  /** The confirmed price, USD cents. */
  priceCents: number;
  origin: 'manual' | 'buy_order';
  /** The buy-order rule (`origin: 'buy_order'`). */
  ruleId?: string;
  /** When QTS first read the listing (epoch ms, the browser's clock). */
  seenAt?: number;
  /** When this request was sent (epoch ms, the browser's clock): the server converts `seenAt` to its own clock. */
  sentAt: number;
}

export interface MarketBuyAttemptOpenResponse {
  attemptId: string;
  state: MarketBuyAttemptState;
  /** False when the attempt was already open (a repeat of the same `attemptId`). */
  created: boolean;
}

/** `POST /api/market/buy-attempts/:attemptId/result`: the executor's result. Repeating the same outcome is a no-op. */
export interface MarketBuyAttemptSettle {
  outcome: MarketBuyOutcome;
  /** Whether the buy request itself left the browser. */
  sent: boolean;
  reason?: string;
  /** HTTP status of the buy request's answer (0 = none). */
  rawStatus?: number;
  /** The marketplace's own error code. */
  rawCode?: string;
  /** `buyAnswerDigest` of the answer: allow-listed fields only, ≤ 2 KiB. */
  rawBody?: string;
  newPriceCents?: number;
  /** From `seenAt` to the buy request (ms), both on the browser's clock. */
  msFromSeenToRequest?: number;
}

export interface MarketBuyAttemptRow {
  attemptId: string;
  source: MarketSource;
  listingId: string;
  marketHashName: string;
  floatValue: number | null;
  priceCents: number;
  origin: 'manual' | 'buy_order';
  ruleId: string | null;
  state: MarketBuyAttemptState;
  sent: boolean | null;
  reason: string | null;
  rawStatus: number | null;
  rawCode: string | null;
  rawBody: string | null;
  newPriceCents: number | null;
  msFromSeenToRequest: number | null;
  /** ISO times on the server's clock. */
  seenAt: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** `GET /api/market/buy-attempts`: the account's newest attempts, newest first. */
export interface MarketBuyAttemptsResponse {
  attempts: MarketBuyAttemptRow[];
}

/** A pending row older than this is settled as `unknown` (`reason: expired`) and no longer holds its listing. */
export const MARKET_BUY_PENDING_STALE_MS = 3 * 60_000;
/** How many rows `GET /api/market/buy-attempts` answers. */
export const MARKET_BUY_ATTEMPTS_READ_LIMIT = 50;
/** Rows are kept this long. */
export const MARKET_BUY_ATTEMPT_RETAIN_MS = 400 * 86_400_000;
