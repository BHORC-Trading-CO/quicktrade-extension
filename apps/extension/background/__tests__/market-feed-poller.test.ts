import type { MarketFeedConfig, MarketFeedUpdate } from '@qts/contracts';
import { matchPlatformOperation } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMarketFeed, CSMONEY_FEED_GAP_MS, CSMONEY_FEED_INTERVAL_MS, type MarketFeedDeps } from '../market-feed/feed-poller';
import { beginForegroundRequest, csfloatFeedLedger, foregroundActivity, reserveCsfloatBudget, resetFeedPriorityForTests } from '../market-feed/feed-priority';
import type { ProxyOptions, ProxyResult } from '../proxy';
import { CSFLOAT_FEED_URL, csfloatHeaders, csfloatRow, CSMONEY_BOTS_FEED_URL, CSMONEY_MARKET_FEED_URL, csMoneyBotRow, csMoneyMarketRow } from './market-feed-fixtures';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
const TAB = 7;

type Answer = (now: number) => ProxyResult;

interface Harness {
  feed: ReturnType<typeof createMarketFeed>;
  calls: Array<{ url: string; at: number; options: ProxyOptions }>;
  pushes: Array<{ tabId: number; update: MarketFeedUpdate }>;
  saved: unknown[];
  answers: Map<string, Answer>;
  watchdog: boolean[];
}

const ok = (data: unknown, headers: Record<string, string> = {}): ProxyResult => ({ ok: true, status: 200, data, headers: { 'content-type': 'application/json', ...headers } });

/** CSFloat's window: 200 per 40 min from T0, shared by every caller of `spendCsfloat`. */
let bucket = { remaining: 200, resetAt: T0 + 40 * MIN };
function spendCsfloat(now: number, data: unknown): ProxyResult {
  if (bucket.remaining <= 0) return { ok: false, status: 429, data: { message: 'too many' }, headers: csfloatHeaders(0, bucket.resetAt, now) };
  bucket.remaining -= 1;
  return ok(data, csfloatHeaders(bucket.remaining, bucket.resetAt, now));
}

let csfloatSeq = 0;
/** Each CSFloat feed answer: two new listings on top of the last page. */
function csfloatPage(now: number): unknown {
  csfloatSeq += 2;
  return { data: [csfloatRow(String(csfloatSeq), now - 3 * SEC), csfloatRow(String(csfloatSeq - 1), now - 6 * SEC), csfloatRow('0', T0 - 60 * SEC)], cursor: 'c' };
}

function harness(load: unknown = undefined): Harness {
  const calls: Harness['calls'] = [];
  const pushes: Harness['pushes'] = [];
  const saved: unknown[] = [];
  const watchdog: boolean[] = [];
  const answers = new Map<string, Answer>([
    [CSFLOAT_FEED_URL, (now) => spendCsfloat(now, csfloatPage(now))],
    [CSMONEY_MARKET_FEED_URL, (now) => ok({ items: [csMoneyMarketRow(Math.floor(now / SEC), 4.2)] })],
    [CSMONEY_BOTS_FEED_URL, (now) => ok({ items: [csMoneyBotRow(Math.floor(now / SEC), 3.1)], nextCursor: 'n' })],
  ]);
  const deps: MarketFeedDeps = {
    proxy: async (url, options) => {
      calls.push({ url, at: Date.now(), options });
      const answer = answers.get(url);
      return answer ? answer(Date.now()) : { ok: false, status: 404, data: null };
    },
    resolve: async (platform, request, purpose) => matchPlatformOperation(platform, request, { purpose }),
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    load: async () => load,
    save: async (snapshot) => {
      saved.push(JSON.parse(JSON.stringify(snapshot)));
    },
    push: async (tabId, update) => {
      pushes.push({ tabId, update });
      return true;
    },
    watchdog: async (on) => {
      watchdog.push(on);
    },
    keepAlive: async () => undefined,
  };
  return { feed: createMarketFeed(deps), calls, pushes, saved, answers, watchdog };
}

function config(sources: Array<'csfloat' | 'csmoney-market' | 'csmoney-bots'> = ['csfloat', 'csmoney-market', 'csmoney-bots'], csfloatShare?: number): MarketFeedConfig {
  const urls = { csfloat: CSFLOAT_FEED_URL, 'csmoney-market': CSMONEY_MARKET_FEED_URL, 'csmoney-bots': CSMONEY_BOTS_FEED_URL };
  return {
    sources: sources.map((source) => ({ source, request: { url: urls[source], method: 'GET' } })),
    ...(csfloatShare === undefined ? {} : { csfloatShare }),
  };
}

