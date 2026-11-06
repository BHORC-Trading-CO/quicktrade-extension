import {
  ARRIVAL_RETRY_MS,
  ARRIVAL_WAIT_MS,
  computeRepriceStep,
  computeScheduledStep,
  LISTING_OVERDUE_MS,
  MAX_REPRICE_FAILURES,
  recordListingAbsent,
  REPRICE_FAILURE_RETRY_MS,
  type RepriceResponse,
  type ScheduledListingRule,
  type ScheduledRule,
} from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_FIRES_PER_PASS, REPRICE_CONTINUE_ALARM } from '@/models/constants';

import { buildListingTemplate, csfloatLiveLotPrecondition } from '../../test-support/web/sell/scheduledListing';
import { hasPermission } from '../permissions';
import { proxyRequest } from '../proxy';
import type * as Scheduler from '../scheduler';
import { chromeStored } from './chrome-storage';

vi.mock('../permissions', () => ({ hasPermission: vi.fn() }));
vi.mock('../proxy', () => ({ proxyRequest: vi.fn() }));
vi.mock('@/shared/utils', () => ({ wait: vi.fn(async () => undefined) }));

const NOW = 1_800_000_000_000;
/** A Steam id: the CSFloat stall operation takes digits only (QUICK-171). */
const FIXTURE_STEAM_ID = '76561198000000042';
const proxy = vi.mocked(proxyRequest);
let storage: Record<string, unknown>;
let scheduler: typeof Scheduler;
const ok = (data: unknown): RepriceResponse => ({ ok: true, status: 200, data });
function listing(platform: 'cs.money' | 'csfloat.com' = 'cs.money', itemId = '42', listAt = NOW): ScheduledListingRule {
  return {
    kind: 'list',
    ruleId: `list:${itemId}:${platform}`,
    platform,
    itemId,
    marketHashName: 'fixture',
    listAt,
    fixedPrice: platform === 'csfloat.com' ? 234 : 2.34,
    template: buildListingTemplate(platform, itemId, 2.34, FIXTURE_STEAM_ID)!,
    days: 0,
    firstPrice: 2.34,
    secondPrice: 2.34,
    startAt: listAt,
    lastAppliedDay: 0,
    createdAt: NOW - 1000,
    active: true,
  };
}
function seed(...rules: ScheduledRule[]) {
  storage['rule_index'] = rules.map((rule) => rule.ruleId);
  for (const rule of rules) storage[`rule:${rule.ruleId}`] = chromeStored(rule);
}
async function stored() {
  return (await scheduler.getRules())[0]!;
}
const writes = () => proxy.mock.calls.filter(([, options]) => options.method !== 'GET');
function present(unlisted = true) {
  proxy.mockImplementation(async (url, options) => {
    if (options.method !== 'GET') return ok({ id: 'created-listing' });
    if (url.includes('/stall')) return ok({ data: unlisted ? [] : [{ id: 'listing', item: { asset_id: '42' } }], total_count: unlisted ? 0 : 1 });
    if (url.includes('csfloat.com')) return ok([{ asset_id: '42', tradable: 1 }]);
    return ok({ items: [{ id: '42', onSale: !unlisted }] });
  });
}
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

