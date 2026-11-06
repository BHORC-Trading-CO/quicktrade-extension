/**
 * How much of CSFloat's `GET /api/v1/listings` bucket the live feed may spend (QUICK-231, R-E2, R-N6). One bucket per
 * user IP for the cookie session: the Market feed, Market search, Competitors' float / pattern / sticker reads and the
 * coefficient load all spend it; the owner measured it on 24.10 (M1) at 200 requests per ~32–43 min window.
 *
 * The extension relays every CSFloat answer, the page's and the feed's, so it keeps one ledger of that window and the
 * feed asks it before each request. The rules, in order:
 *  1. Priority: while a page request to CSFloat is in flight, and for `FEED_FOREGROUND_YIELD_MS` after it ends, the feed
 *     waits. A buy (QUICK-226) reserves requests ahead; reserved requests are not the feed's to spend.
 *  2. Share: the feed may spend at most `share` of what was left of the window when it first saw it, and at any moment
 *     at most `share` of what is left now, after a headroom and the reservations. Selling, Competitors and buying always
 *     keep the rest. The user picks the share on the Market page (10–90 % in steps of 10, default 60 %, stored per
 *     browser); the extension clamps whatever the page sends to `CSFLOAT_FEED_MIN_SHARE`–`CSFLOAT_FEED_MAX_SHARE`.
 *  3. Pacing: its allowance is spread evenly over the time left in the window, never faster than every 10 s.
 * Pure: the extension holds the ledger, tests drive it with a clock.
 */
import type { CsfloatRateLimit } from './csfloat-rate-limit';

/** The feed's share of the window when the page names none (or an unreadable one). */
export const CSFLOAT_FEED_DEFAULT_SHARE = 0.6;
/** The lowest and highest share the extension accepts from a page (it clamps to these). */
export const CSFLOAT_FEED_MIN_SHARE = 0.1;
export const CSFLOAT_FEED_MAX_SHARE = 0.9;
/** The fastest the general feed polls CSFloat, whatever the bucket allows. */
export const CSFLOAT_FEED_MIN_INTERVAL_MS = 10_000;
/** The pace while CSFloat's answers name no window (a missing or unreadable `x-ratelimit-*`). */
export const CSFLOAT_FEED_FALLBACK_INTERVAL_MS = 60_000;
/** How long the feed waits after the page's last request to the same marketplace ended. */
export const FEED_FOREGROUND_YIELD_MS = 5_000;
/** A window read longer ago than this is not trusted to pace by: the next feed answer reads it again. */
export const CSFLOAT_BUDGET_STALE_MS = 10 * 60_000;
/** Two answers whose reset differs by more than this belong to different windows. */
const WINDOW_JITTER_MS = 5_000;
/** After the window's reset, a moment more: the reset is in whole seconds. */
const RESET_MARGIN_MS = 2_000;

/** Requests of the window the feed never touches, on top of the others' share (the sale form's book-sized headroom). */
export function csfloatFeedHeadroom(limit: number): number {
  return Math.max(20, Math.ceil(limit * 0.1));
}

/** The page's share within 10–90 %; anything but a finite number is the default 60 %. */
export function clampCsfloatFeedShare(share: unknown): number {
  if (typeof share !== 'number' || !Number.isFinite(share)) return CSFLOAT_FEED_DEFAULT_SHARE;
  return Math.min(CSFLOAT_FEED_MAX_SHARE, Math.max(CSFLOAT_FEED_MIN_SHARE, share));
}

/** `share` of `requests`, whole requests down; the epsilon keeps 0.7 × 180 at 126 (the double is 125.999…). */
function shareOf(share: number, requests: number): number {
  return Math.floor(share * requests + 1e-9);
}

/** The pace of an allowance: spread evenly over the time left in the window, never faster than every 10 s. */
export function csfloatFeedIntervalMs(allowance: number, resetAt: number, now: number): number {
  return Math.max(CSFLOAT_FEED_MIN_INTERVAL_MS, Math.ceil(Math.max(0, resetAt - now) / Math.max(1, allowance)));
}

export interface CsfloatFeedLedger {
  /** The window the latest answer named (the lowest `remaining` of that window when answers crossed). */
  budget: CsfloatRateLimit | null;
  observedAt: number | null;
  /** What was left of the window when the ledger first saw it (before the request that told it, if the feed's). */
  windowBudget: number | null;
  /** The feed's requests in this window. */
  feedSpent: number;
  /** When the feed's last CSFloat request ended. */
  lastFeedAt: number | null;
  /** The feed's last answer named no window: pace by the fallback interval until one does. */
  headerless: boolean;
}

export const EMPTY_CSFLOAT_FEED_LEDGER: CsfloatFeedLedger = {
  budget: null,
  observedAt: null,
  windowBudget: null,
  feedSpent: 0,
  lastFeedAt: null,
  headerless: false,
};

/**
 * The ledger after one `/listings` answer: `budget` its parsed `x-ratelimit-*` (null without), `byFeed` whether the
 * feed sent it. A later reset starts a new window; answers of the same window keep the lowest `remaining`.
 */