const callsTo = (h: Harness, url: string) => h.calls.filter((call) => call.url === url).map((call) => call.at - T0);

/** Time passes with the page open: it reads the feed every 30 s, which renews its lease. */
async function openFor(h: Harness, ms: number, tabId = TAB): Promise<void> {
  for (let left = ms; left > 0; left -= 30 * SEC) {
    await vi.advanceTimersByTimeAsync(Math.min(30 * SEC, left));
    await h.feed.read({ requestId: 'heartbeat' }, tabId);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  resetFeedPriorityForTests(() => Date.now());
  bucket = { remaining: 200, resetAt: T0 + 40 * MIN };
  csfloatSeq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Market live feed: start (QUICK-231)', () => {
  it('refuses a config whose request is not its source’s own schedulable feed operation', async () => {
    const h = harness();
    const filtered = { sources: [{ source: 'csfloat', request: { url: `${CSFLOAT_FEED_URL}&market_hash_name=AK`, method: 'GET' } }] };
    expect((await h.feed.start({ requestId: 'r1', config: filtered }, TAB)).error).toBe('operation_refused');
    const swapped = { sources: [{ source: 'csfloat', request: { url: CSMONEY_BOTS_FEED_URL, method: 'GET' } }] };
    expect((await h.feed.start({ requestId: 'r2', config: swapped }, TAB)).error).toBe('operation_refused');
    expect((await h.feed.start({ requestId: 'r3', config: { sources: [{ source: 'csfloat', request: { url: CSFLOAT_FEED_URL, method: 'POST' } }] } }, TAB)).error).toBe('invalid_config');
    expect((await h.feed.start({ requestId: 'r4', config: { sources: [] } }, TAB)).error).toBe('no_sources');
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(h.calls).toEqual([]);
  });

  it('reads every source in the background as a scheduled check, echoing the request id', async () => {
    const h = harness();
    const answer = await h.feed.start({ requestId: 'start-1', config: config() }, TAB);
    expect(answer).toMatchObject({ requestId: 'start-1', state: { running: true } });
    await vi.advanceTimersByTimeAsync(SEC);
    expect(h.calls.map((call) => [call.url, call.options])).toEqual([
      [CSFLOAT_FEED_URL, { method: 'GET', platform: 'csfloat.com', purpose: 'schedule-check' }],
      [CSMONEY_MARKET_FEED_URL, { method: 'GET', platform: 'cs.money', purpose: 'schedule-check' }],
    ]);
    expect(h.watchdog).toEqual([true]);
  });
});