describe('one-shot listings through the real scheduler with web templates', () => {
  it('keeps a blocked one-shot and publishes after a newer clear, with no app tab API', async () => {
    const { setListingBlocks } = await import('../listing-blocks');
    seed({ ...listing(), owner: 'user_A' });
    present();
    await setListingBlocks({ owner: 'user_A', at: NOW, assetIds: ['42'], expiresAt: { '42': NOW + 604800000 } });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: true, lastMessage: 'sold_elsewhere' });
    vi.resetModules();
    scheduler = await import('../scheduler');
    await scheduler.ensureIndex();
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 60_000);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    const restarted = await import('../listing-blocks');
    await restarted.setListingBlocks({ owner: 'user_A', at: NOW + 60_001, assetIds: [], expiresAt: {} });
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 120_000);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'listed' });
  });

  it.each([undefined, 'user_A'])('no stored set preserves publishing for owner %s with no app tab', async (owner) => {
    seed({ ...listing(), owner });
    present();
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
    expect(await stored()).toMatchObject({ retiredReason: 'listed' });
  });

  it('another owner or asset does not block the rule', async () => {
    const { setListingBlocks } = await import('../listing-blocks');
    await setListingBlocks({ owner: 'user_B', at: NOW, assetIds: ['42'], expiresAt: { '42': NOW + 604800000 } });
    await setListingBlocks({ owner: 'user_A', at: NOW, assetIds: ['43'], expiresAt: { '43': NOW + 604800000 } });
    seed({ ...listing(), owner: 'user_A' });
    present();
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
  });

  it.each(['cs.money', 'csfloat.com'] as const)('%s: exactly one create, retired even across restart and inconclusive inventory', async (platform) => {
    seed(listing(platform));
    present();
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.[1].body).toBe(buildListingTemplate(platform, '42', 2.34, FIXTURE_STEAM_ID)!.bodyTemplate);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'listed' });
    vi.resetModules();
    scheduler = await import('../scheduler');
    proxy.mockResolvedValue(ok(null));
    await scheduler.ensureIndex();
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
  });
  it.each(['cs.money', 'csfloat.com'] as const)('%s: manual listing retires without a write', async (platform) => {
    seed(listing(platform));
    present(false);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'already_listed' });
  });
  it('two conclusive absent reads retire, while uncertainty breaks consecutive absence', async () => {
    seed(listing());
    proxy.mockResolvedValue(ok({ items: [{ id: '99', onSale: false }] }));
    await scheduler.processDueRules();
    expect((await stored()).pendingNotListedAt).toBe(NOW);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + REPRICE_FAILURE_RETRY_MS);
    proxy.mockResolvedValue(ok({ items: [] }));
    await scheduler.processDueRules();
    expect((await stored()).pendingNotListedAt).toBeUndefined();
    proxy.mockResolvedValue(ok({ items: [{ id: '99', onSale: false }] }));
    for (const n of [2, 3]) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW + n * REPRICE_FAILURE_RETRY_MS);
      await scheduler.processDueRules();
    }
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'not_in_inventory' });
  });
  it.each([429, 500, 503])('HTTP %i on the check backs off without counting, then checks again before listing', async (status) => {
    seed(listing());
    proxy.mockResolvedValue({ ok: false, status, data: { private: 'never persisted' }, headers: { 'retry-after': '120' } });
    await scheduler.processDueRules();
    const failed = await stored();
    expect(failed).toMatchObject({ active: true, consecutiveFailures: 0 });
    expect(JSON.stringify(failed)).not.toContain('never persisted');
    present();
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    vi.spyOn(Date, 'now').mockReturnValue(failed.nextAttemptAt!);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
  });
  it.each([408, 429, 500, 502, 504])('HTTP %i on the write may have been applied: paused as unknown, never retried', async (status) => {
    seed(listing());
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? ok({ items: [{ id: '42', onSale: false }] }) : { ok: false, status, data: null }));
    await scheduler.processDueRules();
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'listing_outcome_unknown', lastStatus: status });
    for (const later of [REPRICE_FAILURE_RETRY_MS, 2 * REPRICE_FAILURE_RETRY_MS]) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW + later);
      await scheduler.processDueRules();
    }
    expect(writes()).toHaveLength(1);
    expect(proxy.mock.calls.filter(([, options]) => options.method === 'GET')).toHaveLength(1);
  });
  it('Chrome key order: success retires as listed, a rejected write retries only after a fresh check', async () => {
    seed(listing('cs.money', '42'), listing('cs.money', '43'));
    let wrote42 = false;
    proxy.mockImplementation(async (_url, options) => {
      if (options.method === 'GET')
        return ok({
          items: [
            { id: '42', onSale: wrote42 },
            { id: '43', onSale: false },
          ],
        });
      if (String(options.body).includes('"id":42')) {
        wrote42 = true;
        return ok({});
      }
      return { ok: false, status: 400, data: null };
    });
    await scheduler.processDueRules();
    // The stored reservation and its outcome come back with sorted keys, unlike the in-memory rule.
    expect(Object.keys(storage['rule:list:42:cs.money'] as object)).toEqual(Object.keys(storage['rule:list:42:cs.money'] as object).sort());
    expect(storage['rule:list:42:cs.money']).toMatchObject({ active: false, retiredReason: 'listed' });
    const rejected = storage['rule:list:43:cs.money'] as ScheduledRule;
    expect(rejected).toMatchObject({ active: true, consecutiveFailures: 1, lastStatus: 400, lastTerminalStatus: 400 });
    expect(rejected.pausedReason).toBeUndefined();
    const reads = () => proxy.mock.calls.filter(([, options]) => options.method === 'GET').length;
    const readsBefore = reads();
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? ok({ items: [{ id: '43', onSale: false }] }) : ok({})));
    vi.spyOn(Date, 'now').mockReturnValue(rejected.nextAttemptAt!);
    await scheduler.processDueRules();
    expect(reads()).toBe(readsBefore + 1);
    expect(writes()).toHaveLength(3);
    expect(storage['rule:list:43:cs.money']).toMatchObject({ active: false, retiredReason: 'listed' });
  });
  it('unknown checks never write and pause at the failure limit', async () => {
    seed(listing());
    proxy.mockResolvedValue(ok({ items: [{ id: '42', onSale: 'new-state' }] }));
    for (let i = 0; i < MAX_REPRICE_FAILURES; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW + i * REPRICE_FAILURE_RETRY_MS);
      await scheduler.processDueRules();
    }
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'consecutive_failures', consecutiveFailures: MAX_REPRICE_FAILURES });
  });
  it('a terminal 422 write is one strike with a checked retry; the same 422 again pauses', async () => {
    seed(listing());
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? ok({ items: [{ id: '42', onSale: false }] }) : { ok: false, status: 422, data: null }));
    await scheduler.processDueRules();
    expect(await stored()).toMatchObject({ active: true, consecutiveFailures: 1, lastTerminalStatus: 422 });
    expect(writes()).toHaveLength(1);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + REPRICE_FAILURE_RETRY_MS);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(2);
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'permanent_http_error' });
  });
  it('item rejection in a 2xx is counted, not retired as listed', async () => {
    seed(listing());
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? ok({ items: [{ id: '42', onSale: false }] }) : ok({ errors: [{ id: '42', message: 'private body' }] })));
    await scheduler.processDueRules();
    expect(await stored()).toMatchObject({ active: true, consecutiveFailures: 1, lastMessage: 'step_item_rejected' });
  });
  it('a one-shot more than a day overdue pauses without any request, and an earlier one still runs', async () => {
    seed(listing('cs.money', '42', NOW - LISTING_OVERDUE_MS - 1), listing('cs.money', '43', NOW - LISTING_OVERDUE_MS + 60_000));
    proxy.mockImplementation(async (_url, options) =>
      options.method === 'GET'
        ? ok({
            items: [
              { id: '42', onSale: false },
              { id: '43', onSale: false },
            ],
          })
        : ok({})
    );
    await scheduler.processDueRules();
    expect(proxy.mock.calls.filter(([, options]) => options.method !== 'GET').map(([, options]) => options.body)).toEqual([
      buildListingTemplate('cs.money', '43', 2.34, FIXTURE_STEAM_ID)!.bodyTemplate,
    ]);
    const [overdue, onTime] = await scheduler.getRules();
    expect(overdue).toMatchObject({ active: false, pausedReason: 'listing_overdue', pausedAt: NOW });
    expect(onTime).toMatchObject({ retiredReason: 'listed' });
  });
  it('a one-shot waiting on retries pauses as overdue instead of listing at its old price', async () => {
    seed({ ...listing(), nextAttemptAt: NOW + LISTING_OVERDUE_MS + 1 });
    present();
    // Never planned either, whatever pauses it.
    expect(computeScheduledStep(listing(), NOW + LISTING_OVERDUE_MS + 1)).toBeNull();
    expect(computeScheduledStep(listing(), NOW + LISTING_OVERDUE_MS)).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(NOW + LISTING_OVERDUE_MS + 1);
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'listing_overdue' });
  });
  it('not-yet-due rules do nothing and get a time-specific alarm', async () => {
    seed(listing('cs.money', '42', NOW + 300_000));
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
    expect(browser.alarms.create).toHaveBeenCalledWith(REPRICE_CONTINUE_ALARM, { when: NOW + 300_000 });
  });
  it('new registration is dormant to old-style reprice passes and ends the pair ramp in the same step', async () => {
    const list = listing('cs.money', '42', NOW + 300_000);
    const ramp = { ...list, kind: 'reprice' as const, ruleId: '42:cs.money', days: 5 };
    const otherRamp = { ...ramp, ruleId: '43:cs.money', itemId: '43' };
    seed(ramp, otherRamp);
    await scheduler.registerRule({ ...list, active: false, listingActivationRequested: true, pausedReason: 'scheduled_listing_update_required' });
    const rules = await scheduler.getRules();
    // The ramp would overwrite the fixed price at its next step once the one-shot has listed the item.
    expect(rules.map((rule) => rule.ruleId)).toEqual(['43:cs.money', 'list:42:cs.money']);
    // Gone from storage too: a key left behind would be re-indexed by ensureIndex at the next worker start.
    expect(storage).not.toHaveProperty(['rule:42:cs.money']);
    await scheduler.ensureIndex();
    expect((await scheduler.getRules()).map((rule) => rule.ruleId)).toEqual(['43:cs.money', 'list:42:cs.money']);
    const storedList = rules.find((rule) => rule.kind === 'list')!;
    expect(storedList.active).toBe(true);
    expect(computeRepriceStep(storedList, NOW + 10 * 86_400_000)).toBeNull();
  });
  it('a refused registration leaves the pair ramp alone', async () => {
    const ramp = { ...listing(), kind: 'reprice' as const, ruleId: '42:cs.money', days: 5 };
    seed(ramp, { ...listing(), active: false, retiredReason: 'listed' });
    await scheduler.registerRule({ ...listing('cs.money', '42', NOW + 300_000), createdAt: NOW, active: false, listingActivationRequested: true });
    expect((await scheduler.getRules()).map((rule) => rule.ruleId)).toEqual(['42:cs.money', 'list:42:cs.money']);
  });
  it('cancelling a pair reprice rule (any web version: "Add for sale" or a delist) also cancels its one-shot', async () => {
    seed(listing('cs.money', '42'), listing('cs.money', '43'));
    await scheduler.cancelRule('42:cs.money');
    expect((await scheduler.getRules()).map((rule) => rule.ruleId)).toEqual(['list:43:cs.money']);
    await scheduler.cancelRule('list:43:cs.money');
    expect(await scheduler.getRules()).toEqual([]);
  });
  it('duplicate registration never revives a successful one-shot', async () => {
    const request = { ...listing('cs.money', '42', NOW + 300_000), active: false, listingActivationRequested: true };
    await scheduler.registerRule(request);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 300_000);
    present();
    await scheduler.processDueRules();
    await scheduler.registerRule(request);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
    expect((await stored()).retiredReason).toBe('listed');
  });
  it.each([
    ['may have been sent', { active: false, pausedReason: 'listing_outcome_unknown' as const }],
    ['was listed', { active: false, retiredReason: 'listed' as const }],
  ])('a newer registration cannot replace a one-shot that %s without the user acknowledgement', async (_case, state) => {
    seed({ ...listing(), ...state });
    const newer = { ...listing('cs.money', '42', NOW + 300_000), createdAt: NOW, active: false, listingActivationRequested: true };
    await scheduler.registerRule(newer);
    expect(await stored()).toMatchObject({ ...state, createdAt: NOW - 1000 });
    await scheduler.registerRule({ ...newer, replaceAcknowledged: true });
    const replaced = await stored();
    expect(replaced).toMatchObject({ active: true, createdAt: NOW, listAt: NOW + 300_000 });
    expect(replaced).not.toHaveProperty('replaceAcknowledged');
    expect(replaced.pausedReason ?? replaced.retiredReason).toBeUndefined();
  });
  it('a paused one-shot that never wrote is replaced by a newer registration without an acknowledgement', async () => {
    seed({ ...listing(), active: false, pausedReason: 'consecutive_failures' });
    await scheduler.registerRule({ ...listing('cs.money', '42', NOW + 300_000), createdAt: NOW, active: false, listingActivationRequested: true });
    expect(await stored()).toMatchObject({ active: true, createdAt: NOW });
  });
  it('permission denial makes no requests and uses shared platform backoff', async () => {
    seed(listing());
    vi.mocked(hasPermission).mockResolvedValue(false);
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ lastMessage: 'permission_unavailable', consecutiveFailures: 0 });
    expect(storage['reprice_backoff']).toHaveProperty('cs.money');
  });
  it('cancellation during a check prevents the write and cannot revive the rule', async () => {
    seed(listing());
    proxy.mockImplementation(async () => {
      await scheduler.cancelRule(listing().ruleId);
      return ok({ items: [{ id: '42', onSale: false }] });
    });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await scheduler.getRules()).toEqual([]);
  });
  it('stores an ambiguous-write pause before POST; transport loss and restart cannot replay it', async () => {
    seed(listing());
    proxy.mockImplementation(async (_url, options) => {
      if (options.method === 'GET') return ok({ items: [{ id: '42', onSale: false }] });
      expect(await stored()).toMatchObject({ active: false, pausedReason: 'listing_outcome_unknown' });
      throw new Error('lost response');
    });
    await scheduler.processDueRules();
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'listing_outcome_unknown' });
    vi.resetModules();
    scheduler = await import('../scheduler');
    await scheduler.ensureIndex();
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
  });
  it('CSFloat short stall pages follow total_count and catch an already listed item later', async () => {
    seed(listing('csfloat.com'));
    proxy.mockImplementation(async (url) => {
      if (!url.includes('/stall')) return ok([{ asset_id: '42', tradable: 1 }]);
      return new URL(url).searchParams.has('cursor')
        ? ok({ data: [{ id: 'target', item: { asset_id: '42' } }], total_count: 2 })
        : ok({ data: [{ id: 'other', item: { asset_id: '99' } }], total_count: 2, cursor: 'next' });
    });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect((await stored()).retiredReason).toBe('already_listed');
  });
  it.each(['missing-cursor', 'repeated-row', 'inconsistent-total'])('CSFloat %s never authorizes a write', async (issue) => {
    seed(listing('csfloat.com'));
    proxy.mockImplementation(async (url) => {
      if (!url.includes('/stall')) return ok([{ asset_id: '42', tradable: 1 }]);
      const second = new URL(url).searchParams.has('cursor');
      return ok({ data: [{ id: 'other', item: { asset_id: '99' } }], total_count: issue === 'inconsistent-total' && second ? 1 : 2, ...(issue === 'missing-cursor' ? {} : { cursor: 'next' }) });
    });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect((await stored()).consecutiveFailures).toBe(1);
  });
  it('CSFloat: an inventory row reporting tradable 0 is still present; the stall decides it is already listed', async () => {
    seed(listing('csfloat.com'));
    proxy.mockImplementation(async (url) => (url.includes('/stall') ? ok({ data: [{ id: 'listing', item: { asset_id: '42' } }], total_count: 1 }) : ok([{ asset_id: '42', tradable: 0 }])));
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'already_listed' });
  });
  it('CSFloat presence is required even with an empty stall', async () => {
    seed(listing('csfloat.com'));
    proxy.mockResolvedValue(ok([{ asset_id: '99', tradable: 1 }]));
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect((await stored()).pendingNotListedAt).toBe(NOW);
  });
  it('cs.money scans inventory pages and requires a fresh unlisted row for each write', async () => {
    seed(listing('cs.money', '100'), listing('cs.money', '101'));
    let wrote = false;
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') {
        wrote = true;
        return ok({});
      }
      const offset = Number(new URL(url).searchParams.get('offset'));
      return ok({
        items:
          offset === 0
            ? Array.from({ length: 60 }, (_, i) => ({ id: String(i), onSale: false }))
            : [
                { id: '100', onSale: false },
                { id: '101', onSale: wrote },
              ],
      });
    });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
    expect((await scheduler.getRules()).map((rule) => rule.retiredReason)).toEqual(['listed', 'already_listed']);
  });
  it('uses the existing pass cap and exclusivity for a batch of listings', async () => {
    seed(...Array.from({ length: MAX_FIRES_PER_PASS + 1 }, (_, index) => listing('cs.money', String(100 + index))));
    proxy.mockImplementation(async (_url, options) =>
      options.method === 'GET' ? ok({ items: Array.from({ length: MAX_FIRES_PER_PASS + 1 }, (_, index) => ({ id: String(100 + index), onSale: false })) }) : ok({})
    );
    await Promise.all([scheduler.processDueRules(), scheduler.processDueRules()]);
    expect(writes()).toHaveLength(MAX_FIRES_PER_PASS);
    expect((await scheduler.getRules()).filter((rule) => rule.active)).toHaveLength(1);
  });

  it.each([
    ['cs.money', 'an HTML page', '<html>maintenance</html>'],
    ['cs.money', 'an empty body', null],
    ['csfloat.com', 'no created listing id', {}],
  ] as const)('%s: a 2xx create with %s may not have listed: paused as unknown, never retired as listed', async (platform, _case, body) => {
    seed(listing(platform));
    present();
    const read = proxy.getMockImplementation()!;
    proxy.mockImplementation(async (url, options) => (options.method === 'GET' ? read(url, options) : ok(body)));
    await scheduler.processDueRules();
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'listing_outcome_unknown', lastMessage: 'listing_unconfirmed', lastStatus: 200 });
    vi.spyOn(Date, 'now').mockReturnValue(NOW + REPRICE_FAILURE_RETRY_MS);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
  });
  it('CSFloat: a short stall page with a cursor and no total is not the last page', async () => {
    seed(listing('csfloat.com'));
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return ok({ id: 'created-listing' });
      if (!url.includes('/stall')) return ok([{ asset_id: '42' }]);
      // A server capping pages below the limit: one row and a cursor, no total_count.
      return new URL(url).searchParams.has('cursor') ? ok({ data: [{ id: 'target', item: { asset_id: '42' } }] }) : ok({ data: [{ id: 'other', item: { asset_id: '99' } }], cursor: 'next' });
    });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect((await stored()).retiredReason).toBe('already_listed');
  });
  it('CSFloat: without a total, the stall ends on an empty page after the cursor', async () => {
    seed(listing('csfloat.com'));
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return ok({ id: 'created-listing' });
      if (!url.includes('/stall')) return ok([{ asset_id: '42' }]);
      return new URL(url).searchParams.has('cursor') ? ok({ data: [], cursor: 'next' }) : ok({ data: [{ id: 'other', item: { asset_id: '99' } }], cursor: 'next' });
    });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
    expect((await stored()).retiredReason).toBe('listed');
  });
});