export function observeCsfloatListingsAnswer(
  ledger: CsfloatFeedLedger,
  budget: CsfloatRateLimit | null,
  byFeed: boolean,
  now: number
): CsfloatFeedLedger {
  const spent = byFeed ? 1 : 0;
  const lastFeedAt = byFeed ? now : ledger.lastFeedAt;
  if (!budget) {
    return {
      ...ledger,
      feedSpent: ledger.feedSpent + spent,
      lastFeedAt,
      headerless: byFeed ? true : ledger.headerless,
    };
  }
  const previous = ledger.budget;
  const sameWindow =
    previous !== null &&
    ledger.windowBudget !== null &&
    Math.abs(budget.resetAt - previous.resetAt) <= WINDOW_JITTER_MS;
  if (sameWindow) {
    return {
      budget: { ...budget, remaining: Math.min(previous.remaining, budget.remaining) },
      observedAt: now,
      windowBudget: ledger.windowBudget,
      feedSpent: ledger.feedSpent + spent,
      lastFeedAt,
      headerless: false,
    };
  }
  // An answer of an older window arriving after a newer one changes nothing but the feed's own count.
  if (previous !== null && budget.resetAt < previous.resetAt - WINDOW_JITTER_MS) {
    return { ...ledger, lastFeedAt };
  }
  return {
    budget,
    observedAt: now,
    windowBudget: Math.min(budget.limit, budget.remaining + spent),
    feedSpent: spent,
    lastFeedAt,
    headerless: false,
  };
}

/** What the page and higher-priority work are doing to CSFloat right now. */
export interface CsfloatFeedContext {
  share: number;
  /** Requests reserved by a buy (QUICK-226) and not released. */
  reserved: number;
  /** Page requests to CSFloat in flight. */
  foregroundInFlight: number;
  /** When the page's last CSFloat request ended. */
  lastForegroundAt: number | null;
  now: number;
}

export type CsfloatFeedDecision =
  | { kind: 'send'; intervalMs: number | null; allowance: number | null }
  | {
      kind: 'wait';
      until: number;
      reason: 'foreground' | 'budget' | 'interval';
      intervalMs: number | null;
      allowance: number | null;
    };

/** The requests the feed may still send in the ledger's window; null when the window is unknown or over. */
export function csfloatFeedAllowance(
  ledger: CsfloatFeedLedger,
  { share, reserved, now }: Pick<CsfloatFeedContext, 'share' | 'reserved' | 'now'>
): number | null {
  const { budget, observedAt, windowBudget } = ledger;
  if (!budget || observedAt === null || windowBudget === null) return null;
  // The reset is in whole seconds: the window counts as over only a moment after it.
  if (budget.resetAt + RESET_MARGIN_MS <= now || now - observedAt > CSFLOAT_BUDGET_STALE_MS) return null;
  const capped = clampCsfloatFeedShare(share);
  const headroom = csfloatFeedHeadroom(budget.limit);
  const ofWindow = shareOf(capped, Math.max(0, windowBudget - headroom)) - ledger.feedSpent;
  const ofNow = shareOf(capped, Math.max(0, budget.remaining - headroom - Math.max(0, reserved)));
  return Math.max(0, Math.min(ofWindow, ofNow));
}

/**
 * Whether the feed may send its next CSFloat request now, and its pace. A window it knows paces it by the allowance;
 * an unknown, stale or ended window lets one request through to read it again (the fallback pace when answers name
 * none); a spent allowance waits for the reset.
 */
export function decideCsfloatFeed(ledger: CsfloatFeedLedger, context: CsfloatFeedContext): CsfloatFeedDecision {
  const { now, foregroundInFlight, lastForegroundAt } = context;
  const allowance = csfloatFeedAllowance(ledger, context);
  const { budget } = ledger;
  let intervalMs: number | null;
  if (allowance === null) {
    intervalMs = ledger.headerless ? CSFLOAT_FEED_FALLBACK_INTERVAL_MS : null;
  } else if (allowance <= 0 || !budget) {
    return {
      kind: 'wait',
      until: (budget?.resetAt ?? now) + RESET_MARGIN_MS,
      reason: 'budget',
      intervalMs: null,
      allowance: 0,
    };
  } else {
    intervalMs = csfloatFeedIntervalMs(allowance, budget.resetAt, now);
  }
  if (foregroundInFlight > 0) return { kind: 'wait', until: now + 1_000, reason: 'foreground', intervalMs, allowance };
  if (lastForegroundAt !== null && now < lastForegroundAt + FEED_FOREGROUND_YIELD_MS) {
    return {
      kind: 'wait',
      until: lastForegroundAt + FEED_FOREGROUND_YIELD_MS,
      reason: 'foreground',
      intervalMs,
      allowance,
    };
  }
  const pace = intervalMs ?? CSFLOAT_FEED_MIN_INTERVAL_MS;
  if (ledger.lastFeedAt !== null && now < ledger.lastFeedAt + pace) {
    return { kind: 'wait', until: ledger.lastFeedAt + pace, reason: 'interval', intervalMs, allowance };
  }
  return { kind: 'send', intervalMs, allowance };
}

/** True for a CSFloat request that spends the `/listings` bucket (search, feed, Competitors' reads, coefficients). */
export function isCsfloatListingsBucket(url: string, method: string | undefined): boolean {
  if ((method ?? 'GET').toUpperCase() !== 'GET') return false;
  try {
    const parsed = new URL(url);
    return parsed.host === 'csfloat.com' && parsed.pathname === '/api/v1/listings';
  } catch {
    return false;
  }
}
