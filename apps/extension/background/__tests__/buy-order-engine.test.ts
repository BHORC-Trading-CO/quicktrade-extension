// QUICK-233: the buy-order engine end to end in the background: the real engine, the real buy executor (its registry,
// its account cache, its re-reads and request builders) and fixture marketplace answers; the page relay and the
// server's journal are a fake that answers after set delays. No marketplace is ever called. Each money guard, the lease,
// Stop all, the server's switch, Test mode, "one buy for several rules", "one try per listing" and the R-F7 latency are
// checked against what the executor actually sent.
import type {
  BuyOrderRule,
  BuyOrdersEngineAnswer,
  BuyOrdersEngineRequest,
  BuyOrdersLeasePush,
  BuyOrdersSnapshot,
  BuyOrdersSpend,
  MarketBuyAnswer,
  MarketBuyRequest,
  MarketFeedConfig,
  MarketFeedListing,
  MarketFeedRow,
  OperationRequest,
} from '@qts/contracts';
import { addToSpend, BUY_ORDER_FAILURE_LIMIT, BUY_ORDER_LEASE_TTL_MS, BUY_ORDER_OWN_TIME_MS, utcDayOf, utcDayStart } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BuyOrderEngine, createBuyOrderEngine, ENGINE_TICK_MS } from '../buy-orders/engine';
import { accountPlatformOfCookie, MarketAccountCache } from '../market-buy/account-cache';
import { AttemptRegistry } from '../market-buy/attempt-registry';
import { confirmMarketAccount, executeMarketBuy, type MarketBuyDeps } from '../market-buy/executor';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const CLERK = 'user_engine1';
const DEVICE = '00000000-0000-4000-8000-0000000000aa';
const OTHER_DEVICE = '00000000-0000-4000-8000-0000000000bb';
const STEAM = '76561198000000001';
const TAB = 11;
const FEED: MarketFeedConfig = { sources: [{ source: 'csfloat', request: { url: 'https://csfloat.com/api/v1/listings?limit=50&type=buy_now&sort_by=most_recent', method: 'GET' } }] };

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

function rule(patch: Partial<BuyOrderRule> = {}): BuyOrderRule {
  return {
    id: 'r1',
    name: 'Printstream MW cheap',
    item: 'M4A1-S | Printstream',
    category: 'any',
    minFloat: null,
    maxFloat: null,
    wears: [],
    seeds: [],
    phase: null,
    sticker: '',
    maxStickerPremiumPct: null,
    sources: ['csfloat', 'csmoney-market'],
    maxPriceCents: 30_000,
    belowEstimatePct: null,
    maxItemsPerDay: 5,
    dailyBudgetCents: 100_000,
    enabled: true,
    mode: 'auto',
    createdAt: '2026-10-25T10:00:00.000Z',
    updatedAt: '2026-10-25T10:00:00.000Z',
    ...patch,
  };
}

function snapshot(rules: BuyOrderRule[], patch: Partial<BuyOrdersSnapshot> = {}): BuyOrdersSnapshot {
  return { clerkId: CLERK, revision: 3, dailyBudgetCents: 200_000, rules, updatedAt: '2026-10-25T10:00:00.000Z', ...patch };
}

function emptySpend(now = Date.now()): BuyOrdersSpend {
  return { day: utcDayOf(now), dayEndsAt: utcDayStart(now) + 86_400_000, accountCents: 0, accountItems: 0, rules: {} };
}

function leasePush(patch: { status?: Partial<NonNullable<BuyOrdersLeasePush['status']>> | null; clerkId?: string } = {}): BuyOrdersLeasePush {
  const now = Date.now();
  const status =
    patch.status === null
      ? null
      : {
          clerkId: CLERK,
          serverNow: now,
          switchedOn: true,
          stoppedAt: null,
          steamId: STEAM,
          lease: { leaseId: 'lease-aaaaaaaa', deviceId: DEVICE, deviceLabel: null, renewedAt: now, expiresAt: now + BUY_ORDER_LEASE_TTL_MS },
          spend: server.spend,
          failures: {},
          ...patch.status,
        };
  return { clerkId: patch.clerkId ?? CLERK, status, requestedAt: now, receivedAt: now, feed: FEED };
}

let seq = 0;
function feedListing(listingId: string, priceCents: number, patch: Partial<MarketFeedListing> = {}): MarketFeedListing {
  seq += 1;
  const now = Date.now();
  const source = patch.source ?? 'csfloat';
  return {
    key: `${source}:${listingId}`,
    source,
    listingId,
    marketHashName: 'M4A1-S | Printstream (Minimal Wear)',
    priceCents,
    float: 0.0712,
    paintSeed: 151,
    paintIndex: 984,
    defIndex: 60,
    isStatTrak: false,
    isSouvenir: false,
    stickers: [],
    image: null,
    listedAt: now - 3_000,
    firstSeenAt: now,
    lastSeenAt: now,
    latencyMs: 3_000,
    baseline: false,
    goneAt: null,
    seq,
    ...patch,
  };
}

const rows = (...listings: MarketFeedListing[]): MarketFeedRow[] => listings.map((listing) => ({ listing, raw: {} }));

function json(status: number, data: unknown): MarketBuyAnswer {
  return { ok: status >= 200 && status < 300, status, data, headers: { 'content-type': 'application/json' } };
}

// ─── The marketplace (fixture answers, delays per request) ─────────────────────────────────────────

interface Market {
  prices: Map<string, number>;
  balanceCents: number;
  steamId: string;
  /** The listing's re-read takes this long. */
  rereadMs: number;
  /** The account read takes this long. */
  accountMs: number;
  buyAnswer: () => MarketBuyAnswer;
}