/** The create request immediate listing would send for this asset id. */
function createFor(platform: 'cs.money' | 'csfloat.com', id: string) {
  return buildListingTemplate(platform, id, 2.34, FIXTURE_STEAM_ID)!.bodyTemplate;
}

describe('one-shots of items that were trade-protected: found by name, float and pattern', () => {
  const COPY = { name: 'AK-47 | Redline (Field-Tested)', float: '0.251235', seed: 661 };
  function protectedListing(platform: 'cs.money' | 'csfloat.com'): ScheduledListingRule {
    return { ...listing(platform), template: buildListingTemplate(platform, '42', 2.34, FIXTURE_STEAM_ID, COPY)! };
  }
  /** An inventory row of the marketplace, in the shape its normalizer reads. */
  function row(platform: 'cs.money' | 'csfloat.com', id: string, overrides: { float?: number; seed?: number; name?: string; onSale?: boolean } = {}) {
    const { float = 0.2512345678, seed: paintSeed = 661, name = COPY.name, onSale = false } = overrides;
    return platform === 'cs.money' ? { id, fullName: name, float, pattern: paintSeed, onSale } : { asset_id: id, market_hash_name: name, float_value: float, paint_seed: paintSeed };
  }
  function inventory(platform: 'cs.money' | 'csfloat.com', rows: unknown[], stall: unknown[] = []) {
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return ok({ id: 'created-listing' });
      if (url.includes('/stall')) return ok({ data: stall, total_count: stall.length });
      return ok(platform === 'cs.money' ? { items: rows } : rows);
    });
  }

  it.each(['cs.money', 'csfloat.com'] as const)('%s: the asset id is unchanged, so the create names it', async (platform) => {
    seed(protectedListing(platform));
    inventory(platform, [row(platform, '7', { seed: 662 }), row(platform, '42')]);
    await scheduler.processDueRules();
    expect(writes().map(([, options]) => options.body)).toEqual([createFor(platform, '42')]);
    expect(await stored()).toMatchObject({ retiredReason: 'listed' });
  });
  it.each(['cs.money', 'csfloat.com'] as const)('%s: Steam re-issued the asset id, so the create names the current one', async (platform) => {
    seed(protectedListing(platform));
    inventory(platform, [row(platform, '7', { float: 0.9 }), row(platform, '9000000001')]);
    await scheduler.processDueRules();
    expect(writes().map(([, options]) => options.body)).toEqual([createFor(platform, '9000000001')]);
    expect(await stored()).toMatchObject({ retiredReason: 'listed' });
  });
  it('CSFloat: the stall is checked for the current asset id', async () => {
    seed(protectedListing('csfloat.com'));
    inventory('csfloat.com', [row('csfloat.com', '9000000001')], [{ id: 'listing', item: { asset_id: '9000000001' } }]);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ retiredReason: 'already_listed' });
  });
  it('cs.money: the current row already on sale retires the one-shot', async () => {
    seed(protectedListing('cs.money'));
    inventory('cs.money', [row('cs.money', '9000000001', { onSale: true })]);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ retiredReason: 'already_listed' });
  });
  it.each(['cs.money', 'csfloat.com'] as const)('%s: two copies match, so it pauses as ambiguous without a write', async (platform) => {
    seed(protectedListing(platform));
    inventory(platform, [row(platform, '42'), row(platform, '9000000001')]);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'identity_ambiguous' });
  });
  it('cs.money: a second copy on a later inventory page is found before any write', async () => {
    seed(protectedListing('cs.money'));
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return ok({ id: 'created-listing' });
      const offset = Number(new URL(url).searchParams.get('offset'));
      const others = Array.from({ length: 59 }, (_, i) => row('cs.money', String(100 + i), { float: 0.5 }));
      return ok({ items: offset === 0 ? [row('cs.money', '42'), ...others] : [row('cs.money', '9000000001')] });
    });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ pausedReason: 'identity_ambiguous' });
  });
  it.each(['cs.money', 'csfloat.com'] as const)('%s: no copy matches, so the two-read absence retires it without a write', async (platform) => {
    seed(protectedListing(platform));
    // Same name and pattern but another float, and the old asset id now naming another item.
    inventory(platform, [row(platform, '7', { float: 0.2512365 }), row(platform, '42', { name: 'AWP | Asiimov (Field-Tested)' })]);
    await scheduler.processDueRules();
    expect((await stored()).pendingNotListedAt).toBe(NOW);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + REPRICE_FAILURE_RETRY_MS);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'not_in_inventory' });
  });
  it('an empty or malformed inventory concludes nothing', async () => {
    seed(protectedListing('cs.money'));
    inventory('cs.money', []);
    await scheduler.processDueRules();
    proxy.mockResolvedValue(ok({ items: [{ fullName: COPY.name }] }));
    vi.spyOn(Date, 'now').mockReturnValue(NOW + REPRICE_FAILURE_RETRY_MS);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: true, consecutiveFailures: 2 });
    expect((await stored()).pendingNotListedAt).toBeUndefined();
  });
  it('registration refuses an identity rule without exactly one asset id token', async () => {
    const rule = protectedListing('cs.money');
    const request = { ...rule, listAt: NOW + 300_000, active: false, listingActivationRequested: true };
    await expect(scheduler.registerRule({ ...request, template: { ...rule.template, bodyTemplate: createFor('cs.money', '42') } })).rejects.toThrow('invalid_listing_rule');
    await expect(
      scheduler.registerRule({ ...request, template: { ...rule.template, identity: { ...COPY, float: '0.25', namePaths: [['fullName']], floatPaths: [['float']], seedPaths: [['pattern']] } } })
    ).rejects.toThrow('invalid_listing_rule');
    await scheduler.registerRule(request);
    expect(await stored()).toMatchObject({ active: true });
  });
});

