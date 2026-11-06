import type { RepriceResponse, ScheduledRule } from '@qts/contracts';
import { REPRICE_FAILURE_RETRY_MS } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wait } from '@/shared/utils';

// The templates the web really sends (no platform logic lives in the extension).
import { buildRepriceTemplate } from '../../test-support/web/sell/repriceSchedule';
import { hasPermission } from '../permissions';
import { proxyRequest } from '../proxy';
import type * as Scheduler from '../scheduler';
import { chromeStored } from './chrome-storage';

vi.mock('../permissions', () => ({ hasPermission: vi.fn() }));
vi.mock('../proxy', () => ({ proxyRequest: vi.fn() }));
vi.mock('@/shared/utils', () => ({ wait: vi.fn(async () => undefined) }));

const DAY = 86_400_000;
const NOW = 30 * DAY;
const proxy = vi.mocked(proxyRequest);
let storage: Record<string, unknown>;
let scheduler: typeof Scheduler;
let log: string[];

function ruleFor(platform: 'cs.money' | 'csfloat.com', itemId: string, listingId?: string): ScheduledRule {
  return {
    ruleId: `${itemId}:${platform}`,
    platform,
    itemId,
    marketHashName: 'fixture',
    firstPrice: 100,
    secondPrice: 80,
    startAt: NOW - 2 * DAY,
    days: 5,
    lastAppliedDay: 0,
    template: buildRepriceTemplate(platform, itemId, listingId)!,
    active: true,
    createdAt: NOW - 2 * DAY,
  };
}
function seed(...rules: ScheduledRule[]) {
  storage['rule_index'] = rules.map((r) => r.ruleId);
  for (const r of rules) storage[`rule:${r.ruleId}`] = chromeStored(r);
}
async function stored(): Promise<ScheduledRule | undefined> {
  return (await scheduler.getRules())[0];
}

/** A cs.money seller with 130 items (three 60-row pages); rows carry cs.money's own id and the Steam asset id. */
function csMoney(onSale: (assetId: number) => boolean, write: (body: string) => RepriceResponse) {
  const inventory = Array.from({ length: 130 }, (_, i) => ({ id: 900_000 + i, assetId: 1000 + i, onSale: onSale(1000 + i) }));
  proxy.mockImplementation(async (url, options) => {
    if (options.method === 'GET') {
      const offset = Number(new URL(url).searchParams.get('offset'));
      log.push(`GET ${new URL(url).pathname} offset=${offset}`);
      return { ok: true, status: 200, data: { items: inventory.slice(offset, offset + 60) } };
    }
    log.push(`${options.method} ${new URL(url).pathname} ${options.body}`);
    return write(options.body ?? '');
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  storage = {};
  log = [];
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null) return chromeStored(storage);
          const result: Record<string, unknown> = {};
          for (const key of typeof keys === 'string' ? [keys] : keys) if (key in storage) result[key] = chromeStored(storage[key]);
          return result;
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
  vi.mocked(wait).mockImplementation(async (ms: number) => {
    log.push(`wait ${ms}`);
  });
  scheduler = await import('../scheduler');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('web-built templates through the real scheduler', () => {
  it('cs.money: scans the inventory pages, then posts the day-2 price for the asset', async () => {
    seed(ruleFor('cs.money', '1125'));
    csMoney(
      () => true,
      () => ({ ok: true, status: 200, data: {} })
    );
    await scheduler.processDueRules();
    expect(log).toEqual([
      'GET /1.0/market/user-inventory offset=0',
      'wait 500',
      'GET /1.0/market/user-inventory offset=60',
      'wait 500',
      'GET /1.0/market/user-inventory offset=120',
      'wait 500',
      'POST /1.0/market/sell-orders {"items":[{"id":1125,"price":92}]}',
    ]);
    expect(await stored()).toMatchObject({ active: true, lastAppliedDay: 2, consecutiveFailures: 0 });
  });

  it('cs.money: a 2xx that rejects the asset is a counted failure, not a step', async () => {
    seed(ruleFor('cs.money', '1010'));
    csMoney(
      () => true,
      () => ({ ok: true, status: 200, data: { errors: [{ id: 1010, message: 'Price too low' }] } })
    );
    await scheduler.processDueRules();
    expect(await stored()).toMatchObject({ active: true, lastAppliedDay: 0, consecutiveFailures: 1, lastMessage: 'step_item_rejected' });
  });

  it('cs.money: an item delisted outside QTS is never posted and retires after two checks', async () => {
    seed(ruleFor('cs.money', '1010'));
    csMoney(
      (assetId) => assetId !== 1010,
      () => ({ ok: true, status: 200, data: {} })
    );
    await scheduler.processDueRules();
    vi.resetModules();
    scheduler = await import('../scheduler');
    vi.spyOn(Date, 'now').mockReturnValue(NOW + REPRICE_FAILURE_RETRY_MS);
    await scheduler.processDueRules();
    expect(log.some((entry) => entry.startsWith('POST'))).toBe(false);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'not_listed', lastCheckStatus: false });
  });

  it('CSFloat: reads the listing, then patches the day-2 price in cents', async () => {
    seed(ruleFor('csfloat.com', '777', '982666213350049411'));
    proxy.mockImplementation(async (url, options) => {
      log.push(`${options.method} ${new URL(url).pathname}${options.body ? ` ${options.body}` : ''}`);
      return options.method === 'GET' ? { ok: true, status: 200, data: { id: '982666213350049411', item: { asset_id: '777' }, state: 'listed' } } : { ok: true, status: 200, data: {} };
    });
    await scheduler.processDueRules();
    expect(log).toEqual(['GET /api/v1/listings/982666213350049411', 'wait 500', 'PATCH /api/v1/listings/982666213350049411 {"price":9200}']);
    expect(await stored()).toMatchObject({ lastAppliedDay: 2, lastCheckStatus: 'listed' });
  });

  it.each([
    ['sold', { active: false, retiredReason: 'not_listed' }],
    ['some-new-state', { active: true, consecutiveFailures: 2, lastMessage: 'unknown_listing_state' }],
  ] as const)('CSFloat: state %s over two checks never patches', async (state, outcome) => {
    seed(ruleFor('csfloat.com', '777', '982666213350049411'));
    proxy.mockImplementation(async (_url, options) =>
      options.method === 'GET' ? { ok: true, status: 200, data: { id: '982666213350049411', item: { asset_id: '777' }, state } } : { ok: true, status: 200, data: {} }
    );
    await scheduler.processDueRules();
    vi.spyOn(Date, 'now').mockReturnValue(NOW + REPRICE_FAILURE_RETRY_MS);
    await scheduler.processDueRules();
    expect(proxy.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    expect(await stored()).toMatchObject(outcome);
  });
});
