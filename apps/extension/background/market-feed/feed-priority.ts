// apps/extension/background/market-feed/feed-priority.ts
//
// QUICK-231 (R-E2, R-N6): selling, Competitors, Market search and buying go first; the live feed takes what they leave.
// Every request the page sends to CSFloat or cs.money passes `beginForegroundRequest` (handlers/site.ts): while one runs,
// and for a moment after, the feed waits, and every CSFloat `/listings` answer, the page's or the feed's, updates the one
// ledger of that window the feed paces by (`market-feed-budget.ts` in contracts). A buy (QUICK-226) reserves requests
// ahead with `reserveCsfloatBudget` and wraps its own requests in `beginForegroundRequest` too.
import type { CsfloatFeedLedger, MarketFeedAnswer, MarketFeedPlatform } from '@qts/contracts';
import { detectMarketFeedIssue, EMPTY_CSFLOAT_FEED_LEDGER, isCsfloatListingsBucket, observeCsfloatListingsAnswer, parseCsfloatRateLimit } from '@qts/contracts';

export interface ForegroundActivity {
  /** Page (or buy) requests to the platform in flight. */
  inFlight: number;
  /** When the last one ended. */
  lastAt: number | null;
  /** The page met a captcha, a limit or a block here: the feed asks nothing before this (epoch ms). */
  blockedUntil: number | null;
}

/** A page answer that met a captcha, a limit or a block holds the feed back this long when it names no reset. */
export const FOREGROUND_BLOCK_MS = 60_000;

type ForegroundAnswer = Partial<MarketFeedAnswer>;

const activity: Record<MarketFeedPlatform, ForegroundActivity> = {
  'csfloat.com': { inFlight: 0, lastAt: null, blockedUntil: null },
  'cs.money': { inFlight: 0, lastAt: null, blockedUntil: null },
};
let ledger: CsfloatFeedLedger = EMPTY_CSFLOAT_FEED_LEDGER;
const reservations = new Map<number, { requests: number; until: number }>();
let nextReservationId = 1;
const settledListeners = new Set<() => void>();
let clock: () => number = () => Date.now();

function feedPlatform(platform: string): MarketFeedPlatform | null {
  return platform === 'csfloat.com' || platform === 'cs.money' ? platform : null;
}

function settled(): void {
  for (const listener of settledListeners) {
    try {
      listener();
    } catch {
      // A listener's failure must not break the page's request.
    }
  }
}

/**
 * Marks a request the page or a buy sends to CSFloat or cs.money as running: the feed of that marketplace waits until it
 * ends and `FEED_FOREGROUND_YIELD_MS` more. `end` takes the answer so a CSFloat `/listings` answer updates the ledger.
 * Requests to other platforms are not tracked. `end` is safe to call once; later calls do nothing.
 */
export function beginForegroundRequest(platform: string, request: { url?: unknown; method?: unknown }): { end: (answer?: ForegroundAnswer) => void } {
  const target = feedPlatform(platform);
  if (!target) return { end: () => undefined };
  const url = typeof request.url === 'string' ? request.url : '';
  const method = typeof request.method === 'string' ? request.method : 'GET';
  const listings = target === 'csfloat.com' && isCsfloatListingsBucket(url, method);
  activity[target].inFlight += 1;
  let ended = false;
  return {
    end(answer) {
      if (ended) return;
      ended = true;
      const now = clock();
      activity[target].inFlight = Math.max(0, activity[target].inFlight - 1);
      activity[target].lastAt = now;
      // A request that never reached the marketplace (refused, no access) tells nothing.
      if (answer && (answer.status ?? 0) > 0) {
        if (listings) {
          const budget = parseCsfloatRateLimit(answer.headers);
          if (budget) ledger = observeCsfloatListingsAnswer(ledger, budget, false, now);
        }
        // The page's own captcha or limit: one exit (the user's IP), so the feed must not add to it.
        const issue = detectMarketFeedIssue(target, { ok: answer.ok ?? false, status: answer.status ?? 0, data: answer.data, headers: answer.headers }, now);
        if (issue && (issue.kind === 'captcha' || issue.kind === 'rate-limited' || issue.kind === 'blocked')) {
          const until = issue.resetAt !== undefined && issue.resetAt > now ? issue.resetAt : now + FOREGROUND_BLOCK_MS;
          activity[target].blockedUntil = Math.max(activity[target].blockedUntil ?? 0, until);
        }
      }
      settled();
    },
  };
}

/**
 * Holds `requests` of CSFloat's `/listings` window for higher-priority work (a buy's re-read, QUICK-226) until released
 * or `ttlMs` passes: the feed's allowance leaves them out. Returns the release.
 */
export function reserveCsfloatBudget(requests: number, ttlMs = 60_000): () => void {
  const id = nextReservationId++;
  reservations.set(id, { requests: Math.max(0, Math.floor(requests)), until: clock() + Math.max(0, ttlMs) });
  return () => {
    if (reservations.delete(id)) settled();
  };
}

export function reservedCsfloatRequests(now: number): number {
  let total = 0;
  for (const [id, reservation] of reservations) {
    if (reservation.until <= now) reservations.delete(id);
    else total += reservation.requests;
  }
  return total;
}

/** The feed's own CSFloat `/listings` answer (any status that reached CSFloat). */
export function recordFeedCsfloatAnswer(headers: Record<string, string> | undefined, now: number): void {
  ledger = observeCsfloatListingsAnswer(ledger, parseCsfloatRateLimit(headers), true, now);
}

export function csfloatFeedLedger(): CsfloatFeedLedger {
  return ledger;
}

/** The ledger as the worker stored it before it was stopped (storage.session), read once at start. */
export function restoreCsfloatFeedLedger(saved: CsfloatFeedLedger | null | undefined): void {
  if (saved && typeof saved === 'object' && ledger === EMPTY_CSFLOAT_FEED_LEDGER) ledger = { ...EMPTY_CSFLOAT_FEED_LEDGER, ...saved };
}

export function foregroundActivity(platform: MarketFeedPlatform): Readonly<ForegroundActivity> {
  return activity[platform];
}

/** Called after every page request ends and every reservation is released: the feed plans again. */
export function onForegroundSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

/** Tests only: a fresh state and an injected clock. */
export function resetFeedPriorityForTests(now: () => number = () => Date.now()): void {
  clock = now;
  ledger = EMPTY_CSFLOAT_FEED_LEDGER;
  reservations.clear();
  settledListeners.clear();
  for (const platform of Object.keys(activity) as MarketFeedPlatform[]) activity[platform] = { inFlight: 0, lastAt: null, blockedUntil: null };
}
