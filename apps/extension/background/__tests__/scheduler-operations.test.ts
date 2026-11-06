// The scheduler fires stored templates without a tab: only schedulable allowlisted operations (QUICK-171),
// checked when a rule is registered AND right before each request is sent.
import type { ScheduledListingRule, ScheduledRule } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildRepriceTemplate } from '../../test-support/web/sell/repriceSchedule';
import { buildListingTemplate } from '../../test-support/web/sell/scheduledListing';
import { hasPermission } from '../permissions';
import { proxyRequest } from '../proxy';
import type * as Scheduler from '../scheduler';
import { chromeStored } from './chrome-storage';

vi.mock('../permissions', () => ({ hasPermission: vi.fn() }));
vi.mock('../proxy', () => ({ proxyRequest: vi.fn() }));
vi.mock('@/shared/utils', () => ({ wait: vi.fn(async () => undefined) }));

const DAY = 86_400_000;
const NOW = 30 * DAY;
const STEAM_ID = '76561198000000042';
const proxy = vi.mocked(proxyRequest);
let storage: Record<string, unknown>;
let scheduler: typeof Scheduler;

function reprice(template = buildRepriceTemplate('cs.money', '42', undefined)!): ScheduledRule {
  return {
    ruleId: '42:cs.money',
    platform: 'cs.money',
    itemId: '42',
    marketHashName: 'fixture',
    firstPrice: 100,
    secondPrice: 80,
    startAt: NOW - 2 * DAY,
    days: 5,
    lastAppliedDay: 0,
    template,
    active: true,
    createdAt: NOW - 2 * DAY,
  };
}
function seed(...rules: ScheduledRule[]) {
  storage['rule_index'] = rules.map((rule) => rule.ruleId);
  for (const rule of rules) storage[`rule:${rule.ruleId}`] = chromeStored(rule);
}
async function stored(): Promise<ScheduledRule | undefined> {
  return (await scheduler.getRules())[0];
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
  proxy.mockImplementation(async (url, options) => (options.method === 'GET' ? { ok: true, status: 200, data: { items: [{ id: '42', onSale: true }] } } : { ok: true, status: 200, data: {} }));
  scheduler = await import('../scheduler');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('registration', () => {
  it('accepts the templates the web builds', async () => {
    await scheduler.registerRule({ ...reprice(), activationRequested: true });
    expect(await stored()).toMatchObject({ ruleId: '42:cs.money', active: true });
    const listing: ScheduledListingRule = {
      ...reprice(),
      kind: 'list',
      ruleId: 'list:42:csfloat.com',
      platform: 'csfloat.com',
      days: 0,
      listAt: NOW + DAY,
      fixedPrice: 234,
      template: buildListingTemplate('csfloat.com', '42', 2.34, STEAM_ID)!,
      listingActivationRequested: true,
    };
    await scheduler.registerRule(listing);
    expect((await scheduler.getRules()).map((rule) => rule.ruleId)).toContain('list:42:csfloat.com');
  });

  it.each([
    ['a write that is not a schedulable operation (remove)', { ...buildRepriceTemplate('cs.money', '42', undefined)!, method: 'DELETE', bodyTemplate: '{"id":[42],"p":__PRICE__}' }, 'purpose'],
    ['a write to another host', { ...buildRepriceTemplate('cs.money', '42', undefined)!, url: 'https://evil.test/1.0/market/sell-orders' }, 'host'],
    ['a write with an extra header', { ...buildRepriceTemplate('cs.money', '42', undefined)!, headers: { 'Content-Type': 'application/json', Cookie: 'x=1' } }, 'header'],
    [
      'a check that reads a non-check endpoint',
      {
        ...buildRepriceTemplate('cs.money', '42', undefined)!,
        checkTemplate: { ...buildRepriceTemplate('cs.money', '42', undefined)!.checkTemplate!, request: { url: 'https://cs.money/1.0/market/history', method: 'GET' as const } },
      },
      // The history read is no check operation: it does not even take the scheduler's Cache-Control header.
      'header',
    ],
  ])('refuses %s and stores nothing', async (_name, template, reason) => {
    await expect(scheduler.registerRule({ ...reprice(template), activationRequested: true })).rejects.toThrow(`operation_refused:${reason}`);
    expect(await scheduler.getRules()).toEqual([]);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('answers the page with the typed refusal', async () => {
    vi.doMock('../scheduler', () => scheduler);
    const { handleSiteMessage } = await import('../handlers/site');
    const rule = { ...reprice({ ...buildRepriceTemplate('cs.money', '42', undefined)!, method: 'DELETE' }), activationRequested: true };
    expect(await handleSiteMessage({ type: 'site:register_rule', data: rule as unknown as NonNullable<Parameters<typeof handleSiteMessage>[0]['data']> })).toEqual({
      ok: false,
      error: 'operation_refused:purpose',
    });
  });
});

describe('fire time (rules stored by an older extension)', () => {
  it('pauses a rule whose write is not schedulable, after its read-only check and before any write', async () => {
    seed(reprice({ ...buildRepriceTemplate('cs.money', '42', undefined)!, method: 'DELETE' }));
    await scheduler.processDueRules();
    expect(proxy.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    expect(proxy.mock.calls.every(([, options]) => options.purpose === 'schedule-check' && options.platform === 'cs.money')).toBe(true);
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'operation_not_allowed', pausedAt: NOW, lastMessage: 'operation_refused:purpose' });
  });

  it('pauses a rule whose check is not allowlisted without any request', async () => {
    const template = buildRepriceTemplate('csfloat.com', '42', '987654321')!;
    seed({
      ...reprice(template),
      ruleId: '42:csfloat.com',
      platform: 'csfloat.com',
      template: { ...template, checkTemplate: { ...template.checkTemplate!, request: { url: 'https://csfloat.com/api/v1/me/api-keys', method: 'GET' } } },
    });
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'operation_not_allowed', lastMessage: 'operation_refused:path' });
  });

  it('a refused one-shot listing is never reserved or sent', async () => {
    const template = buildListingTemplate('cs.money', '42', 2.34, STEAM_ID)!;
    const listing: ScheduledListingRule = {
      ...reprice(),
      kind: 'list',
      ruleId: 'list:42:cs.money',
      days: 0,
      listAt: NOW - 1000,
      fixedPrice: 2.34,
      template: { ...template, url: 'https://cs.money/screenshots' },
    };
    seed(listing);
    proxy.mockResolvedValue({ ok: true, status: 200, data: { items: [{ id: '42', onSale: false }] } });
    await scheduler.processDueRules();
    expect(proxy.mock.calls.filter(([, options]) => options.method !== 'GET')).toEqual([]);
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'operation_not_allowed', lastMessage: 'operation_refused:purpose' });
  });

  it('fires an allowlisted write with its platform and purpose', async () => {
    seed(reprice());
    await scheduler.processDueRules();
    const write = proxy.mock.calls.find(([, options]) => options.method === 'POST');
    expect(write?.[1]).toMatchObject({ platform: 'cs.money', purpose: 'schedule-write' });
    expect((await stored())?.pausedReason).toBeUndefined();
  });
});
