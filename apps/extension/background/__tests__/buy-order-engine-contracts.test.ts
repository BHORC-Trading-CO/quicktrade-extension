// QUICK-233: the pure pieces of the buy-order engine (packages/contracts/src/buy-order-engine.ts) and the account
// confirmation cache: every guard on its own, in its order; what counts as a failure; the lease on this computer's
// clock; the strict readers of what the page sends.
import type { BuyOrderGuardInput, BuyOrdersSpend, MarketFeedListing } from '@qts/contracts';
import {
  BUY_ORDER_ACCOUNT_TTL_MS,
  buyOrderFailureEffect,
  buyOrderListingFromFeedEntry,
  checkBuyOrderGuards,
  localLeaseUntil,
  MARKET_BUY_OUTCOMES,
  parseBuyOrdersEngineAnswer,
  parseBuyOrdersLeasePush,
} from '@qts/contracts';
import { describe, expect, it } from 'vitest';

import { MarketAccountCache } from '../market-buy/account-cache';

const spend = (accountCents: number, rule: { cents: number; items: number } | null = null): BuyOrdersSpend => ({
  day: '2026-10-25',
  dayEndsAt: Date.UTC(2026, 9, 26),
  accountCents,
  accountItems: 0,
  rules: rule ? { r1: rule } : {},
});

const input = (patch: Partial<BuyOrderGuardInput> = {}): BuyOrderGuardInput => ({
  rule: { id: 'r1', maxPriceCents: 10_000, dailyBudgetCents: 20_000, maxItemsPerDay: 2 },
  accountBudgetCents: 50_000,
  priceCents: 10_000,
  spend: spend(0),
  balanceCents: 10_000,
  failures: 0,
  listingTried: false,
  steamLinked: true,
  sourceEnabled: true,
  ...patch,
});

describe('checkBuyOrderGuards (R-F3)', () => {
  it('lets a buy through that is exactly at every limit', () => {
    expect(checkBuyOrderGuards(input({ spend: spend(40_000, { cents: 10_000, items: 1 }) }))).toBeNull();
  });

  it.each([
    ['rule_paused', { failures: 3 }],
    ['failures_pending', { failures: 2, running: 1 }],
    ['failures_pending', { failures: 1, running: 2 }],
    ['steam_link_required', { steamLinked: false }],
    ['source_disabled', { sourceEnabled: false }],
    ['price_invalid', { priceCents: 100.5 }],
    ['price_invalid', { priceCents: 0 }],
    ['price_above_limit', { priceCents: 10_001, balanceCents: null }],
    ['listing_tried', { listingTried: true }],
    ['account_budget_unset', { accountBudgetCents: null }],
    ['spend_unknown', { spend: null }],
    ['account_budget', { spend: spend(40_001) }],
    ['rule_budget', { spend: spend(0, { cents: 10_001, items: 0 }) }],
    ['items', { spend: spend(0, { cents: 0, items: 2 }) }],
    ['balance', { balanceCents: 9_999 }],
  ] as const)('refuses with %s', (code, patch) => {
    expect(checkBuyOrderGuards(input(patch as Partial<BuyOrderGuardInput>))?.code).toBe(code);
  });

  it('checks the price limit itself, not only through the matcher', () => {
    expect(checkBuyOrderGuards(input({ priceCents: 10_001, rule: { id: 'r1', maxPriceCents: 10_000, dailyBudgetCents: 99_999, maxItemsPerDay: 9 } }))).toEqual({
      code: 'price_above_limit',
      priceCents: 10_001,
      limitCents: 10_000,
    });
  });

  it('attempts running with no failure yet are not held back; with failures they may not reach the limit together', () => {
    expect(checkBuyOrderGuards(input({ failures: 0, running: 5 }))).toBeNull();
    expect(checkBuyOrderGuards(input({ failures: 2, running: 0 }))).toBeNull();
    expect(checkBuyOrderGuards(input({ failures: 1, running: 1 }))).toBeNull();
  });

  it('an unknown balance is left to the executor and the market (never assumed short or enough)', () => {
    expect(checkBuyOrderGuards(input({ balanceCents: null }))).toBeNull();
  });
});

describe('buyOrderFailureEffect (R-F3: 3 failed buys in a row)', () => {
  it('bought ends a run; a sent request refused or with an unknown result is a failure; outages and races lost are neutral', () => {
    const effects = Object.fromEntries(MARKET_BUY_OUTCOMES.map((outcome) => [outcome, buyOrderFailureEffect(outcome, true)]));
    expect(effects).toEqual({
      bought: 'success',
      sold: 'neutral',
      price_changed: 'neutral',
      busy: 'neutral',
      insufficient_balance: 'failure',
      captcha: 'neutral',
      rate_limited: 'neutral',
      two_factor_required: 'failure',
      cannot_trade: 'failure',
      signed_out: 'failure',
      refused: 'failure',
      not_sent: 'neutral',
      unknown: 'failure',
    });
  });

  it('nothing sent says nothing about the rule, whatever the outcome', () => {
    for (const outcome of MARKET_BUY_OUTCOMES) if (outcome !== 'bought') expect(buyOrderFailureEffect(outcome, false)).toBe('neutral');
  });
});

describe('the lease on this computer’s clock (R-F8)', () => {
  it('ends no later than its server end, counted from when the request left', () => {
    // The server answered 400 ms after the request left, with its clock 3 s ahead of ours.
    expect(localLeaseUntil({ serverNow: 1_003_400, lease: { expiresAt: 1_063_400 } }, 1_000_000)).toBe(1_060_000);
    expect(localLeaseUntil({ serverNow: 1, lease: null }, 1)).toBeNull();
  });
});