const other = (platform: 'cs.money' | 'csfloat.com') =>
  platform === 'cs.money' ? { id: '7', fullName: 'Other', float: 0.5, pattern: 1, onSale: false } : { asset_id: '7', market_hash_name: 'Other', float_value: 0.5, paint_seed: 1 };

describe('arrival one-shots (waitForArrival): a trade-locked item is listed once it arrives', () => {
  const COPY = { name: 'AK-47 | Redline (Field-Tested)', float: '0.251235', seed: 661 };
  const DEADLINE = NOW + ARRIVAL_WAIT_MS;
  function arrival(platform: 'cs.money' | 'csfloat.com' = 'cs.money', listAt = NOW, arrivalDeadline = listAt + ARRIVAL_WAIT_MS): ScheduledListingRule {
    return { ...listing(platform, '42', listAt), template: buildListingTemplate(platform, '42', 2.34, FIXTURE_STEAM_ID, COPY)!, waitForArrival: true, arrivalDeadline };
  }
  function inventoryRows(platform: 'cs.money' | 'csfloat.com', rows: unknown[]) {
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return ok({ id: 'created-listing' });
      if (url.includes('/stall')) return ok({ data: [], total_count: 0 });
      return ok(platform === 'cs.money' ? { items: rows } : rows);
    });
  }
  const copyRow = (platform: 'cs.money' | 'csfloat.com', id: string) =>
    platform === 'cs.money'
      ? { id, fullName: COPY.name, float: 0.2512345678, pattern: COPY.seed, onSale: false }
      : { asset_id: id, market_hash_name: COPY.name, float_value: 0.2512345678, paint_seed: COPY.seed };

  it.each(['42', '9000000001'])('blocks an arrival by original or resolved asset %s until cleared', async (assetId) => {
    const { setListingBlocks } = await import('../listing-blocks');
    seed({ ...arrival(), owner: 'user_A' });
    inventoryRows('cs.money', [copyRow('cs.money', '9000000001')]);
    await setListingBlocks({ owner: 'user_A', at: NOW, assetIds: [assetId], expiresAt: { [assetId]: NOW + 604800000 } });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: true, lastMessage: 'sold_elsewhere' });
    await setListingBlocks({ owner: 'user_A', at: NOW + 1, assetIds: [], expiresAt: {} });
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 60_000);
    await scheduler.processDueRules();
    expect(writes().map(([, options]) => options.body)).toEqual([createFor('cs.money', '9000000001')]);
  });

  it.each(['cs.money', 'csfloat.com'] as const)('%s: waits through absent and empty reads, then lists the arrived item', async (platform) => {
    seed(arrival(platform));
    for (const [step, rows] of [
      [0, [other(platform)]],
      [1, []],
      [2, [other(platform)]],
      [3, []],
    ] as const) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW + step * ARRIVAL_RETRY_MS);
      inventoryRows(platform, [...rows]);
      await scheduler.processDueRules();
      const waiting = await stored();
      expect(waiting).toMatchObject({ active: true, nextAttemptAt: NOW + (step + 1) * ARRIVAL_RETRY_MS });
      expect(waiting.consecutiveFailures ?? 0).toBe(0);
      expect(waiting.pendingNotListedAt).toBeUndefined();
      expect(waiting.pausedReason).toBeUndefined();
      expect(waiting.retiredReason).toBeUndefined();
    }
    expect(writes()).toHaveLength(0);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 4 * ARRIVAL_RETRY_MS);
    inventoryRows(platform, [other(platform), copyRow(platform, '9000000001')]);
    await scheduler.processDueRules();
    expect(writes().map(([, options]) => options.body)).toEqual([createFor(platform, '9000000001')]);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'listed' });
  });
  it('a waiting rule wakes the continuation alarm at its short retry', async () => {
    seed(arrival());
    inventoryRows('cs.money', [other('cs.money')]);
    await scheduler.processDueRules();
    expect(browser.alarms.create).toHaveBeenLastCalledWith(REPRICE_CONTINUE_ALARM, { when: NOW + ARRIVAL_RETRY_MS });
  });
  it('is not retried before its short retry is due', async () => {
    seed(arrival());
    inventoryRows('cs.money', [other('cs.money')]);
    await scheduler.processDueRules();
    const reads = proxy.mock.calls.length;
    vi.spyOn(Date, 'now').mockReturnValue(NOW + ARRIVAL_RETRY_MS - 1);
    await scheduler.processDueRules();
    expect(proxy.mock.calls).toHaveLength(reads);
  });
  it('past its deadline it retires as never_appeared without any request', async () => {
    seed(arrival());
    vi.spyOn(Date, 'now').mockReturnValue(DEADLINE + 1);
    inventoryRows('cs.money', [copyRow('cs.money', '42')]);
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'never_appeared' });
  });
  it('an absent read after the deadline (a long pass) retires instead of waiting again', () => {
    const rule = arrival();
    expect(recordListingAbsent(rule, { outcome: 'absent', reason: 'absent_from_complete_response' }, 200, DEADLINE + 1)).toMatchObject({
      active: false,
      retiredReason: 'never_appeared',
    });
  });
  it('is never paused as overdue: a run days after listAt still lists', async () => {
    const listAt = NOW - 3 * LISTING_OVERDUE_MS;
    seed(arrival('cs.money', listAt));
    inventoryRows('cs.money', [copyRow('cs.money', '42')]);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'listed' });
  });
  it('a regular one-shot still pauses as overdue and retires after two absences', async () => {
    seed({ ...listing('cs.money', '42', NOW - 2 * LISTING_OVERDUE_MS) });
    await scheduler.processDueRules();
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'listing_overdue' });
  });
  it('a rejected write keeps the existing policy: one strike, a checked retry, the same status pauses', async () => {
    seed(arrival());
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return { ok: false, status: 422, data: null };
      return ok({ items: [copyRow('cs.money', '42')] });
    });
    await scheduler.processDueRules();
    const struck = await stored();
    expect(struck).toMatchObject({ active: true, consecutiveFailures: 1, lastTerminalStatus: 422 });
    vi.spyOn(Date, 'now').mockReturnValue(struck.nextAttemptAt!);
    await scheduler.processDueRules();
    expect(await stored()).toMatchObject({ active: false, pausedReason: 'permanent_http_error' });
    expect(writes()).toHaveLength(2);
  });
  it.each([
    ['without a deadline', { waitForArrival: true as const, arrivalDeadline: undefined }],
    ['with a deadline but no flag', { waitForArrival: undefined, arrivalDeadline: NOW + 600_000 }],
    ['with a deadline before listAt', { waitForArrival: true as const, arrivalDeadline: NOW + 60_000 }],
    ['with a deadline beyond the wait window', { waitForArrival: true as const, arrivalDeadline: NOW + 300_000 + ARRIVAL_WAIT_MS + 1 }],
  ])('registration refuses an arrival rule %s', async (_case, fields) => {
    const rule = { ...arrival('cs.money', NOW + 300_000), ...fields, active: false, listingActivationRequested: true };
    await expect(scheduler.registerRule(rule)).rejects.toThrow('invalid_listing_rule');
  });
  it('registration stores a valid arrival rule active with its fields', async () => {
    await scheduler.registerRule({ ...arrival('cs.money', NOW + 300_000), active: false, listingActivationRequested: true });
    expect(await stored()).toMatchObject({ active: true, waitForArrival: true, arrivalDeadline: NOW + 300_000 + ARRIVAL_WAIT_MS });
  });
});

