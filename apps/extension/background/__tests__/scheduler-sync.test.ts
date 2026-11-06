import { type RepriceResponse, type ScheduledRule, type ScheduledSyncRule, SYNC_FACTORS_MAX_AGE_MS } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSyncRule, csfloatSyncReference } from '../../test-support/web/sell/priceSync';
import { buildRepriceTemplate } from '../../test-support/web/sell/repriceSchedule';
import { hasPermission } from '../permissions';
import { proxyRequest } from '../proxy';
import type * as Scheduler from '../scheduler';
import { chromeStored } from './chrome-storage';

vi.mock('../permissions', () => ({ hasPermission: vi.fn() }));
vi.mock('../proxy', () => ({ proxyRequest: vi.fn() }));
vi.mock('@/shared/utils', () => ({ wait: vi.fn(async () => undefined) }));

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ASSET = '31000000001';
const LISTING = '900000000000000001';
const proxy = vi.mocked(proxyRequest);
let storage: Record<string, unknown>;
let scheduler: typeof Scheduler;
const ok = (data: unknown): RepriceResponse => ({ ok: true, status: 200, data });

/** A cs.money ask that follows the item's CSFloat listing (QUICK-296), as the web registers it. */
function follower(overrides: Partial<ScheduledSyncRule> = {}): ScheduledSyncRule {
  const rule = buildSyncRule({
    itemId: ASSET,
    marketHashName: 'fixture',
    platform: 'cs.money',
    syncedPrice: 10,
    reference: csfloatSyncReference(ASSET, LISTING)!,
    factors: { reference: 1, follower: 1 },
    now: NOW - HOUR,
  })!;
  // As the extension stores it: active, due now.
  return { ...rule, syncActivationRequested: undefined, active: true, ...overrides };
}

function seed(rules: ScheduledRule[], extra: Record<string, unknown> = {}) {
  storage['rule_index'] = rules.map((rule) => rule.ruleId);
  for (const rule of rules) storage[`rule:${rule.ruleId}`] = chromeStored(rule);
  storage['qts_platform_catalog'] = [
    { id: 'cs.money', label: 'CS.Money', origins: ['https://cs.money/*'] },
    { id: 'csfloat.com', label: 'CSFloat', origins: ['https://csfloat.com/*'] },
  ];
  Object.assign(storage, extra);
}

interface Market {
  /** The CSFloat reference listing's answer. */
  reference?: RepriceResponse;
  /** cs.money's inventory: is the follower's ask live. */
  followerListed?: boolean;
}

function markets({ reference = ok(csfloatListing(1000)), followerListed = true }: Market = {}) {
  proxy.mockImplementation(async (url, options) => {
    if (options.method !== 'GET') return ok({});
    if (String(url).startsWith('https://csfloat.com/')) return reference;
    return ok({
      items: [
        { id: ASSET, onSale: followerListed },
        { id: '42', onSale: false },
      ],
    });
  });
}

function csfloatListing(priceCents: number, state = 'listed') {
  return { id: LISTING, state, price: priceCents, item: { asset_id: ASSET } };
}