describe('reading what the page sends', () => {
  const status = {
    clerkId: 'user_a1',
    serverNow: 1_000,
    switchedOn: true,
    stoppedAt: null,
    steamId: '76561198000000001',
    lease: { leaseId: 'lease-aaaaaaaa', deviceId: '00000000-0000-4000-8000-0000000000aa', deviceLabel: null, renewedAt: 1_000, expiresAt: 61_000 },
    spend: spend(0),
  };
  const push = { clerkId: 'user_a1', status, requestedAt: 900, receivedAt: 1_100, feed: null };

  it('takes a well-formed lease push', () => {
    expect(parseBuyOrdersLeasePush(push)).toMatchObject({ clerkId: 'user_a1', status: { clerkId: 'user_a1' } });
    expect(parseBuyOrdersLeasePush({ ...push, status: null })).toMatchObject({ status: null });
    // The server's count of each rule's failures from the journal; none from a server before it.
    expect(parseBuyOrdersLeasePush({ ...push, status: { ...status, failures: { r1: 2 } } })?.status?.failures).toEqual({ r1: 2 });
    expect(parseBuyOrdersLeasePush(push)?.status?.failures).toEqual({});
  });

  it.each([
    ['the server’s account differs from the page’s', { ...push, clerkId: 'user_b2' }],
    ['a received time before the request', { ...push, receivedAt: 800 }],
    ['a device id that is no UUID', { ...push, status: { ...status, lease: { ...status.lease, deviceId: 'phone' } } }],
    ['a spend in dollars', { ...push, status: { ...status, spend: { ...spend(0), accountCents: 1.5 } } }],
    ['a Steam id that is not one', { ...push, status: { ...status, steamId: '123' } }],
    ['a failure count that is not a whole number', { ...push, status: { ...status, failures: { r1: 1.5 } } }],
    ['failures that are not a map', { ...push, status: { ...status, failures: [3] } }],
    ['a feed request that is no GET', { ...push, feed: { sources: [{ source: 'csfloat', request: { url: 'x', method: 'POST' } }] } }],
  ])('refuses %s', (_name, value) => {
    expect(parseBuyOrdersLeasePush(value)).toBeNull();
  });

  it('reads the page’s answers strictly', () => {
    expect(parseBuyOrdersEngineAnswer({ requestId: 'q', kind: 'open', outcome: 'refused', code: 'buy_orders_items' })).toMatchObject({ outcome: 'refused' });
    expect(parseBuyOrdersEngineAnswer({ requestId: 'q', kind: 'open', outcome: 'opened', response: { attemptId: 'a', state: 'bought', serverNow: 1, spend: spend(0) } })).toBeNull();
    expect(parseBuyOrdersEngineAnswer({ requestId: 'q', kind: 'open', outcome: 'refused', code: 'Free text!' })).toBeNull();
    expect(parseBuyOrdersEngineAnswer({ requestId: 'q', kind: 'estimates', estimates: { 'csfloat:1': 12.5 } })).toBeNull();
    expect(parseBuyOrdersEngineAnswer({ requestId: 'q', kind: 'estimates', estimates: { 'csfloat:1': 1250, 'csfloat:2': null } })).toMatchObject({ estimates: { 'csfloat:1': 1250 } });
  });
});

describe('buyOrderListingFromFeedEntry', () => {
  it('reads a CSFloat Doppler’s phase from its paint index, and nothing else of the row', () => {
    const entry = {
      key: 'csfloat:1',
      source: 'csfloat',
      listingId: '1',
      marketHashName: '★ Karambit | Doppler (Factory New)',
      priceCents: 120_000,
      float: 0.01,
      paintSeed: 3,
      paintIndex: 416,
      defIndex: 507,
      isStatTrak: false,
      isSouvenir: false,
      stickers: [{ name: 'Sticker | Titan', priceCents: 900 }],
      image: null,
      listedAt: 1,
      firstSeenAt: 5,
      lastSeenAt: 5,
      latencyMs: 4,
      baseline: false,
      goneAt: null,
      seq: 1,
    } satisfies MarketFeedListing;
    expect(buyOrderListingFromFeedEntry(entry)).toEqual({
      source: 'csfloat',
      listingId: '1',
      marketHashName: '★ Karambit | Doppler (Factory New)',
      priceCents: 120_000,
      floatValue: 0.01,
      paintSeed: 3,
      phase: 'Sapphire',
      stickers: [{ name: 'Sticker | Titan', priceCents: 900 }],
      referencePriceCents: null,
      seenAt: 5,
    });
  });
});

describe('MarketAccountCache (R-F7: the account check never fails open)', () => {
  it('answers only for the confirmed Steam account, only within its TTL', () => {
    let now = 1_000;
    const cache = new MarketAccountCache(() => now);
    cache.put('csfloat.com', '76561198000000001', 5_000);
    expect(cache.get('csfloat.com', '76561198000000001')).toEqual({ balanceCents: 5_000, at: 1_000 });
    expect(cache.get('csfloat.com', '76561198000000002')).toBeNull();
    expect(cache.get('cs.money', '76561198000000001')).toBeNull();
    now += BUY_ORDER_ACCOUNT_TTL_MS;
    expect(cache.get('csfloat.com', '76561198000000001')).toBeNull();
  });

  it('a buy that may have spent lowers the balance; an invalidation drops it', () => {
    const cache = new MarketAccountCache(() => 1);
    cache.put('cs.money', '76561198000000001', 5_000);
    cache.spend('cs.money', 3_000);
    expect(cache.get('cs.money', '76561198000000001')?.balanceCents).toBe(2_000);
    cache.spend('cs.money', 3_000);
    expect(cache.get('cs.money', '76561198000000001')?.balanceCents).toBe(0);
    cache.invalidate('cs.money');
    expect(cache.get('cs.money', '76561198000000001')).toBeNull();
  });
});
