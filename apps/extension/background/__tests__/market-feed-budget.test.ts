import type { CsfloatFeedLedger, CsfloatRateLimit } from '@qts/contracts';
import {
  clampCsfloatFeedShare,
  CSFLOAT_FEED_DEFAULT_SHARE,
  CSFLOAT_FEED_FALLBACK_INTERVAL_MS,
  CSFLOAT_FEED_MAX_SHARE,
  CSFLOAT_FEED_MIN_INTERVAL_MS,
  CSFLOAT_FEED_MIN_SHARE,
  csfloatFeedAllowance,
  csfloatFeedHeadroom,
  csfloatFeedIntervalMs,
  decideCsfloatFeed,
  EMPTY_CSFLOAT_FEED_LEDGER,
  FEED_FOREGROUND_YIELD_MS,
  isCsfloatListingsBucket,
  observeCsfloatListingsAnswer,
} from '@qts/contracts';
import { describe, expect, it } from 'vitest';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const window = (remaining: number, resetIn = 40 * MIN, limit = 200): CsfloatRateLimit => ({ limit, remaining, resetAt: NOW + resetIn });
const context = (patch: Partial<Parameters<typeof decideCsfloatFeed>[1]> = {}) => ({
  share: 0.6,
  reserved: 0,
  foregroundInFlight: 0,
  lastForegroundAt: null,
  now: NOW,
  ...patch,
});