const writes = () => proxy.mock.calls.filter(([, options]) => options.method !== 'GET');
const requestedUrls = () => proxy.mock.calls.map(([url]) => String(url));
const stored = (ruleId = `sync:${ASSET}:cs.money`) => storage[`rule:${ruleId}`] as ScheduledSyncRule | undefined;
const writtenPrice = () => (JSON.parse(String(writes()[0]![1].body)) as { items: Array<{ price: number }> }).items[0]!.price;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  storage = {};
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null) return chromeStored(storage);
          return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((key) => key in storage).map((key) => [key, chromeStored(storage[key])]));
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storage, chromeStored(values));
        }),
        remove: vi.fn(async (key: string) => {
          delete storage[key];
        }),
      },
    },
    alarms: { create: vi.fn() },
  });
  vi.mocked(hasPermission).mockResolvedValue(true);
  scheduler = await import('../scheduler');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('price followers (QUICK-296)', () => {
  it('reads the reference first, then its own listing, and writes the reference price', async () => {
    seed([follower({ syncedPrice: 9 })]);
    markets({ reference: ok(csfloatListing(1000)) });

    await scheduler.processDueRules();

    expect(requestedUrls()[0]).toBe(`https://csfloat.com/api/v1/listings/${LISTING}`);
    expect(writes()).toHaveLength(1);
    expect(writtenPrice()).toBe(10);
    // syncedAt: when the price was written, so the page applies the change only over an inventory read before it.
    expect(stored()).toMatchObject({ active: true, syncedPrice: 10, lastAppliedDay: 1, syncedAt: NOW, nextSyncAt: NOW + 3 * HOUR });
  });

  it('moves the price through the coefficients the web supplied', async () => {
    seed([follower({ factors: { reference: 0.95, follower: 0.9 } })]);
    markets({ reference: ok(csfloatListing(1000)) });

    await scheduler.processDueRules();

    // round2(round2(10 × 0.95) ÷ 0.9): the web's mirrorPrice.
    expect(writtenPrice()).toBe(10.56);
  });

  it('writes nothing while the follower already has the price, and runs again a period later', async () => {
    seed([follower({ syncedPrice: 10 })]);
    markets({ reference: ok(csfloatListing(1000)) });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(0);
    expect(stored()).toMatchObject({ active: true, syncedPrice: 10, lastAppliedDay: 0, nextSyncAt: NOW + 3 * HOUR });
    expect(stored()).not.toHaveProperty('syncedAt');
  });

  it('stops for good, without reading or writing its own listing, when the reference is sold', async () => {
    seed([follower({ syncedPrice: 9 })]);
    markets({ reference: ok(csfloatListing(1000, 'sold')) });

    await scheduler.processDueRules();

    expect(requestedUrls()).toHaveLength(1);
    expect(writes()).toHaveLength(0);
    expect(stored()).toMatchObject({ active: false, retiredReason: 'reference_gone' });
  });

  it('stops when the reference listing is gone (404)', async () => {
    seed([follower({ syncedPrice: 9 })]);
    markets({ reference: { ok: false, status: 404, data: null } });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(0);
    expect(stored()).toMatchObject({ retiredReason: 'reference_gone' });
  });

  it('never follows a reference it cannot read: a rate limit backs CSFloat off and the rule retries later', async () => {
    seed([follower({ syncedPrice: 9 })]);
    markets({ reference: { ok: false, status: 429, data: null, headers: { 'retry-after': '120' } } });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(0);
    expect(requestedUrls()).toHaveLength(1);
    expect(stored()).toMatchObject({ active: true, transientFailures: 1, lastMessage: 'reference_check_http_error' });
    expect((storage['reprice_backoff'] as Record<string, number>)['csfloat.com']).toBe(NOW + 120_000);
  });

  it('never follows a listed reference without a price', async () => {
    seed([follower({ syncedPrice: 9 })]);
    markets({ reference: ok({ ...csfloatListing(1000), price: null }) });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(0);
    expect(stored()).toMatchObject({ active: true, consecutiveFailures: 1, lastMessage: 'reference_reference_price_missing' });
  });

  it('waits for a reference market that backs off, without any request or record', async () => {
    const rule = follower({ syncedPrice: 9 });
    seed([rule], { reprice_backoff: { 'csfloat.com': NOW + HOUR } });
    markets();

    await scheduler.processDueRules();

    expect(proxy).not.toHaveBeenCalled();
    expect(stored()).toEqual(chromeStored(rule));
  });

  it('runs only once its period is over', async () => {
    seed([follower({ nextSyncAt: NOW + HOUR })]);
    markets();

    await scheduler.processDueRules();

    expect(proxy).not.toHaveBeenCalled();
  });

  it('pauses without a request once the web has not refreshed its factors for a week', async () => {
    seed([follower({ factorsAt: NOW - SYNC_FACTORS_MAX_AGE_MS })]);
    markets();

    await scheduler.processDueRules();

    expect(proxy).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ active: false, pausedReason: 'sync_factors_stale' });
  });

  it('writes nothing when its own listing is not live (the two-read retirement of a reprice rule applies)', async () => {
    seed([follower({ syncedPrice: 9 })]);
    markets({ followerListed: false });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(0);
    expect(stored()).toMatchObject({ active: true, pendingNotListedAt: NOW });
  });
});

describe('registering price followers (QUICK-296)', () => {
  function registration(): ScheduledSyncRule {
    return buildSyncRule({
      itemId: ASSET,
      marketHashName: 'fixture',
      platform: 'cs.money',
      syncedPrice: 10,
      reference: csfloatSyncReference(ASSET, LISTING)!,
      factors: { reference: 1, follower: 1 },
      now: NOW,
    })!;
  }

  function ramp(): ScheduledRule {
    return {
      ruleId: `${ASSET}:cs.money`,
      platform: 'cs.money',
      itemId: ASSET,
      marketHashName: 'fixture',
      firstPrice: 10,
      secondPrice: 8,
      startAt: NOW,
      days: 2,
      lastAppliedDay: 0,
      template: buildRepriceTemplate('cs.money', ASSET, undefined)!,
      active: true,
      createdAt: NOW,
    };
  }

  it('stores it active and due at once', async () => {
    seed([]);
    await scheduler.registerRule(registration());

    expect(stored()).toMatchObject({ kind: 'sync', active: true, nextSyncAt: NOW, everyMs: 3 * HOUR });
    expect(stored()).not.toHaveProperty('syncActivationRequested');
    expect(storage['rule_index']).toEqual([`sync:${ASSET}:cs.money`]);
  });

  it('refuses a follower whose reference is its own market or whose factors are broken', async () => {
    seed([]);
    await expect(scheduler.registerRule({ ...registration(), factors: { reference: 1, follower: 0 } })).rejects.toThrow('invalid_sync_rule');
    await expect(scheduler.registerRule({ ...registration(), factors: { reference: 10, follower: 1 } })).rejects.toThrow('invalid_sync_rule');
    expect(stored()).toBeUndefined();
  });

  it('keeps out of a pair whose auto-reprice ramp sets the price', async () => {
    seed([ramp()]);
    await scheduler.registerRule(registration());

    expect(stored()).toBeUndefined();
  });

  it('ends the pair’s follower when a ramp is registered, and with the pair’s cancel', async () => {
    seed([follower()]);
    await scheduler.registerRule(ramp());
    expect(stored()).toBeUndefined();

    seed([follower()]);
    await scheduler.cancelRule(`${ASSET}:cs.money`);
    expect(stored()).toBeUndefined();
    expect(storage['rule_index']).toEqual([]);
  });

  it('cancels only the follower by its own id', async () => {
    seed([follower(), ramp()]);
    await scheduler.cancelRule(`sync:${ASSET}:cs.money`);

    expect(stored()).toBeUndefined();
    expect(stored(`${ASSET}:cs.money`)).toBeDefined();
  });
});