let market: Market;
let reads: Array<{ url: string; at: number }>;
let sends: Array<{ request: OperationRequest; at: number }>;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function marketRead(_platform: string, built: OperationRequest): Promise<MarketBuyAnswer> {
  reads.push({ url: built.url, at: Date.now() });
  if (built.url.endsWith('/api/v1/me')) {
    await wait(market.accountMs);
    return json(200, { user: { steam_id: market.steamId, balance: market.balanceCents } });
  }
  const csfloat = /\/api\/v1\/listings\/([^/?]+)$/.exec(built.url);
  if (csfloat?.[1]) {
    await wait(market.rereadMs);
    const price = market.prices.get(`csfloat:${csfloat[1]}`);
    return price === undefined ? json(400, { code: 2, message: 'unknown resource' }) : json(200, { id: csfloat[1], state: 'listed', type: 'buy_now', price, seller: { away: false } });
  }
  const order = /\/2\.0\/market\/sell-orders\/(\d+)$/.exec(built.url);
  if (order?.[1]) {
    await wait(market.rereadMs);
    const price = market.prices.get(`csmoney-market:${order[1]}`);
    return price === undefined ? json(404, null) : json(200, { item: { id: Number(order[1]), pricing: { computed: price / 100 } } });
  }
  if (built.url.endsWith('cs.money/market/buy/')) {
    await wait(market.accountMs);
    return { ok: true, status: 200, data: `<script>{"userInfo":{"steamId64":"${market.steamId}"},"marketBalance":{"balance":${market.balanceCents}}}</script>`, headers: {} };
  }
  throw new Error(`no fixture for ${built.url}`);
}

// ─── The page relay and the server's journal (a fake) ──────────────────────────────────────────────

interface Server {
  spend: BuyOrdersSpend;
  openMs: number;
  /** Refuse every open with this code. */
  refuse: string | null;
  estimateMs: number;
  estimates: Record<string, number | null>;
  requests: BuyOrdersEngineRequest[];
  /** The page's answer to an open never comes back. */
  openLost: boolean;
  /** The page answers an open with another attempt's row. */
  openAttemptId: string | null;
  settleOk: boolean;
  pauseOk: boolean;
}

let server: Server;
/** The harness's cs.money market switch: on, so the market path is tested as it runs once switched on. */
let csmoneyMarketEnabled: boolean;

function pageAnswer(request: BuyOrdersEngineRequest): { delay: number; answer: BuyOrdersEngineAnswer } {
  switch (request.kind) {
    case 'open': {
      if (server.refuse) return { delay: server.openMs, answer: { requestId: request.requestId, kind: 'open', outcome: 'refused', code: server.refuse } };
      return {
        delay: server.openMs,
        answer: {
          requestId: request.requestId,
          kind: 'open',
          outcome: 'opened',
          response: { attemptId: server.openAttemptId ?? request.open.attemptId, state: 'pending', serverNow: Date.now(), spend: server.spend },
        },
      };
    }
    case 'estimates': {
      const estimates: Record<string, number | null> = {};
      for (const listing of request.listings) estimates[`${listing.source}:${listing.listingId}`] = server.estimates[listing.listingId] ?? null;
      return { delay: server.estimateMs, answer: { requestId: request.requestId, kind: 'estimates', estimates } };
    }
    case 'settle':
      return { delay: 50, answer: { requestId: request.requestId, kind: 'settle', ok: server.settleOk } };
    case 'pause_rule':
      return { delay: 50, answer: { requestId: request.requestId, kind: 'pause_rule', ok: server.pauseOk } };
    case 'renew':
      return { delay: 50, answer: { requestId: request.requestId, kind: 'renew', ok: true } };
  }
}

function ask(tabIds: readonly number[], request: BuyOrdersEngineRequest, timeoutMs: number): Promise<BuyOrdersEngineAnswer | null> {
  server.requests.push(request);
  if (!tabIds.length) return Promise.resolve(null);
  if (request.kind === 'open' && server.openLost) return new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const { delay, answer } = pageAnswer(request);
  return new Promise((resolve) =>
    setTimeout(
      () => {
        if (delay > timeoutMs) return resolve(null);
        // The journal counts the row once it is opened (the server's figure includes it).
        if (answer.kind === 'open' && answer.outcome === 'opened' && request.kind === 'open') {
          server.spend = addToSpend(server.spend, request.open.ruleId, request.open.priceCents);
          return resolve({ ...answer, response: { ...answer.response, spend: server.spend, serverNow: Date.now() } });
        }
        return resolve(answer);
      },
      Math.min(delay, timeoutMs)
    )
  );
}

// ─── Harness ───────────────────────────────────────────────────────────────────────────────────────

interface Harness {
  engine: BuyOrderEngine;
  accounts: MarketAccountCache;
  registry: AttemptRegistry;
  buyDeps: MarketBuyDeps;
  executed: MarketBuyRequest[];
  notified: string[];
  feedCalls: string[];
  /** What the engine last wrote to storage.local and storage.session. */
  stored: { local: unknown; session: unknown };
}