describe('CSFloat feed budget (QUICK-231, R-E2)', () => {
  it('paces the owner-measured window (200 per ~40 min) at about 22 s with a 60 % share', () => {
    const ledger = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(199), true, NOW);
    expect(ledger.windowBudget).toBe(200);
    expect(ledger.feedSpent).toBe(1);
    // floor(0.6 × (200 − 20)) − 1 = 107 left over 40 minutes.
    expect(csfloatFeedAllowance(ledger, context())).toBe(107);
    const decision = decideCsfloatFeed({ ...ledger, lastFeedAt: NOW - 30_000 }, context());
    expect(decision).toMatchObject({ kind: 'send', allowance: 107 });
    expect(decision.intervalMs).toBe(Math.ceil((40 * MIN) / 107));
    expect(decision.intervalMs).toBeGreaterThan(20_000);
    expect(decision.intervalMs).toBeLessThan(25_000);
  });

  it('never lets the feed spend more than its share of the window, however long it runs (R-N6)', () => {
    let ledger: CsfloatFeedLedger = EMPTY_CSFLOAT_FEED_LEDGER;
    let remaining = 200;
    const resetAt = NOW + 40 * MIN;
    let sent = 0;
    for (let t = NOW; t < resetAt; t += 1_000) {
      const decision = decideCsfloatFeed(ledger, context({ now: t }));
      if (decision.kind !== 'send') continue;
      remaining -= 1;
      sent += 1;
      ledger = observeCsfloatListingsAnswer(ledger, { limit: 200, remaining, resetAt }, true, t);
    }
    expect(sent).toBeLessThanOrEqual(Math.floor(0.6 * (200 - 20)));
    // The others keep at least 40 % of the window plus the headroom.
    expect(remaining).toBeGreaterThanOrEqual(200 - Math.floor(0.6 * 180));
  });

  it('shrinks with what the page spends: at most 60 % of what is left now', () => {
    let ledger = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(199), true, NOW);
    // Competitors and Market search spent 120 more.
    ledger = observeCsfloatListingsAnswer(ledger, window(79), false, NOW + 1_000);
    expect(ledger.budget?.remaining).toBe(79);
    expect(csfloatFeedAllowance(ledger, context({ now: NOW + 1_000 }))).toBe(Math.floor(0.6 * (79 - 20)));
    // Down to the headroom: the feed waits for the reset.
    ledger = observeCsfloatListingsAnswer(ledger, window(20), false, NOW + 2_000);
    expect(decideCsfloatFeed(ledger, context({ now: NOW + 2_000 }))).toMatchObject({ kind: 'wait', reason: 'budget', until: NOW + 40 * MIN + 2_000 });
  });

  it('leaves a buy its reserved requests', () => {
    const ledger = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(100), false, NOW);
    expect(csfloatFeedAllowance(ledger, context({ reserved: 0 }))).toBe(48);
    expect(csfloatFeedAllowance(ledger, context({ reserved: 50 }))).toBe(18);
    expect(decideCsfloatFeed(ledger, context({ reserved: 80 }))).toMatchObject({ kind: 'wait', reason: 'budget' });
  });

  it('waits while the page asks CSFloat and for 5 s after (priority)', () => {
    const ledger = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(150), false, NOW);
    expect(decideCsfloatFeed(ledger, context({ foregroundInFlight: 1 }))).toMatchObject({ kind: 'wait', reason: 'foreground', until: NOW + 1_000 });
    expect(decideCsfloatFeed(ledger, context({ lastForegroundAt: NOW - 2_000 }))).toMatchObject({
      kind: 'wait',
      reason: 'foreground',
      until: NOW - 2_000 + FEED_FOREGROUND_YIELD_MS,
    });
    expect(decideCsfloatFeed(ledger, context({ lastForegroundAt: NOW - FEED_FOREGROUND_YIELD_MS }))).toMatchObject({ kind: 'send' });
  });

  it('clamps the page’s share to 10–90 % and reads anything but a number as the default 60 %', () => {
    expect([CSFLOAT_FEED_MIN_SHARE, CSFLOAT_FEED_DEFAULT_SHARE, CSFLOAT_FEED_MAX_SHARE]).toEqual([0.1, 0.6, 0.9]);
    expect(clampCsfloatFeedShare(0.05)).toBe(0.1);
    expect(clampCsfloatFeedShare(0.95)).toBe(0.9);
    expect(clampCsfloatFeedShare(Number.NaN)).toBe(0.6);
    expect(clampCsfloatFeedShare(Number.POSITIVE_INFINITY)).toBe(0.6);
    expect(clampCsfloatFeedShare(undefined)).toBe(0.6);
    expect(clampCsfloatFeedShare('0.9')).toBe(0.6);
    expect(clampCsfloatFeedShare(1)).toBe(0.9);
    expect(clampCsfloatFeedShare(0)).toBe(0.1);
    expect(clampCsfloatFeedShare(0.3)).toBe(0.3);
    const ledger = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(200), false, NOW);
    expect(csfloatFeedAllowance(ledger, context({ share: 1 }))).toBe(Math.floor(0.9 * 180));
    expect(csfloatFeedAllowance(ledger, context({ share: 0.01 }))).toBe(Math.floor(0.1 * 180));
  });

  it('takes 10 %, 60 % and 90 % of the same window after the same headroom', () => {
    const fresh = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(200), false, NOW);
    expect(csfloatFeedHeadroom(200)).toBe(20);
    // share × (200 − 20): 18, 108, 162; and 0.7 × 180 is 126, not the double's 125.999….
    expect([0.1, 0.6, 0.7, 0.9].map((share) => csfloatFeedAllowance(fresh, context({ share })))).toEqual([18, 108, 126, 162]);
    // What the page spent and a buy's reservation come off before the share, at every share.
    const spent = observeCsfloatListingsAnswer(fresh, window(120), false, NOW + 1_000);
    expect([0.1, 0.6, 0.9].map((share) => csfloatFeedAllowance(spent, context({ share, reserved: 10, now: NOW + 1_000 })))).toEqual([9, 54, 81]);
    // Down to the headroom, no share lets the feed in.
    const low = observeCsfloatListingsAnswer(fresh, window(21), false, NOW + 2_000);
    expect(decideCsfloatFeed(low, context({ share: 0.9, now: NOW + 2_000 }))).toMatchObject({ kind: 'wait', reason: 'budget' });
    // The pace over 40 minutes: about every 2:13, 22 s and 15 s.
    expect([18, 108, 162].map((allowance) => csfloatFeedIntervalMs(allowance, NOW + 40 * MIN, NOW))).toEqual([133_334, 22_223, 14_815]);
    expect(csfloatFeedIntervalMs(1_000, NOW + 40 * MIN, NOW)).toBe(CSFLOAT_FEED_MIN_INTERVAL_MS);
  });

  it('still yields to the page at 90 %', () => {
    const ledger = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(150), false, NOW);
    const share = 0.9;
    expect(decideCsfloatFeed(ledger, context({ share, foregroundInFlight: 1 }))).toMatchObject({ kind: 'wait', reason: 'foreground' });
    expect(decideCsfloatFeed(ledger, context({ share, lastForegroundAt: NOW - 1_000 }))).toMatchObject({ kind: 'wait', reason: 'foreground' });
    expect(decideCsfloatFeed(ledger, context({ share, reserved: 129 }))).toMatchObject({ kind: 'wait', reason: 'budget' });
  });

  it('probes an unknown, stale or ended window once per 10 s; without headers it slows to 60 s', () => {
    expect(decideCsfloatFeed(EMPTY_CSFLOAT_FEED_LEDGER, context())).toMatchObject({ kind: 'send', intervalMs: null });
    const probed = { ...EMPTY_CSFLOAT_FEED_LEDGER, lastFeedAt: NOW - 3_000 };
    expect(decideCsfloatFeed(probed, context())).toMatchObject({ kind: 'wait', reason: 'interval', until: NOW - 3_000 + CSFLOAT_FEED_MIN_INTERVAL_MS });
    const headerless = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, null, true, NOW);
    expect(headerless.headerless).toBe(true);
    expect(decideCsfloatFeed(headerless, context({ now: NOW + 20_000 }))).toMatchObject({ kind: 'wait', until: NOW + CSFLOAT_FEED_FALLBACK_INTERVAL_MS });
    const ended = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(0, 1_000), true, NOW);
    expect(decideCsfloatFeed(ended, context({ now: NOW + 12_000 }))).toMatchObject({ kind: 'send' });
  });

  it('starts a new window on a later reset and ignores an older window arriving late', () => {
    let ledger = observeCsfloatListingsAnswer(EMPTY_CSFLOAT_FEED_LEDGER, window(5), true, NOW);
    ledger = observeCsfloatListingsAnswer(ledger, { limit: 200, remaining: 199, resetAt: NOW + 80 * MIN }, true, NOW + 41 * MIN);
    expect(ledger).toMatchObject({ windowBudget: 200, feedSpent: 1, budget: { remaining: 199 } });
    const late = observeCsfloatListingsAnswer(ledger, window(3), false, NOW + 41 * MIN);
    expect(late.budget?.remaining).toBe(199);
    // Crossed answers of one window keep the lowest remaining.
    const crossed = observeCsfloatListingsAnswer(ledger, { limit: 200, remaining: 199 + 0, resetAt: NOW + 80 * MIN + 1_000 }, false, NOW + 41 * MIN);
    expect(crossed.budget?.remaining).toBe(199);
  });

  it('knows which requests spend the /listings bucket', () => {
    expect(isCsfloatListingsBucket('https://csfloat.com/api/v1/listings?limit=50', 'GET')).toBe(true);
    expect(isCsfloatListingsBucket('https://csfloat.com/api/v1/listings/123', 'GET')).toBe(false);
    expect(isCsfloatListingsBucket('https://csfloat.com/api/v1/listings', 'POST')).toBe(false);
    expect(isCsfloatListingsBucket('not a url', 'GET')).toBe(false);
    expect(csfloatFeedHeadroom(200)).toBe(20);
    expect(csfloatFeedHeadroom(50_000)).toBe(5_000);
  });
});