describe('Market live feed: pacing', () => {
  it('reads each cs.money source every 10 s, the two 5 s apart', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csmoney-market', 'csmoney-bots']) }, TAB);
    await vi.advanceTimersByTimeAsync(31 * SEC);
    expect(callsTo(h, CSMONEY_MARKET_FEED_URL)).toEqual([0, 10, 20, 30].map((s) => s * SEC));
    expect(callsTo(h, CSMONEY_BOTS_FEED_URL)).toEqual([5, 15, 25].map((s) => s * SEC));
    const all = h.calls.map((call) => call.at);
    for (let i = 1; i < all.length; i += 1) expect((all[i] ?? 0) - (all[i - 1] ?? 0)).toBeGreaterThanOrEqual(CSMONEY_FEED_GAP_MS);
    expect(CSMONEY_FEED_INTERVAL_MS).toBe(10 * SEC);
  });

  it('paces CSFloat by its window: the first answer names it, then about every 22 s', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csfloat']) }, TAB);
    await vi.advanceTimersByTimeAsync(70 * SEC);
    const at = callsTo(h, CSFLOAT_FEED_URL);
    expect(at[0]).toBe(0);
    expect(at.length).toBe(4);
    for (let i = 1; i < at.length; i += 1) {
      const gap = (at[i] ?? 0) - (at[i - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(21 * SEC);
      expect(gap).toBeLessThanOrEqual(24 * SEC);
    }
    const state = h.feed.state();
    expect(state.platforms['csfloat.com']).toMatchObject({ status: 'running' });
    expect(state.platforms['csfloat.com'].intervalMs).toBeLessThan(40 * SEC);
    expect(state.coverageAtRisk).toBe(false);
    expect(state.csfloatBudget).toMatchObject({ limit: 200, windowBudget: 200, feedSpent: 4 });
  });

  it('takes a new share from the page at once, keeping its sources, and clamps it to 10–90 %', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csfloat'], 0.9) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    // floor(0.9 × (200 − 20)) − 1 = 161 over 40 minutes: about every 15 s.
    expect(h.feed.state()).toMatchObject({ csfloatShare: 0.9, csfloatBudget: { feedSpent: 1, feedAllowance: 161 } });
    const lower = await h.feed.start({ requestId: 'r2', config: config(['csfloat'], 0.2) }, TAB);
    expect(lower.state).toMatchObject({ csfloatShare: 0.2, csfloatBudget: { feedAllowance: 35 }, sources: { csfloat: { polls: 1 } } });
    // Planned again as the start returns: 35 requests over the 39:59 left.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.feed.state().platforms['csfloat.com'].intervalMs).toBe(Math.ceil((40 * MIN - SEC) / 35));
    expect(callsTo(h, CSFLOAT_FEED_URL)).toEqual([0]);
    expect((await h.feed.start({ requestId: 'r3', config: config(['csfloat'], 0.95) }, TAB)).state?.csfloatShare).toBe(0.9);
    expect((await h.feed.start({ requestId: 'r4', config: config(['csfloat'], Number.NaN) }, TAB)).state?.csfloatShare).toBe(0.6);
  });

  it('warns about coverage once the page has spent enough that CSFloat polls slower than 40 s', async () => {
    const h = harness();
    bucket.remaining = 60;
    await h.feed.start({ requestId: 'r', config: config(['csfloat']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    const state = h.feed.state();
    // floor(0.6 × (60 − 20)) − 1 = 23 requests over ~40 min: about every 104 s.
    expect(state.platforms['csfloat.com'].intervalMs).toBeGreaterThan(40 * SEC);
    expect(state.coverageAtRisk).toBe(true);
  });
});

describe('Market live feed: priority (R-E2, R-N6)', () => {
  it('never sends to CSFloat while a page request runs or within 5 s after it', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csfloat']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    expect(callsTo(h, CSFLOAT_FEED_URL)).toEqual([0]);
    // Competitors asks at 20 s and its answer takes 4 s.
    await vi.advanceTimersByTimeAsync(19 * SEC);
    const page = beginForegroundRequest('csfloat.com', { url: 'https://csfloat.com/api/v1/listings?limit=50&paint_seed=661', method: 'GET' });
    await vi.advanceTimersByTimeAsync(4 * SEC);
    expect(callsTo(h, CSFLOAT_FEED_URL)).toEqual([0]);
    page.end(spendCsfloat(Date.now(), { data: [] }));
    await vi.advanceTimersByTimeAsync(4 * SEC);
    expect(callsTo(h, CSFLOAT_FEED_URL)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(2 * SEC);
    expect(callsTo(h, CSFLOAT_FEED_URL)).toEqual([0, 29 * SEC]);
    // The page's answer counted in the shared window.
    expect(csfloatFeedLedger().budget?.remaining).toBe(197);
  });

  it('leaves a buy its reservation', async () => {
    const h = harness();
    bucket.remaining = 120;
    await h.feed.start({ requestId: 'r', config: config(['csfloat']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    const release = reserveCsfloatBudget(100, 10 * MIN);
    await openFor(h, 5 * MIN);
    expect(callsTo(h, CSFLOAT_FEED_URL)).toEqual([0]);
    expect(h.feed.state().platforms['csfloat.com']).toMatchObject({ status: 'held', heldBy: 'budget' });
    release();
    await vi.advanceTimersByTimeAsync(SEC);
    expect(callsTo(h, CSFLOAT_FEED_URL).length).toBe(2);
  });

  it('a page captcha on cs.money holds the cs.money feed a minute', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csmoney-market']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    const page = beginForegroundRequest('cs.money', { url: 'https://cs.money/1.0/market/user-inventory', method: 'GET' });
    page.end({ ok: true, status: 200, data: { error: 4030 } });
    await vi.advanceTimersByTimeAsync(59 * SEC);
    expect(callsTo(h, CSMONEY_MARKET_FEED_URL)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(2 * SEC);
    expect(callsTo(h, CSMONEY_MARKET_FEED_URL)).toEqual([0, 61 * SEC]);
    expect(foregroundActivity('cs.money').inFlight).toBe(0);
  });

  // Measured (owner's window, 200 per 40 min): 60 % → the feed sends 99, the page's 79 all answer 200, the window ends
  // at 22; 90 % → the feed sends 105, the page's 79 all answer 200, the page itself spends into the headroom (ends at 16).
  it.each([
    { share: undefined, applied: 0.6, minLeft: 20 },
    { share: 0.9, applied: 0.9, minLeft: 10 },
  ])('over a whole 40-minute window with Competitors asking every 30 s at share $applied: the page never meets a limit and the feed stays in its share', async ({ share, applied, minLeft }) => {
    const h = harness();
    const pageAnswers: number[] = [];
    let feedDuringPage = 0;
    // The lowest the window was right after one of the feed's own requests.
    let lowestAfterFeed = Infinity;
    h.answers.set(CSFLOAT_FEED_URL, (now) => {
      const activity = foregroundActivity('csfloat.com');
      if (activity.inFlight > 0 || (activity.lastAt !== null && now < activity.lastAt + 5 * SEC)) feedDuringPage += 1;
      const answer = spendCsfloat(now, csfloatPage(now));
      lowestAfterFeed = Math.min(lowestAfterFeed, bucket.remaining);
      return answer;
    });
    await h.feed.start({ requestId: 'r', config: config(['csfloat'], share) }, TAB);
    expect(h.feed.state().csfloatShare).toBe(applied);
    for (let t = 0; t < 40 * MIN - 30 * SEC; t += 30 * SEC) {
      await vi.advanceTimersByTimeAsync(15 * SEC);
      const page = beginForegroundRequest('csfloat.com', { url: 'https://csfloat.com/api/v1/listings?limit=50&def_index=7', method: 'GET' });
      await vi.advanceTimersByTimeAsync(500);
      const answer = spendCsfloat(Date.now(), { data: [] });
      pageAnswers.push(answer.status);
      page.end(answer);
      await vi.advanceTimersByTimeAsync(14_500);
      // Keep the tab's lease, as the page's reads do.
      await h.feed.read({ requestId: 'hb', sinceSeq: 0 }, TAB);
    }
    const feedCalls = callsTo(h, CSFLOAT_FEED_URL).length;
    expect(pageAnswers).toHaveLength(79);
    expect(pageAnswers.every((status) => status === 200)).toBe(true);
    expect(feedDuringPage).toBe(0);
    expect(feedCalls).toBeLessThanOrEqual(Math.floor(applied * (200 - 20)));
    expect(feedCalls).toBeGreaterThan(40);
    // The feed never takes the window into the headroom; the page may spend it.
    expect(lowestAfterFeed).toBeGreaterThanOrEqual(20);
    expect(bucket.remaining).toBeGreaterThanOrEqual(minLeft);
  });
});

describe('Market live feed: captcha, limits and failures (R-E5)', () => {
  it('a cs.money captcha pauses only cs.money: 1, 5, 15, then every 15 minutes; CSFloat keeps going', async () => {
    const h = harness();
    h.answers.set(CSMONEY_MARKET_FEED_URL, () => ({ ok: false, status: 403, data: { errors: [{ code: 4030 }] }, headers: {} }));
    await h.feed.start({ requestId: 'r', config: config(['csfloat', 'csmoney-market']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    expect(h.feed.state().platforms['cs.money']).toMatchObject({ status: 'paused', attempts: 1, issue: { kind: 'captcha' }, retryAt: T0 + MIN });
    await openFor(h, 40 * MIN);
    const tries = callsTo(h, CSMONEY_MARKET_FEED_URL);
    const gaps = tries.slice(1).map((at, index) => at - (tries[index] ?? 0));
    expect(gaps.slice(0, 4)).toEqual([MIN, 5 * MIN, 15 * MIN, 15 * MIN]);
    expect(callsTo(h, CSFLOAT_FEED_URL).length).toBeGreaterThan(20);
    // cs.money's captcha never paused CSFloat (at this moment it waits for its window's reset).
    expect(h.feed.state().platforms['csfloat.com'].issue).toBeUndefined();
    expect(h.feed.state().platforms['csfloat.com'].status).not.toBe('paused');
    // cs.money's captcha inside an HTTP 200 body counts the same, and the next good answer resumes at once.
    h.answers.set(CSMONEY_MARKET_FEED_URL, () => ok({ error: 4030 }));
    await h.feed.retry({ requestId: 'retry', platform: 'cs.money' });
    await vi.advanceTimersByTimeAsync(SEC);
    expect(h.feed.state().platforms['cs.money'].issue?.kind).toBe('captcha');
    h.answers.set(CSMONEY_MARKET_FEED_URL, (now) => ok({ items: [csMoneyMarketRow(now, 1)] }));
    await h.feed.retry({ requestId: 'retry', platform: 'cs.money' });
    // Still one cs.money request per 5 s.
    await vi.advanceTimersByTimeAsync(5 * SEC);
    expect(h.feed.state().platforms['cs.money']).toMatchObject({ status: 'running', attempts: 0 });
  });

  it('a CSFloat 429 with a reset waits for it', async () => {
    const h = harness();
    const resetAt = T0 + 7 * MIN;
    h.answers.set(CSFLOAT_FEED_URL, (now) => ({ ok: false, status: 429, data: null, headers: csfloatHeaders(0, resetAt, now) }));
    await h.feed.start({ requestId: 'r', config: config(['csfloat']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    expect(h.feed.state().platforms['csfloat.com']).toMatchObject({ status: 'paused', issue: { kind: 'rate-limited' }, retryAt: resetAt + 2 * SEC });
    // "Try now" cannot spend a window CSFloat said is empty.
    await h.feed.retry({ requestId: 'x', platform: 'csfloat.com' });
    await openFor(h, 6 * MIN);
    expect(callsTo(h, CSFLOAT_FEED_URL)).toEqual([0]);
    h.answers.set(CSFLOAT_FEED_URL, (now) => ok(csfloatPage(now), csfloatHeaders(199, now + 40 * MIN, now)));
    await openFor(h, 2 * MIN);
    expect(callsTo(h, CSFLOAT_FEED_URL)[1]).toBeGreaterThanOrEqual(resetAt + 2 * SEC - T0);
    expect(callsTo(h, CSFLOAT_FEED_URL)[1]).toBeLessThanOrEqual(resetAt + 22 * SEC - T0);
    expect(h.feed.state().platforms['csfloat.com']).toMatchObject({ status: 'running', attempts: 0 });
  });

  it('a header-less CSFloat 429 and then Cloudflare back off 1, then 5 minutes (one exit: no loop of retries)', async () => {
    const h = harness();
    h.answers.set(CSFLOAT_FEED_URL, () => ({ ok: false, status: 429, data: null, headers: {} }));
    await h.feed.start({ requestId: 'r', config: config(['csfloat']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    expect(h.feed.state().platforms['csfloat.com']).toMatchObject({ issue: { kind: 'rate-limited', status: 429 }, attempts: 1, retryAt: T0 + MIN });
    h.answers.set(CSFLOAT_FEED_URL, () => ({ ok: false, status: 403, data: '<html>', headers: { 'cf-mitigated': 'challenge' } }));
    await openFor(h, 2 * MIN);
    expect(callsTo(h, CSFLOAT_FEED_URL)).toEqual([0, MIN]);
    expect(h.feed.state().platforms['csfloat.com']).toMatchObject({ issue: { kind: 'captcha' }, attempts: 2, retryAt: T0 + 6 * MIN });
  });

  it('other failures retry sooner (15 s, 1 min, 5 min)', async () => {
    const h = harness();
    h.answers.set(CSMONEY_BOTS_FEED_URL, () => ({ ok: false, status: 502, data: 'bad gateway' }));
    await h.feed.start({ requestId: 'r', config: config(['csmoney-bots']) }, TAB);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await h.feed.read({ requestId: 'hb' }, TAB);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    const tries = callsTo(h, CSMONEY_BOTS_FEED_URL);
    expect(tries.slice(1).map((at, index) => at - (tries[index] ?? 0))).toEqual([15 * SEC, MIN]);
    expect(h.feed.state().platforms['cs.money'].issue).toEqual({ kind: 'error', status: 502 });
  });
});

describe('Market live feed: dedup, push, leases and restarts', () => {
  it('pushes only new listings to the leased tab; the first answer is a baseline', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csfloat']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    const first = h.pushes.at(-1)?.update;
    expect(first?.rows.map((row) => [row.listing.key, row.listing.baseline])).toEqual([
      ['csfloat:2', true],
      ['csfloat:1', true],
      ['csfloat:0', true],
    ]);
    await vi.advanceTimersByTimeAsync(25 * SEC);
    const second = h.pushes.at(-1)?.update;
    expect(second?.rows.map((row) => [row.listing.key, row.listing.baseline])).toEqual([
      ['csfloat:4', false],
      ['csfloat:3', false],
    ]);
    expect(second?.rows[0]?.raw).toMatchObject({ id: '4' });
    // Created 3 s before the answer, measured on CSFloat's clock (its whole-second `date`).
    expect(second?.rows[0]?.listing.latencyMs).toBeGreaterThan(2 * SEC);
    expect(second?.rows[0]?.listing.latencyMs).toBeLessThanOrEqual(3 * SEC);
    expect(h.pushes.every((push) => push.tabId === TAB)).toBe(true);
    // A page catching up reads what came after its newest seq.
    expect(second?.rows.map((row) => row.listing.seq)).toEqual([4, 5]);
    const read = await h.feed.read({ requestId: 'q', sinceSeq: 4 }, TAB);
    expect(read.rows.map((row) => row.listing.key)).toEqual(['csfloat:3']);
    expect(read.requestId).toBe('q');
  });

  it('stops when the tab closes, and when its lease runs out without reads', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csmoney-market']) }, TAB);
    await vi.advanceTimersByTimeAsync(SEC);
    h.feed.tabRemoved(TAB);
    const count = h.calls.length;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.calls.length).toBe(count);
    expect(h.feed.state().running).toBe(false);
    expect(h.watchdog.at(-1)).toBe(false);

    await h.feed.start({ requestId: 'r2', config: config(['csmoney-market']) }, TAB);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await h.feed.read({ requestId: 'hb' }, TAB);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(h.feed.state().running).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(h.feed.state().running).toBe(false);
    const stoppedAt = h.calls.at(-1)?.at ?? 0;
    await vi.advanceTimersByTimeAsync(MIN);
    expect(h.calls.at(-1)?.at).toBe(stoppedAt);
  });

  it('a second tab keeps it running after the first stops', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'a', config: config(['csmoney-market']) }, 1);
    await h.feed.start({ requestId: 'b', config: config(['csmoney-market']) }, 2);
    await h.feed.stop({ requestId: 'c' }, 1);
    const before = h.pushes.length;
    await vi.advanceTimersByTimeAsync(21 * SEC);
    expect(h.feed.state().running).toBe(true);
    expect(new Set(h.pushes.slice(before).map((push) => push.tabId))).toEqual(new Set([2]));
    await h.feed.stop({ requestId: 'd' }, 2);
    expect(h.feed.state().running).toBe(false);
  });

  it('picks up after a worker restart from storage.session without announcing seen listings again', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csfloat']) }, TAB);
    // The first answer is written within FEED_PERSIST_MS (15 s).
    await vi.advanceTimersByTimeAsync(16 * SEC);
    const snapshot = h.saved.at(-1);
    expect(snapshot).toMatchObject({ v: 1, leases: { [TAB]: expect.any(Number) } });
    // The worker is gone; a new one restores the state and the ledger.
    resetFeedPriorityForTests(() => Date.now());
    csfloatSeq = 0;
    const next = harness(snapshot);
    await next.feed.resume();
    await vi.advanceTimersByTimeAsync(30 * SEC);
    expect(next.feed.state()).toMatchObject({ running: true, seq: 3 });
    expect(csfloatFeedLedger().windowBudget).toBe(200);
    // The answer repeats listings 0–2 only: nothing new to push.
    expect(next.pushes.flatMap((push) => push.update.rows)).toEqual([]);
  });

  it('serves the compact buffer to the preview without keeping the feed on', async () => {
    const h = harness();
    await h.feed.start({ requestId: 'r', config: config(['csfloat', 'csmoney-bots']) }, TAB);
    await vi.advanceTimersByTimeAsync(11 * SEC);
    const buffer = await h.feed.readBuffer({ requestId: 'b1', sources: ['csfloat'] });
    expect(buffer).toMatchObject({ requestId: 'b1', running: true, coveredSince: T0 });
    expect(buffer.listings.map((listing) => listing.key)).toEqual(['csfloat:2', 'csfloat:1', 'csfloat:0']);
    expect(buffer.listings[0]).not.toHaveProperty('raw');
    expect((await h.feed.readBuffer({ requestId: 'b2', sinceMs: T0 + 5 * SEC })).listings.map((listing) => listing.source)).toEqual(['csmoney-bots']);
  });
});