function harness(storage: { local?: unknown; session?: unknown } = {}): Harness {
  const stored = { local: storage.local, session: storage.session };
  const accounts = new MarketAccountCache(() => Date.now());
  const registry = new AttemptRegistry(
    () => null,
    () => Date.now()
  );
  const buyDeps: MarketBuyDeps = {
    read: marketRead,
    send: async (_platform, built) => {
      sends.push({ request: built, at: Date.now() });
      return market.buyAnswer();
    },
    registry,
    reserveCsfloat: () => () => undefined,
    now: () => Date.now(),
    botsEnabled: false,
    csmoneyMarketEnabled,
    readTimeoutMs: 10_000,
    listingReadTimeoutMs: 5_000,
    buyTimeoutMs: 30_000,
    accounts,
  };
  const executed: MarketBuyRequest[] = [];
  const notified: string[] = [];
  const feedCalls: string[] = [];
  let feedHeld: string[] | null = null;
  const engine = createBuyOrderEngine({
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    execute: (request, options) => {
      executed.push(request);
      return executeMarketBuy(request, buyDeps, options);
    },
    attempted: (key) => registry.hasRecord(key),
    accounts,
    confirmAccount: (platform, steamId) => confirmMarketAccount(platform, steamId, buyDeps),
    ask,
    notify: (_tabs, event) => notified.push(event.kind),
    feed: {
      start: async (config) => {
        feedCalls.push('start');
        feedHeld = config.sources.map(({ source }) => source);
        return true;
      },
      hold: () => feedHeld !== null,
      sources: () => (feedHeld ? [...feedHeld] : null) as ReturnType<Parameters<typeof createBuyOrderEngine>[0]['feed']['sources']>,
      stop: async () => {
        feedCalls.push('stop');
        feedHeld = null;
      },
    },
    load: async () => storage.local,
    save: async (state) => {
      stored.local = structuredClone(state);
    },
    loadSession: async () => storage.session,
    saveSession: async (state) => {
      stored.session = structuredClone(state);
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    botsEnabled: false,
    csmoneyMarketEnabled,
    deviceId: async () => DEVICE,
  });
  return { engine, accounts, registry, buyDeps, executed, notified, feedCalls, stored };
}

/** A running engine: the rules, this browser's lease and a fresh confirmation of the CSFloat account. */
async function running(rules: BuyOrderRule[], snapshotPatch: Partial<BuyOrdersSnapshot> = {}): Promise<Harness> {
  const h = harness();
  await h.engine.setRules(snapshot(rules, snapshotPatch));
  await h.engine.setLease(leasePush(), TAB);
  h.accounts.put('csfloat.com', STEAM, market.balanceCents);
  h.accounts.put('cs.money', STEAM, market.balanceCents);
  return h;
}

/** The feed brings these listings now; their re-reads will quote the same prices. */
async function feed(h: Harness, ...listings: MarketFeedListing[]): Promise<void> {
  for (const listing of listings) if (!market.prices.has(listing.key)) market.prices.set(listing.key, listing.priceCents);
  h.engine.onListings(rows(...listings), Date.now());
}

async function settle(ms = 2_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const activityKinds = (h: Harness) => h.engine.view().activity.map((entry) => `${entry.kind}:${entry.reason ?? ''}`);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  seq = 0;
  csmoneyMarketEnabled = true;
  reads = [];
  sends = [];
  market = { prices: new Map(), balanceCents: 500_000, steamId: STEAM, rereadMs: 300, accountMs: 300, buyAnswer: () => json(200, { message: 'ok' }) };
  server = { spend: emptySpend(T0), openMs: 200, refuse: null, estimateMs: 200, estimates: {}, requests: [], openLost: false, openAttemptId: null, settleOk: true, pauseOk: true };
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ─────────────────────────────────────────────────────────────────────────────────────────

describe('buying a matching listing', () => {
  it('buys through the executor at exactly the listing price, with origin buy_order, and settles the journal row', async () => {
    const h = await running([rule()]);
    await feed(h, feedListing('9001', 26_200));
    await settle();
    expect(sends).toHaveLength(1);
    expect(JSON.parse(String(sends[0]?.request.body))).toEqual({ total_price: 26_200, contract_ids: ['9001'] });
    expect(h.executed[0]).toMatchObject({ origin: { kind: 'buy_order', ruleId: 'r1' }, priceCents: 26_200, steamId: STEAM });
    const open = server.requests.find((request) => request.kind === 'open');
    expect(open).toMatchObject({ open: { listingId: '9001', priceCents: 26_200, ruleId: 'r1', deviceId: DEVICE, leaseId: 'lease-aaaaaaaa' } });
    expect(server.requests.some((request) => request.kind === 'settle' && request.result.outcome === 'bought')).toBe(true);
    expect(activityKinds(h)).toContain('bought:ok');
    expect(h.notified).toContain('bought');
  });

  it('cs.money market switched off: its listings are skipped as source_disabled, nothing is read or sent', async () => {
    csmoneyMarketEnabled = false;
    const h = await running([rule()]);
    await feed(h, feedListing('555000111', 1_234, { source: 'csmoney-market' }));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(activityKinds(h)).toContain('skipped:source_disabled');
  });

  it('cs.money market: the purchase carries the feed price in USD (R-N1)', async () => {
    const h = await running([rule()]);
    await feed(h, feedListing('555000111', 1_234, { source: 'csmoney-market' }));
    await settle();
    expect(JSON.parse(String(sends[0]?.request.body))).toEqual({ items: [{ id: '555000111', price: 12.34 }] });
  });

  it('never acts on a baseline row (listings already on the market when the feed started)', async () => {
    const h = await running([rule()]);
    await feed(h, feedListing('9001', 26_200, { baseline: true }));
    await settle();
    expect(h.executed).toHaveLength(0);
  });
});

describe('guards before every automatic buy (R-F3)', () => {
  it('price above the rule limit: no buy', async () => {
    const h = await running([rule({ maxPriceCents: 26_199 })]);
    await feed(h, feedListing('9001', 26_200));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(activityKinds(h)).toContain('skipped:price_above_limit');
  });

  it('the account daily budget counts this buy: exactly the budget buys, one cent over does not', async () => {
    const h = await running([rule()], { dailyBudgetCents: 50_000 });
    server.spend = { ...server.spend, accountCents: 23_800, accountItems: 1 };
    await h.engine.setLease(leasePush(), TAB);
    await feed(h, feedListing('9001', 26_201));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'skipped', reason: 'account_budget', values: { spentCents: 23_800, budgetCents: 50_000 } });
    await feed(h, feedListing('9002', 26_200));
    await settle();
    expect(h.executed.map((request) => request.listingId)).toEqual(['9002']);
  });

  it('the rule daily budget counts this buy', async () => {
    const h = await running([rule({ dailyBudgetCents: 40_000 })]);
    server.spend = { ...server.spend, accountCents: 20_000, accountItems: 1, rules: { r1: { cents: 20_000, items: 1 } } };
    await h.engine.setLease(leasePush(), TAB);
    await feed(h, feedListing('9001', 20_001));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(activityKinds(h)).toContain('skipped:rule_budget');
  });

  it('max items per day: the next one after the last is skipped', async () => {
    const h = await running([rule({ maxItemsPerDay: 1 })]);
    await feed(h, feedListing('9001', 100));
    await settle();
    await feed(h, feedListing('9002', 100));
    await settle();
    expect(h.executed.map((request) => request.listingId)).toEqual(['9001']);
    expect(activityKinds(h)[0]).toBe('skipped:items');
  });

  it('the balance the executor confirmed, minus buys since: short means no buy request', async () => {
    market.balanceCents = 30_000;
    const h = await running([rule({ maxPriceCents: 30_000 })]);
    await feed(h, feedListing('9001', 20_000));
    await settle();
    await feed(h, feedListing('9002', 20_000));
    await settle();
    expect(sends).toHaveLength(1);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'skipped', reason: 'balance', values: { shortCents: 10_000 } });
  });

  it('an unknown result counts as spent and is never retried', async () => {
    const h = await running([rule()], { dailyBudgetCents: 30_000 });
    market.buyAnswer = () => ({ ok: false, status: 0, data: null, error: 'network' });
    const listing = feedListing('9001', 26_200);
    await feed(h, listing);
    await settle();
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'unknown', outcome: 'unknown' });
    // Spent: the next listing would go over the 300 USD budget.
    await feed(h, feedListing('9002', 5_000));
    await settle();
    expect(activityKinds(h)[0]).toBe('skipped:account_budget');
    // The same listing again (another answer carrying it) is never tried again.
    await feed(h, { ...listing, seq: 99 });
    await settle();
    expect(sends).toHaveLength(1);
  });

  it('manual purchases never count, but a listing a click tried is never tried by a rule', async () => {
    const h = await running([rule()], { dailyBudgetCents: 30_000 });
    market.prices.set('csfloat:7001', 29_000);
    const manual = executeMarketBuy(
      { requestId: 'm1', attemptId: '00000000-0000-4000-8000-000000000101', source: 'csfloat', listingId: '7001', priceCents: 29_000, origin: { kind: 'manual' }, steamId: STEAM },
      h.buyDeps
    );
    await settle();
    expect((await manual).outcome).toBe('bought');
    expect(h.engine.view().spend?.accountCents).toBe(0);
    await feed(h, feedListing('7001', 29_000));
    await settle();
    expect(activityKinds(h)[0]).toBe('skipped:listing_tried');
    await feed(h, feedListing('7002', 29_000));
    await settle();
    expect(h.executed.map((request) => request.listingId)).toEqual(['7002']);
  });

  it('a rule pauses itself after 3 failed buys in a row, asks the page to switch it off, and buys nothing more', async () => {
    const h = await running([rule()]);
    market.buyAnswer = () => json(400, { code: 125, message: 'cannot trade' });
    for (let i = 0; i < BUY_ORDER_FAILURE_LIMIT; i++) {
      await feed(h, feedListing(`900${i}`, 1_000));
      await settle();
    }
    expect(sends).toHaveLength(BUY_ORDER_FAILURE_LIMIT);
    expect(h.engine.view().rules['r1']).toMatchObject({ failures: 3 });
    expect(h.engine.view().rules['r1']?.pausedAt).not.toBeNull();
    expect(server.requests.filter((request) => request.kind === 'pause_rule')).toHaveLength(1);
    expect(h.notified).toContain('paused');
    await feed(h, feedListing('9100', 1_000));
    await settle();
    expect(sends).toHaveLength(3);
    expect(activityKinds(h)[0]).toBe('skipped:rule_paused');
    // The user changes the rule (or switches it on again): it starts over.
    await h.engine.setRules(snapshot([rule({ updatedAt: '2026-10-25T13:00:00.000Z' })]));
    market.buyAnswer = () => json(200, { message: 'ok' });
    await feed(h, feedListing('9101', 1_000));
    await settle();
    expect(sends).toHaveLength(4);
  });

  it('a sold listing or a moved price is the race lost, not a failure', async () => {
    const h = await running([rule()]);
    market.buyAnswer = () => json(400, { code: 4, message: 'sold' });
    for (let i = 0; i < 4; i++) {
      await feed(h, feedListing(`900${i}`, 1_000));
      await settle();
    }
    expect(sends).toHaveLength(4);
    expect(h.engine.view().rules['r1']?.failures).toBe(0);
  });

  it('a rate limit or a captcha is the marketplace’s outage: it never switches a rule off', async () => {
    const h = await running([rule()]);
    market.buyAnswer = () => json(429, { message: 'too many requests' });
    for (let i = 0; i < 4; i++) {
      await feed(h, feedListing(`910${i}`, 1_000));
      await settle(70_000);
    }
    expect(h.engine.view().rules['r1']?.failures).toBe(0);
    expect(server.requests.some((request) => request.kind === 'pause_rule')).toBe(false);
  });

  it('attempts of one rule in flight together never overshoot the limit: with 2 failures, one more attempt at a time', async () => {
    const h = await running([rule()]);
    market.buyAnswer = () => json(400, { code: 125, message: 'cannot trade' });
    for (let i = 0; i < 2; i++) {
      await feed(h, feedListing(`920${i}`, 1_000));
      await settle();
    }
    await feed(h, feedListing('9210', 1_000), feedListing('9211', 1_000), feedListing('9212', 1_000));
    await settle();
    expect(sends).toHaveLength(3);
    expect(activityKinds(h).filter((kind) => kind === 'skipped:failures_pending')).toHaveLength(2);
    expect(h.engine.view().rules['r1']?.failures).toBe(3);
  });

  it('the server’s count of the rule’s failures (every device) pauses it here too', async () => {
    const h = await running([rule()]);
    await h.engine.setLease(leasePush({ status: { failures: { r1: 3 } } }), TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(activityKinds(h)).toEqual(expect.arrayContaining(['paused:failures', 'skipped:rule_paused']));
    expect(server.requests.filter((request) => request.kind === 'pause_rule')).toHaveLength(1);
  });

  it('a status from before the user switched the paused rule on again does not pause it again', async () => {
    const h = await running([rule()]);
    await h.engine.setLease(leasePush({ status: { failures: { r1: 3 } } }), TAB);
    expect(server.requests.filter((request) => request.kind === 'pause_rule')).toHaveLength(1);
    // Switched on again on the server a second later; the page's last status is still the one before.
    await h.engine.setRules(snapshot([rule({ updatedAt: new Date(Date.now() + 1_000).toISOString() })]));
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(1);
    expect(server.requests.filter((request) => request.kind === 'pause_rule')).toHaveLength(1);
  });

  it('a pause the server did not take is asked again with backoff, until the rule reads switched off', async () => {
    const h = await running([rule()]);
    server.pauseOk = false;
    const failing = () => leasePush({ status: { failures: { r1: 3 } } });
    await h.engine.setLease(failing(), TAB);
    const pauses = () => server.requests.filter((request) => request.kind === 'pause_rule').length;
    // The page renews the lease every 20 s, as it does.
    const run = async (ms: number) => {
      for (let left = ms; left > 0; left -= 10_000) {
        await settle(Math.min(10_000, left));
        await h.engine.setLease(failing(), TAB);
      }
    };
    await run(1_000);
    expect(pauses()).toBe(1);
    await run(10_000);
    expect(pauses()).toBe(2);
    await run(20_000);
    expect(pauses()).toBe(3);
    server.pauseOk = true;
    await run(65_000);
    expect(pauses()).toBe(4);
    await run(400_000);
    expect(pauses()).toBe(4);
    // The rule reads switched off (or the user changed it): nothing more to ask, and no new pause.
    await h.engine.setRules(snapshot([rule({ enabled: false, updatedAt: '2026-10-25T13:00:00.000Z' })]));
    await run(400_000);
    expect(pauses()).toBe(4);
  });

  it('no linked Steam account: nothing is bought (the account check never fails open)', async () => {
    const h = await running([rule()]);
    await h.engine.setLease(leasePush({ status: { steamId: null } }), TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(activityKinds(h)[0]).toBe('skipped:steam_link_required');
  });

  it('a marketplace session of another Steam account: the read refuses it and no confirmation is kept', async () => {
    const h = await running([rule()]);
    h.accounts.invalidate('csfloat.com');
    market.steamId = '76561198000000999';
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(sends).toHaveLength(0);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'failed', reason: 'steam_account_mismatch' });
    expect(h.accounts.get('csfloat.com', STEAM)).toBeNull();
  });

  it('refusals before any buy request (another Steam account on the marketplace) never pause a rule', async () => {
    const h = await running([rule()]);
    h.accounts.invalidate('csfloat.com');
    market.steamId = '76561198000000999';
    for (let i = 0; i < 4; i++) {
      await feed(h, feedListing(`930${i}`, 1_000));
      await settle();
    }
    expect(sends).toHaveLength(0);
    expect(h.engine.view().activity.filter((entry) => entry.reason === 'steam_account_mismatch')).toHaveLength(4);
    expect(h.engine.view().rules['r1']?.failures).toBe(0);
    expect(server.requests.some((request) => request.kind === 'pause_rule')).toBe(false);
  });

  it('the Steam account linked to QTS changed: a confirmation of the old one is never used', async () => {
    const h = await running([rule()]);
    const relinked = '76561198000000777';
    await h.engine.setLease(leasePush({ status: { steamId: relinked } }), TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    // The executor read the account again (the market still has the old one): a mismatch, nothing sent.
    expect(reads[0]?.url).toBe('https://csfloat.com/api/v1/me');
    expect(sends).toHaveLength(0);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'failed', reason: 'steam_account_mismatch' });
  });

  it('the server refuses the journal row (its own budget figures): not sent, and not a failure of the rule', async () => {
    const h = await running([rule()]);
    server.refuse = 'buy_orders_account_budget';
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(sends).toHaveLength(0);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'failed', reason: 'buy_orders_account_budget', outcome: 'not_sent' });
    expect(h.engine.view().rules['r1']?.failures).toBe(0);
  });

  it('the journal open’s answer lost: not sent, the row settled not_sent anyway', async () => {
    const h = await running([rule()]);
    server.openLost = true;
    await feed(h, feedListing('9001', 1_000));
    await settle(10_000);
    expect(sends).toHaveLength(0);
    expect(server.requests.filter((request) => request.kind === 'settle')).toMatchObject([{ result: { outcome: 'not_sent', sent: false } }]);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'failed', reason: 'journal_timeout', outcome: 'not_sent' });
  });

  it('…and when the settle does not get through either: the activity says unknown (the row runs out as unknown), and it is sent again', async () => {
    const h = await running([rule()]);
    server.openLost = true;
    server.settleOk = false;
    await feed(h, feedListing('9001', 1_000));
    await settle(10_000);
    expect(sends).toHaveLength(0);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'unknown', reason: 'journal_unconfirmed', outcome: 'not_sent' });
    expect(h.notified).toContain('unknown');
    const settles = () => server.requests.filter((request) => request.kind === 'settle').length;
    expect(settles()).toBe(1);
    await settle(31_000);
    expect(settles()).toBe(2);
    await settle(121_000);
    expect(settles()).toBe(3);
    await settle(600_000);
    expect(settles()).toBe(3);
  });

  it('a later settle that gets through corrects the entry from unknown to not sent', async () => {
    const h = await running([rule()]);
    server.openLost = true;
    server.settleOk = false;
    await feed(h, feedListing('9001', 1_000));
    await settle(10_000);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'unknown', reason: 'journal_unconfirmed' });
    server.settleOk = true;
    await settle(31_000);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'failed', reason: 'journal_timeout', outcome: 'not_sent' });
  });

  it('a settle retry the stopped worker lost is sent at the next worker start', async () => {
    const h = await running([rule()]);
    server.openLost = true;
    server.settleOk = false;
    await feed(h, feedListing('9001', 1_000));
    await settle(10_000);
    expect((h.stored.local as { settles: unknown[] }).settles).toHaveLength(1);
    // The browser stops the worker: its timers are gone. It starts again after the retry was due.
    // (Clearing the fake timers also resets their clock: the time is set again after it.)
    const stoppedAt = Date.now();
    vi.clearAllTimers();
    vi.setSystemTime(stoppedAt + 31_000);
    server.settleOk = true;
    const settles = () => server.requests.filter((request) => request.kind === 'settle').length;
    const before = settles();
    const restarted = harness({ local: h.stored.local, session: h.stored.session });
    await restarted.engine.resume(snapshot([rule()]));
    await settle(3_000);
    expect(settles()).toBe(before + 1);
    expect(restarted.engine.view().activity[0]).toMatchObject({ kind: 'failed', reason: 'journal_timeout' });
    expect((restarted.stored.local as { settles: unknown[] }).settles).toEqual([]);
  });

  it('an open answer about another attempt is no answer: nothing sent, this row settled not_sent', async () => {
    const h = await running([rule()]);
    server.openAttemptId = '00000000-0000-4000-8000-00000000dead';
    await feed(h, feedListing('9001', 1_000));
    await settle(10_000);
    expect(sends).toHaveLength(0);
    const open = server.requests.find((request) => request.kind === 'open');
    const settled = server.requests.find((request) => request.kind === 'settle');
    expect(settled).toMatchObject({ attemptId: open?.kind === 'open' ? open.open.attemptId : 'none', result: { outcome: 'not_sent' } });
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'failed', reason: 'journal_unavailable' });
  });

  it('the journal open carries what the server judges the rule on: seed, phase, stickers', async () => {
    const h = await running([rule({ item: '' })]);
    await feed(
      h,
      feedListing('9001', 1_000, {
        marketHashName: '★ Karambit | Doppler (Factory New)',
        paintIndex: 416,
        paintSeed: 412,
        stickers: [{ name: 'Sticker | Titan (Holo) | Katowice 2014', priceCents: 120_000 } as MarketFeedListing['stickers'][number]],
      })
    );
    await settle();
    const open = server.requests.find((request) => request.kind === 'open');
    expect(open).toMatchObject({ open: { paintSeed: 412, phase: 'Sapphire', stickers: [{ name: 'Sticker | Titan (Holo) | Katowice 2014', priceCents: 120_000 }] } });
  });
});