describe('a cs.money one-shot held behind its CSFloat lot (precondition)', () => {
  function held(listAt = NOW): ScheduledListingRule {
    const rule = listing('cs.money', '42', listAt);
    return { ...rule, template: { ...rule.template, precondition: csfloatLiveLotPrecondition('42', FIXTURE_STEAM_ID)! } };
  }
  /** cs.money still has the item unlisted; the CSFloat stall answers `stall` (or that status). */
  function markets(stall: unknown, status = 200) {
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return ok({});
      if (url.includes('/stall')) return status === 200 ? ok(stall) : { ok: false, status, data: null };
      return ok({ items: [{ id: '42', onSale: false }] });
    });
  }
  const stallReads = () => proxy.mock.calls.filter(([url]) => url.includes('/stall'));

  it('lists on cs.money while the CSFloat lot stands, reading the stall as CSFloat right before the write', async () => {
    seed(held());
    markets({ data: [{ id: 'lot', item: { asset_id: '42' } }], total_count: 1 });
    await scheduler.processDueRules();
    expect(stallReads()).toHaveLength(1);
    expect(stallReads()[0]?.[1]).toMatchObject({ platform: 'csfloat.com', purpose: 'schedule-check' });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.[1]).toMatchObject({ platform: 'cs.money', purpose: 'schedule-write' });
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'listed' });
  });
  it('a complete stall without the lot (sold or delisted) retires it as required_lot_gone without a write', async () => {
    seed(held());
    markets({ data: [{ id: 'other', item: { asset_id: '7' } }], total_count: 1 });
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'required_lot_gone', lastMessage: 'required_lot_gone' });
  });
  it('an unreadable stall writes nothing, retries the rule later and never backs cs.money off', async () => {
    seed(held());
    markets(null, 429);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(0);
    const failed = await stored();
    expect(failed).toMatchObject({ active: true, lastStatus: 429, lastMessage: 'precondition_check_http_error' });
    expect(failed.retiredReason).toBeUndefined();
    expect(failed.nextAttemptAt).toBeGreaterThan(NOW);
    expect((storage['reprice_backoff'] as Record<string, number> | undefined)?.['cs.money']).toBeUndefined();
    markets({ data: [{ id: 'lot', item: { asset_id: '42' } }], total_count: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(failed.nextAttemptAt!);
    await scheduler.processDueRules();
    expect(writes()).toHaveLength(1);
  });
  it('the stall is not read while cs.money already lists the item', async () => {
    seed(held());
    proxy.mockImplementation(async (url) => (url.includes('/stall') ? ok({ data: [], total_count: 0 }) : ok({ items: [{ id: '42', onSale: true }] })));
    await scheduler.processDueRules();
    expect(stallReads()).toHaveLength(0);
    expect(await stored()).toMatchObject({ active: false, retiredReason: 'already_listed' });
  });
  it('registration keeps the precondition and refuses one that reads the rule’s own platform', async () => {
    await scheduler.registerRule({ ...held(NOW + 600_000), createdAt: NOW, active: false, listingActivationRequested: true });
    expect(await stored()).toMatchObject({ active: true, template: { precondition: { reason: 'cross_list_hold', platform: 'csfloat.com' } } });
    const own = held(NOW + 600_000);
    const precondition = { ...own.template.precondition!, platform: 'cs.money' };
    const rule = { ...own, ruleId: 'list:43:cs.money', itemId: '43', template: { ...own.template, precondition } };
    await expect(scheduler.registerRule({ ...rule, createdAt: NOW, active: false, listingActivationRequested: true })).rejects.toThrow();
  });
});

describe('one-shot listings in the support journal (QUICK-214)', () => {
  const journal = () => ((storage['qts:diagnostics:journal'] ?? []) as Array<{ owner: string; event: Record<string, unknown> }>).map((entry) => entry.event);

  it('a listed one-shot is ok with its reason; a write whose outcome is unknown reads as paused, not a retry', async () => {
    seed({ ...listing('csfloat.com'), owner: 'user_alice' });
    present();
    await scheduler.processDueRules();
    await vi.waitFor(() => expect(journal()).toEqual([{ kind: 'scheduler', platform: 'csfloat.com', stage: 'write', outcome: 'ok', retired: 'listed' }]));

    storage = {};
    seed({ ...listing('csfloat.com', '43'), owner: 'user_alice' });
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return { ok: false, status: 503, data: null };
      if (url.includes('/stall')) return ok({ data: [], total_count: 0 });
      return ok([{ asset_id: '43', tradable: 1 }]);
    });
    await scheduler.processDueRules();
    await vi.waitFor(() => expect(journal()).toEqual([{ kind: 'scheduler', platform: 'csfloat.com', stage: 'write', outcome: 'paused', paused: 'listing_outcome_unknown', status: 503 }]));
  });
});

it('publishes after the stored notice expires without a page push or tab API', async () => {
  const { setListingBlocks } = await import('../listing-blocks');
  seed({ ...listing(), owner: 'user_A' });
  present();
  await setListingBlocks({ owner: 'user_A', at: NOW, assetIds: ['42'], expiresAt: { '42': NOW + 60_000 } });
  await scheduler.processDueRules();
  expect(writes()).toHaveLength(0);
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 60_000);
  await scheduler.processDueRules();
  expect(writes()).toHaveLength(1);
  expect(await stored()).toMatchObject({ retiredReason: 'listed' });
});