describe('the lease, Stop all and the switch (R-F8, R-F3)', () => {
  it('Stop all stops at once, also an attempt waiting at the gate', async () => {
    const h = await running([rule()]);
    server.openMs = 600;
    await feed(h, feedListing('9001', 1_000));
    await vi.advanceTimersByTimeAsync(100);
    await h.engine.setStopped(true);
    await settle();
    expect(sends).toHaveLength(0);
    expect(h.engine.view()).toMatchObject({ state: 'stopped', stoppedHere: true });
    await feed(h, feedListing('9002', 1_000));
    await settle();
    expect(h.executed).toHaveLength(1);
    expect(h.feedCalls).toContain('stop');
    // A renewal answer does not start it again; only Start in this browser does.
    await h.engine.setLease(leasePush(), TAB);
    expect(h.engine.view().state).toBe('stopped');
    await h.engine.setStopped(false);
    expect(h.engine.view().state).toBe('running');
  });

  it('Stop all on another device (the server says stopped): nothing is bought here', async () => {
    const h = await running([rule()]);
    await h.engine.setLease(leasePush({ status: { stoppedAt: Date.now(), lease: null } }), TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(h.engine.view().state).toBe('stopped');
  });

  it('the server switch off: nothing is bought', async () => {
    const h = await running([rule()]);
    await h.engine.setLease(leasePush({ status: { switchedOn: false } }), TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(h.engine.view().state).toBe('switched_off');
  });

  it('another device holds the lease: nothing is bought here, and the view names it', async () => {
    const h = await running([rule()]);
    const now = Date.now();
    await h.engine.setLease(leasePush({ status: { lease: { leaseId: 'lease-bbbbbbbb', deviceId: OTHER_DEVICE, deviceLabel: 'Firefox · Windows', renewedAt: now, expiresAt: now + 60_000 } } }), TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(h.engine.view()).toMatchObject({ state: 'other_device', holder: { deviceLabel: 'Firefox · Windows' } });
  });

  it('a lease not renewed in time: the engine stops a few seconds before it ends', async () => {
    const h = await running([rule()]);
    await vi.advanceTimersByTimeAsync(BUY_ORDER_LEASE_TTL_MS - 4_000);
    expect(h.engine.view().state).toBe('waiting');
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    // Meanwhile the engine asked the page to renew (a hidden tab's timers may be slowed).
    expect(server.requests.some((request) => request.kind === 'renew')).toBe(true);
  });

  it('the lease taken away (signed out, plan lapsed): stops at once', async () => {
    const h = await running([rule()]);
    await h.engine.setLease(leasePush({ status: null }), TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(h.notified).toContain('lease_lost');
  });

  it('the last page that renewed the lease closed: stops at once', async () => {
    const h = await running([rule()]);
    h.engine.tabRemoved(TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
  });

  it('rules of another account than the lease: nothing runs', async () => {
    const h = harness();
    await h.engine.setRules(snapshot([rule()], { clerkId: 'user_someoneelse' }));
    await h.engine.setLease(leasePush(), TAB);
    h.accounts.put('csfloat.com', STEAM, market.balanceCents);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(h.engine.view().state).toBe('idle');
  });

  it('rules pushed by a page of another account never reset this account’s Stop all or runs of failures', async () => {
    const h = await running([rule()]);
    market.buyAnswer = () => json(400, { code: 125, message: 'cannot trade' });
    await feed(h, feedListing('9001', 1_000));
    await settle();
    await h.engine.setStopped(true);
    await h.engine.setRules(snapshot([rule()], { clerkId: 'user_someoneelse' }));
    // The other account sees none of this one's activity.
    expect(h.engine.view().activity).toEqual([]);
    await h.engine.setRules(snapshot([rule()]));
    expect(h.engine.view()).toMatchObject({ state: 'stopped', stoppedHere: true });
    expect(h.engine.view().rules['r1']?.failures).toBe(1);
    expect(activityKinds(h)).toContain('failed:code_125');
  });

  it('a renewal answer older than the one the engine has does not bring an ended lease back', async () => {
    const h = await running([rule()]);
    const stale = leasePush();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.engine.setLease(leasePush({ status: { lease: null } }), TAB);
    await h.engine.setLease(stale, TAB);
    expect(h.engine.view().state).toBe('waiting');
  });
});

describe('Test mode and several rules (R-F4, R-F5)', () => {
  it('a rule in Test mode logs "would buy" and never calls the executor', async () => {
    const h = await running([rule({ mode: 'test' })]);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(activityKinds(h)).toEqual(expect.arrayContaining(['would_buy:']));
    expect(h.engine.view().rules['r1']).toMatchObject({ testItems: 1, testCents: 1_000 });
  });

  it('Test mode plays its own day: after its items per day it would skip', async () => {
    const h = await running([rule({ mode: 'test', maxItemsPerDay: 1 })]);
    await feed(h, feedListing('9001', 1_000), feedListing('9002', 1_000));
    await settle();
    expect(activityKinds(h).toSorted()).toEqual(['started:', 'would_buy:', 'would_skip:items']);
  });

  it('several matching rules: one buy, credited to the rule highest in the order', async () => {
    const h = await running([rule({ id: 'first', name: 'First' }), rule({ id: 'second', name: 'Second' })]);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]?.origin).toEqual({ kind: 'buy_order', ruleId: 'first' });
  });

  it('the first rule out of its own budget: the next matching rule buys it, still once', async () => {
    const h = await running([rule({ id: 'first', maxItemsPerDay: 1 }), rule({ id: 'second' })]);
    server.spend = { ...server.spend, accountCents: 100, accountItems: 1, rules: { first: { cents: 100, items: 1 } } };
    await h.engine.setLease(leasePush(), TAB);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed.map((request) => request.origin)).toEqual([{ kind: 'buy_order', ruleId: 'second' }]);
  });

  it('a Test mode rule above an auto rule does not take the listing from it', async () => {
    const h = await running([rule({ id: 'test', mode: 'test' }), rule({ id: 'auto' })]);
    await feed(h, feedListing('9001', 1_000));
    await settle();
    expect(h.executed.map((request) => request.origin)).toEqual([{ kind: 'buy_order', ruleId: 'auto' }]);
    expect(activityKinds(h)).toEqual(expect.arrayContaining(['would_buy:', 'bought:ok']));
  });

  it('one try per listing: the same listing in two answers, or two listings in flight, is tried once each', async () => {
    const h = await running([rule()]);
    const listing = feedListing('9001', 1_000);
    await feed(h, listing, listing);
    await feed(h, listing);
    await settle();
    expect(h.executed).toHaveLength(1);
  });

  it('a discount rule asks the QTS estimate once for the answer and decides on it', async () => {
    const h = await running([rule({ maxPriceCents: null, belowEstimatePct: 10 })]);
    server.estimates = { '9001': 20_000, '9002': 20_000 };
    await feed(h, feedListing('9001', 18_000), feedListing('9002', 18_001));
    await settle();
    expect(server.requests.filter((request) => request.kind === 'estimates')).toHaveLength(1);
    expect(h.executed.map((request) => request.listingId)).toEqual(['9001']);
    expect(h.engine.view().activity.some((entry) => entry.reason === 'discount_too_small' && entry.listing?.listingId === '9002')).toBe(true);
  });
});

describe('latency (R-F7): feed answer → buy request', () => {
  it('re-read 300 ms and journal 200 ms in parallel: the request leaves 300 ms after the answer, no account read', async () => {
    const h = await running([rule()]);
    const listing = feedListing('9001', 1_000);
    await feed(h, listing);
    await settle();
    expect(reads.map((read) => read.url)).toEqual(['https://csfloat.com/api/v1/listings/9001']);
    const latency = (sends[0]?.at ?? 0) - listing.firstSeenAt;
    expect(latency).toBe(300);
    expect(h.engine.view().activity[0]?.latencyMs).toBe(300);
  });

  it('with a QTS estimate to ask (250 ms) first: 250 + max(300 re-read, 200 journal) = 550 ms', async () => {
    const h = await running([rule({ maxPriceCents: null, belowEstimatePct: 5 })]);
    server.estimateMs = 250;
    server.estimates = { '9001': 2_000 };
    const listing = feedListing('9001', 1_000);
    await feed(h, listing);
    await settle();
    expect((sends[0]?.at ?? 0) - listing.firstSeenAt).toBe(550);
  });

  it('worst case of QTS’s own part: a journal row not open within the second is never sent (and is settled not_sent once it opens)', async () => {
    const h = await running([rule()]);
    server.openMs = 1_200;
    await feed(h, feedListing('9001', 1_000));
    await settle(3_000);
    expect(sends).toHaveLength(0);
    expect(h.engine.view().activity[0]).toMatchObject({ kind: 'failed', reason: 'journal_timeout' });
    const settled = server.requests.find((request) => request.kind === 'settle');
    expect(settled).toMatchObject({ result: { outcome: 'not_sent', sent: false } });
  });

  it('a journal opening at 999 ms still buys at 999 ms: QTS’s own part never exceeds the second', async () => {
    const h = await running([rule()]);
    server.openMs = BUY_ORDER_OWN_TIME_MS - 1;
    const listing = feedListing('9001', 1_000);
    await feed(h, listing);
    await settle();
    expect((sends[0]?.at ?? 0) - listing.firstSeenAt).toBe(999);
  });

  it('an estimate slower than the second: the rule cannot decide, nothing is bought', async () => {
    const h = await running([rule({ maxPriceCents: null, belowEstimatePct: 5 })]);
    server.estimateMs = 1_500;
    server.estimates = { '9001': 2_000 };
    await feed(h, feedListing('9001', 1_000));
    await settle(3_000);
    expect(h.executed).toHaveLength(0);
  });

  it('a slow marketplace re-read (3 s) is not QTS’s time: the request leaves right after it', async () => {
    const h = await running([rule()]);
    market.rereadMs = 3_000;
    const listing = feedListing('9001', 1_000);
    await feed(h, listing);
    await settle(5_000);
    const latency = (sends[0]?.at ?? 0) - listing.firstSeenAt;
    expect(latency).toBe(3_000);
    // QTS's own part: everything but the re-read.
    expect(latency - market.rereadMs).toBeLessThanOrEqual(BUY_ORDER_OWN_TIME_MS);
  });

  it('an account confirmation older than its TTL: the executor reads the account again before the listing', async () => {
    const h = await running([rule()]);
    h.accounts.invalidate('csfloat.com');
    const listing = feedListing('9001', 1_000);
    await feed(h, listing);
    await settle();
    expect(reads.map((read) => read.url)).toEqual(['https://csfloat.com/api/v1/me', 'https://csfloat.com/api/v1/listings/9001']);
    expect(sends).toHaveLength(1);
  });

  it('keeps the account confirmation fresh in the background (one read before the TTL ends)', async () => {
    const h = await running([rule({ sources: ['csfloat'] })]);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(reads.filter((read) => read.url.endsWith('/api/v1/me')).length).toBeGreaterThanOrEqual(1);
    expect(h.accounts.get('csfloat.com', STEAM)).not.toBeNull();
    void ENGINE_TICK_MS;
  });
});

describe('the marketplace session changed (M1)', () => {
  it.each([
    [{ domain: '.csfloat.com', name: 'session' }, 'csfloat.com'],
    [{ domain: 'csfloat.com', name: 'refresh_token' }, 'csfloat.com'],
    [{ domain: '.cs.money', name: 'steamid' }, 'cs.money'],
    [{ domain: 'cs.money', name: 'csgo_ses' }, 'cs.money'],
    [{ domain: '.csfloat.com', name: '_ga' }, null],
    [{ domain: '.cs.money', name: '__cf_bm' }, null],
    [{ domain: '.notcsfloat.com', name: 'session' }, null],
    [{ domain: '.steamcommunity.com', name: 'steamLoginSecure' }, null],
  ])('%o drops the confirmation of %s', (cookie, platform) => {
    expect(accountPlatformOfCookie(cookie)).toBe(platform);
  });
});
