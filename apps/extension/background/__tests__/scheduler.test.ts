import type { RepriceCheckTemplate, ScheduledRule } from '@qts/contracts';
import {
  isLegacyRepriceExtension,
  REPRICE_BLOCKED_PAUSE_MS,
  REPRICE_FAILURE_RETRY_MS,
  REPRICE_PAUSED_TTL_MS,
  REPRICE_RETIRED_TTL_MS,
  REPRICE_TRANSIENT_PAUSE_MS,
  REPRICE_TRANSIENT_RETRY_MS,
  SAFE_REPRICE_EXTENSION_VERSION,
} from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wait } from '@/shared/utils';

import extensionPackage from '../../package.json';
import { hasPermission } from '../permissions';
import { proxyRequest } from '../proxy';
import type * as Scheduler from '../scheduler';
import { chromeStored } from './chrome-storage';

vi.mock('../permissions', () => ({ hasPermission: vi.fn() }));
vi.mock('../proxy', () => ({ proxyRequest: vi.fn() }));
// These rules target a fixture marketplace; the operation allowlist is covered by operation-allowlist.test.ts
// and, with real templates, by reprice-e2e / scheduled-listing tests.
vi.mock('../operation-policy', () => ({ scheduledRequestRefusal: vi.fn(async () => null), scheduledRuleRefusal: vi.fn(async () => null) }));
vi.mock('@/shared/utils', () => ({ wait: vi.fn(async () => undefined) }));

const DAY = 86_400_000;
const NOW = 30 * DAY;
const RETRY = REPRICE_FAILURE_RETRY_MS;
const BLOCKED_MS = 30 * 60_000;
const check: RepriceCheckTemplate = {
  request: { url: 'https://market.example/inventory', method: 'GET' },
  goneStatuses: [],
  matcher: { collectionPaths: [['items']], idPaths: [['id']], id: '1', state: { paths: [['listed']], listedValues: [true], notListedValues: [false] }, pageSize: 2 },
};
function rule(overrides: Partial<ScheduledRule> = {}): ScheduledRule {
  return {
    ruleId: '1:market',
    platform: 'market',
    itemId: '1',
    marketHashName: 'fixture',
    firstPrice: 30,
    secondPrice: 0,
    startAt: NOW - DAY,
    days: 30,
    lastAppliedDay: 0,
    template: { url: 'https://market.example/listing', method: 'PATCH', bodyTemplate: '{"price":__PRICE__}', priceInCents: false, checkTemplate: check },
    active: true,
    createdAt: NOW - DAY,
    ...overrides,
  };
}
const listed = { ok: true, status: 200, data: { items: [{ id: '1', listed: true }] } };
const success = { ok: true, status: 200, data: {} };
let storage: Record<string, unknown>;
let onGet: ((keys: string | string[] | null) => void) | undefined;
let scheduler: typeof Scheduler;
const proxy = vi.mocked(proxyRequest);
const alarm = vi.fn();
function seed(...rules: ScheduledRule[]) {
  storage['rule_index'] = rules.map((r) => r.ruleId);
  for (const r of rules) storage[`rule:${r.ruleId}`] = chromeStored(r);
}
async function current() {
  return (await scheduler.getRules())[0];
}
function at(now: number) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
}
/** A fresh service worker: module state (counters, caches) is gone, only storage survives. */
async function restartWorker() {
  vi.resetModules();
  scheduler = await import('../scheduler');
}
/** The continuation alarm the last pass set, as a delay from `now`. */
function lastContinuationDelay(now: number): number | undefined {
  const call = alarm.mock.calls.at(-1) as [string, { when: number }] | undefined;
  return call ? call[1].when - now : undefined;
}
const otherRow = { items: [{ id: '2', listed: true }] };

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  storage = {};
  onGet = undefined;
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          onGet?.(keys);
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
    alarms: { create: alarm },
  });
  vi.mocked(hasPermission).mockResolvedValue(true);
  scheduler = await import('../scheduler');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the account’s working browser (QUICK-305)', () => {
  const lease = (holds: boolean, expiresAt: number | null) => ({ clerkId: 'user_A', token: null, holds, leaseId: holds ? 'lease-0001' : null, expiresAt, offsetMs: 0, answeredAt: NOW });

  /** What the market sync planned in some tab: every browser of the account may hold it. */
  const shared = () => rule({ origin: 'auto_sync', owner: 'user_A' });

  it('leaves an account-wide rule to the browser that works, and keeps it as it was', async () => {
    seed(shared());
    storage['qts:active_browser'] = lease(false, null);
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ active: true, lastAppliedDay: 0 });
    expect(alarm).not.toHaveBeenCalled();
  });

  it('still runs a rule this browser alone holds (a one-shot from the sale form) while another one works', async () => {
    seed(rule());
    storage['qts:active_browser'] = lease(false, null);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it('writes nothing once the lease ran out during the pass, and records no failure', async () => {
    seed(shared());
    storage['qts:active_browser'] = lease(true, NOW + 1_000);
    proxy.mockImplementationOnce(async () => {
      at(NOW + 2_000);
      return listed;
    });
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledOnce();
    expect(proxy.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(await current()).toMatchObject({ active: true, lastAppliedDay: 0 });
    expect((await current())?.consecutiveFailures ?? 0).toBe(0);
  });

  it('runs as usual while it holds the lease', async () => {
    seed(shared());
    storage['qts:active_browser'] = lease(true, NOW + 60_000);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(await current()).toMatchObject({ lastAppliedDay: 1 });
  });
});

describe('reprice scheduler safety', () => {
  it('checks listed status before exactly one price request', async () => {
    seed(rule());
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(proxy.mock.calls[1]).toEqual([
      'https://market.example/listing',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"price":29}', platform: 'market', purpose: 'schedule-write' },
    ]);
    expect(await current()).toMatchObject({ active: true, lastAppliedDay: 1, consecutiveFailures: 0 });
  });
  it.each([otherRow, { items: [{ id: '1', listed: false }] }])('retires a missing/inactive listing only on the second consecutive check (%j)', async ({ items }) => {
    seed(rule());
    proxy.mockResolvedValue({ ...success, data: { items } });
    await scheduler.processDueRules();
    // The first proof of absence only marks the rule; it stays active and writes nothing.
    expect(await current()).toMatchObject({ active: true, pendingNotListedAt: NOW, nextAttemptAt: NOW + RETRY, lastStatus: 200 });
    expect((await current())?.retiredReason).toBeUndefined();
    at(NOW + 60_000);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(1);
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: false, retiredReason: 'not_listed', retiredAt: NOW + RETRY, lastStatus: 200 });
    if (items[0]?.id === '1') expect((await current())?.lastCheckStatus).toBe(false);
    at(NOW + 2 * RETRY);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
  });
  it('clears the pending absence when the next check finds the listing and applies the step', async () => {
    seed(rule());
    proxy.mockResolvedValueOnce({ ...success, data: otherRow });
    await scheduler.processDueRules();
    at(NOW + RETRY);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, lastAppliedDay: 1 });
    expect((await current())?.pendingNotListedAt).toBeUndefined();
    expect((await current())?.nextAttemptAt).toBeUndefined();
  });
  it('an uncertain check between two absences restarts the absence evidence', async () => {
    seed(rule());
    proxy.mockResolvedValueOnce({ ...success, data: otherRow });
    await scheduler.processDueRules();
    at(NOW + RETRY);
    proxy.mockResolvedValueOnce({ ok: false, status: 503, data: null });
    await scheduler.processDueRules();
    expect((await current())?.pendingNotListedAt).toBeUndefined();
    at(NOW + 2 * RETRY);
    proxy.mockResolvedValueOnce({ ...success, data: otherRow });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, pendingNotListedAt: NOW + 2 * RETRY });
    expect((await current())?.retiredReason).toBeUndefined();
  });
  const singleCheck: RepriceCheckTemplate = {
    request: { url: 'https://market.example/listings/1', method: 'GET' },
    goneStatuses: [404, 410],
    matcher: {
      collectionPaths: [[]],
      single: true,
      idPaths: [['id']],
      id: '1',
      requiredMatches: [{ paths: [['item', 'asset_id']], value: 'asset-1' }],
      state: { paths: [['state']], listedValues: ['listed'], notListedValues: ['sold', 'delisted', 'refunded'] },
      pageSize: 1,
    },
  };
  const listingRow = { id: '1', item: { asset_id: 'asset-1' }, state: 'listed' };
  function seedSingle() {
    seed(rule({ template: { ...rule().template, checkTemplate: singleCheck } }));
  }
  it('reconciles an item-specific root object before repricing', async () => {
    seedSingle();
    proxy.mockResolvedValueOnce({ ...success, data: listingRow }).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      [singleCheck.request.url, 'GET'],
      ['https://market.example/listing', 'PATCH'],
    ]);
    expect(await current()).toMatchObject({ active: true, lastAppliedDay: 1, lastCheckStatus: 'listed' });
  });
  it.each(['sold', 'delisted', 'refunded'])('retires a root listing in state %s after two checks and persists the observed state', async (state) => {
    seedSingle();
    proxy.mockResolvedValue({ ...success, data: { ...listingRow, state } });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, pendingNotListedAt: NOW, lastCheckStatus: state });
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: false, retiredReason: 'not_listed', retiredAt: NOW + RETRY, lastStatus: 200, lastCheckStatus: state });
    at(NOW + 2 * RETRY);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
  });
  it.each(['future-inactive-state', 'Listed', 'active', ''])('an undeclared listing state %j is uncertainty: a strike, never absence', async (state) => {
    seedSingle();
    proxy.mockResolvedValue({ ...success, data: { ...listingRow, state } });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 1, lastMessage: 'unknown_listing_state' });
    expect((await current())?.pendingNotListedAt).toBeUndefined();
    expect(proxy).toHaveBeenCalledTimes(1);
  });
  it.each([404, 410])('retires item-specific HTTP %i after two checks without a price request', async (status) => {
    seedSingle();
    proxy.mockResolvedValue({ ok: false, status, data: null });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, pendingNotListedAt: NOW, lastStatus: status });
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: false, retiredReason: 'not_listed', lastStatus: status });
    expect(proxy).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...listingRow, id: 'other-listing' },
    { ...listingRow, item: { asset_id: 'other-asset' } },
    { ...listingRow, state: undefined },
  ])('counts root identity/state uncertainty toward the pause limit (%j)', async (data) => {
    seedSingle();
    proxy.mockResolvedValue({ ...success, data });
    for (let i = 0; i < 3; i++) {
      at(NOW + i * RETRY);
      await scheduler.processDueRules();
    }
    expect(await current()).toMatchObject({ active: false, pausedReason: 'consecutive_failures', consecutiveFailures: 3, lastStatus: 200 });
    expect(proxy).toHaveBeenCalledTimes(3);
    expect(proxy.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
  });
  it.each([429, 500, 503, 408, 0])('backs off failed check HTTP %i without firing, with persistent failure data', async (status) => {
    seed(rule(), rule({ ruleId: '2:market', itemId: '2' }));
    proxy.mockResolvedValueOnce({ ok: false, status, data: null, headers: { 'retry-after': '120' } });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 0, lastAppliedDay: 0, lastStatus: status, lastFailureAt: NOW });
    expect(storage['reprice_backoff']).toEqual({ market: NOW + 120_000 });
    expect(alarm).toHaveBeenCalled();
    // Persisted backoff must work after worker restart, too.
    vi.resetModules();
    scheduler = await import('../scheduler');
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(1);
  });
  it.each(['check', 'step'] as const)('transient %s failures retry the rule later and later across worker restarts, never counted', async (stage) => {
    for (const failure of [429, 500, 503, 408, 0, 'throw'] as const) {
      // Start each scenario from a fresh worker and storage; no real requests.
      storage = {};
      proxy.mockReset();
      alarm.mockReset();
      seed(rule());
      let now = NOW;
      for (let pass = 1; pass <= 4; pass++) {
        await restartWorker();
        at(now);
        if (stage === 'step') proxy.mockResolvedValueOnce(listed);
        if (failure === 'throw') proxy.mockRejectedValueOnce(new Error('fixture'));
        else proxy.mockResolvedValueOnce({ ok: false, status: failure, data: null });
        await scheduler.processDueRules();
        const retry = REPRICE_TRANSIENT_RETRY_MS * 2 ** (pass - 1);
        expect(await current()).toMatchObject({
          active: true,
          consecutiveFailures: 0,
          transientFailures: pass,
          nextAttemptAt: now + retry,
          lastAppliedDay: 0,
          lastStatus: failure === 'throw' ? 0 : failure,
          lastFailureAt: now,
        });
        expect((await current())?.pausedReason).toBeUndefined();
        // The platform counter survives the restart, so the platform backoff grows too.
        expect(storage['reprice_backoff']).toEqual({ market: now + 2 ** pass * 1000 });
        expect(storage['reprice_backoff_attempts']).toEqual({ market: pass });
        // The worker wakes when the rule may run again: 5, 10, 20, 40 min, not every minute.
        expect(lastContinuationDelay(now)).toBe(retry);
        expect(proxy).toHaveBeenCalledTimes(pass * (stage === 'step' ? 2 : 1));
        // A restart inside the window sends nothing.
        await restartWorker();
        at(now + retry - 1);
        await scheduler.processDueRules();
        expect(proxy).toHaveBeenCalledTimes(pass * (stage === 'step' ? 2 : 1));
        now += retry;
      }
    }
  });
  it('a persistent transient condition caps its retry at the retry window and succeeds afterwards', async () => {
    seed(rule({ transientFailures: 12 }));
    proxy.mockResolvedValueOnce({ ok: false, status: 503, data: null });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ transientFailures: 13, nextAttemptAt: NOW + RETRY });
    await restartWorker();
    at(NOW + RETRY);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ lastAppliedDay: 1, consecutiveFailures: 0 });
    expect((await current())?.transientFailures).toBeUndefined();
    expect(storage['reprice_backoff_attempts']).toEqual({ market: 0 });
  });
  it('an item-specific persistent 5xx does not starve the platform and never loops every minute', async () => {
    const second = rule({ ruleId: '2:market', itemId: '2' });
    second.template = { ...second.template, url: 'https://market.example/listing/2', checkTemplate: { ...check, matcher: { ...check.matcher, id: '2' } } };
    seed(rule(), second);
    proxy.mockImplementation(async (url, options) => {
      if (options.method === 'GET')
        return {
          ...success,
          data: {
            items: [
              { id: '1', listed: true },
              { id: '2', listed: true },
            ],
          },
        };
      return url.endsWith('/2') ? success : { ok: false, status: 500, data: null };
    });
    const passes: number[] = [];
    let now = NOW;
    for (let pass = 0; pass < 6; pass++) {
      await restartWorker();
      alarm.mockReset();
      at(now);
      passes.push((now - NOW) / 60_000);
      await scheduler.processDueRules();
      const delay = lastContinuationDelay(now);
      if (delay === undefined) break;
      now += delay;
    }
    const rules = await scheduler.getRules();
    expect(rules[1]).toMatchObject({ lastAppliedDay: 1 });
    expect(rules[0]).toMatchObject({ active: true, lastAppliedDay: 0, consecutiveFailures: 0, transientFailures: 5 });
    // A minute to let the second rule through, then only the failing rule's own growing retry (minutes).
    expect(passes).toEqual([0, 1, 5, 15, 35, 75]);
  });
  it('counts only non-transient failures across mixed check and price failures', async () => {
    seed(rule());
    const sequence = [
      { stage: 'step', status: 409, count: 1 },
      { stage: 'check', status: 503, count: 1 },
      { stage: 'check', status: 200, count: 2 },
      { stage: 'step', status: 429, count: 2 },
      { stage: 'check', status: 0, count: 2 },
      { stage: 'step', status: 409, count: 3 },
    ];
    for (const [index, { stage, status, count }] of sequence.entries()) {
      at(NOW + index * RETRY);
      if (stage === 'step') proxy.mockResolvedValueOnce(listed);
      proxy.mockResolvedValueOnce({ ok: status === 200, status, data: {} });
      await scheduler.processDueRules();
      expect(await current()).toMatchObject({ active: count < 3, consecutiveFailures: count, lastStatus: status, lastAppliedDay: 0 });
    }
    expect((await current())?.pausedReason).toBe('consecutive_failures');
    at(NOW + sequence.length * RETRY);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(9);
  });
  it.each([400, 404, 405, 410, 422])('a terminal write HTTP %i is one strike; the same status on the next write pauses the rule', async (status) => {
    seed(rule());
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ok: false, status, data: null });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, lastStatus: status, consecutiveFailures: 1, lastTerminalStatus: status, nextAttemptAt: NOW + RETRY });
    await restartWorker();
    at(NOW + RETRY);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ok: false, status, data: null });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: false, pausedReason: 'permanent_http_error', pausedAt: NOW + RETRY, consecutiveFailures: 2 });
    await restartWorker();
    at(NOW + 2 * RETRY);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(4);
  });
  it('a terminal write glitch on every rule costs one strike and one write, and all recover', async () => {
    const ids = ['1', '2', '3', '4', '5'];
    seed(...ids.map((id) => rule({ ruleId: `${id}:market`, itemId: id, template: { ...rule().template, checkTemplate: { ...check, matcher: { ...check.matcher, id } } } })));
    const inventory = { items: ids.map((id) => ({ id, listed: true })) };
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? { ...success, data: inventory } : { ok: false, status: 400, data: null }));
    await scheduler.processDueRules();
    const rules = await scheduler.getRules();
    expect(proxy.mock.calls.filter((call) => call[1].method === 'PATCH')).toHaveLength(1);
    expect(rules.filter((r) => r.pausedReason)).toEqual([]);
    expect(rules.map((r) => r.consecutiveFailures ?? 0)).toEqual([1, 0, 0, 0, 0]);
    expect(storage['reprice_backoff']).toEqual({ market: NOW + 2000 });
    // Ten minutes later the write endpoint is healthy: the other rules go now, the struck one next window.
    await restartWorker();
    at(NOW + 10 * 60_000);
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? { ...success, data: inventory } : success));
    await scheduler.processDueRules();
    expect((await scheduler.getRules()).map((r) => r.lastAppliedDay)).toEqual([0, 1, 1, 1, 1]);
    await restartWorker();
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect((await scheduler.getRules()).every((r) => r.active && r.lastAppliedDay === 1)).toBe(true);
  });
  it('another rule succeeding in the same pass proves a terminal write status item-specific', async () => {
    const withId = (id: string) =>
      rule({ ruleId: `${id}:market`, itemId: id, template: { ...rule().template, url: `https://market.example/listing/${id}`, checkTemplate: { ...check, matcher: { ...check.matcher, id } } } });
    seed(withId('1'), withId('2'), withId('3'));
    const inventory = { items: ['1', '2', '3'].map((id) => ({ id, listed: true })) };
    proxy.mockImplementation(async (url, options) => {
      if (options.method === 'GET') return { ...success, data: inventory };
      return url.endsWith('/2') ? { ok: false, status: 404, data: null } : success;
    });
    await scheduler.processDueRules();
    const [first, second, third] = await scheduler.getRules();
    expect(first).toMatchObject({ lastAppliedDay: 1 });
    expect(second).toMatchObject({ active: false, pausedReason: 'permanent_http_error', lastStatus: 404 });
    // The platform still stops for the rest of the pass.
    expect(third).toMatchObject({ lastAppliedDay: 0 });
    expect(third?.lastFailureAt).toBeUndefined();
  });
  it('pauses after three other failures even across worker restarts', async () => {
    seed(rule());
    for (let i = 1; i <= 3; i++) {
      at(NOW + i * RETRY);
      proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ok: false, status: 409, data: null });
      await scheduler.processDueRules();
      expect(await current()).toMatchObject({ consecutiveFailures: i, active: i < 3, lastAppliedDay: 0 });
      vi.resetModules();
      scheduler = await import('../scheduler');
    }
    expect((await current())?.pausedReason).toBe('consecutive_failures');
    at(NOW + 4 * RETRY);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(6);
  });
  it('counts at most one failure per retry window, however often the worker restarts', async () => {
    seed(rule());
    proxy.mockResolvedValue({ ...success, data: '<html>login</html>' });
    for (let i = 0; i < 5; i++) {
      await restartWorker();
      at(NOW + i * 60_000);
      await scheduler.processDueRules();
    }
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 1, nextAttemptAt: NOW + RETRY });
    expect(proxy).toHaveBeenCalledTimes(1);
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 2 });
    expect(proxy).toHaveBeenCalledTimes(2);
  });
  it('unknown/malformed checks never fire and reach the failure limit', async () => {
    seed(rule());
    proxy.mockResolvedValue({ ...success, data: '<html>login</html>' });
    for (let i = 0; i < 3; i++) {
      at(NOW + i * RETRY);
      await scheduler.processDueRules();
    }
    expect(await current()).toMatchObject({ active: false, consecutiveFailures: 3, pausedReason: 'consecutive_failures', lastMessage: 'invalid_check_response' });
    expect(proxy.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
  });
  it('resets failures after a successful step, not after the successful check alone', async () => {
    seed(rule({ consecutiveFailures: 2, lastFailureAt: 1, lastStatus: 409 }));
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 0, lastAppliedDay: 1 });
    expect((await current())?.lastStatus).toBeUndefined();
  });
  it.each(['cs.money', 'csfloat.com'])('pauses stored legacy %s rules without any marketplace request', async (platform) => {
    const legacy = rule({ platform });
    delete legacy.template.checkTemplate;
    seed(legacy);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: false, pausedReason: 'missing_check', pausedAt: NOW });
    expect(proxy).not.toHaveBeenCalled();
  });
  it.each(['check', 'step'])('catches thrown %s requests and backs off without advancing', async (stage) => {
    seed(rule());
    if (stage === 'step') proxy.mockResolvedValueOnce(listed);
    proxy.mockRejectedValueOnce(new Error('fixture exception must not be stored'));
    await expect(scheduler.processDueRules()).resolves.toBeUndefined();
    expect(await current()).toMatchObject({ lastAppliedDay: 0, consecutiveFailures: 0, lastStatus: 0, lastFailureAt: NOW, lastMessage: `${stage}_http_error` });
    expect(storage['reprice_backoff']).toEqual({ market: NOW + 2000 });
  });
  it('a failed check on one platform does not prevent another platform from repricing', async () => {
    seed(rule(), rule({ ruleId: '1:other', platform: 'other', template: { ...rule().template, checkTemplate: { ...check, request: { url: 'https://other.example/inventory', method: 'GET' } } } }));
    proxy.mockImplementation(async (url) => {
      if (url === check.request.url) throw new Error('fixture');
      return url.endsWith('/inventory') ? listed : success;
    });
    await scheduler.processDueRules();
    const rules = await scheduler.getRules();
    expect(rules[0]).toMatchObject({ lastAppliedDay: 0, consecutiveFailures: 0 });
    expect(rules[1]).toMatchObject({ lastAppliedDay: 1, consecutiveFailures: 0 });
  });
  it('an expired session during reconciliation blocks the platform, then catches up after login', async () => {
    seed(rule({ startAt: NOW - 3 * DAY }));
    proxy.mockResolvedValueOnce({ ok: false, status: 401, data: null });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 0, lastStatus: 401, lastAppliedDay: 0, nextAttemptAt: NOW + RETRY });
    expect((await current())?.pausedReason).toBeUndefined();
    expect(storage['reprice_backoff']).toEqual({ market: NOW + BLOCKED_MS });
    expect(proxy).toHaveBeenCalledTimes(1);
    // Worker restarts inside the window send nothing, however many.
    for (const later of [60_000, BLOCKED_MS, RETRY - 1]) {
      await restartWorker();
      at(NOW + later);
      await scheduler.processDueRules();
    }
    expect(proxy).toHaveBeenCalledTimes(1);
    // The user logged in again: the next tick re-probes with the read-only check and catches up once.
    at(NOW + RETRY);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(3);
    expect(proxy.mock.calls[2]?.[1].body).toBe('{"price":27}');
    expect(await current()).toMatchObject({ active: true, lastAppliedDay: 3 });
    expect((await current())?.lastStatus).toBeUndefined();
  });
  it.each([401, 403])('a step HTTP %i blocks the platform without pausing the rule', async (status) => {
    seed(rule(), rule({ ruleId: '2:market', itemId: '2' }));
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ok: false, status, data: null });
    await scheduler.processDueRules();
    const rules = await scheduler.getRules();
    expect(rules[0]).toMatchObject({ active: true, consecutiveFailures: 0, lastStatus: status, lastMessage: 'step_http_error', nextAttemptAt: NOW + RETRY });
    expect(rules[0]?.pausedReason).toBeUndefined();
    // The block stops the platform: the second rule sends nothing this pass.
    expect(rules[1]?.lastFailureAt).toBeUndefined();
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(storage['reprice_backoff']).toEqual({ market: NOW + BLOCKED_MS });
    expect(alarm).toHaveBeenLastCalledWith('qts:reprice-continue', { when: NOW + BLOCKED_MS });
  });
  it("a rule whose write keeps being refused does not starve the platform's other rules", async () => {
    seed(rule(), rule({ ruleId: '2:market', itemId: '2' }));
    proxy.mockImplementation(async (url, options) => {
      if (options.method === 'GET') return listed;
      return proxy.mock.calls.filter((call) => call[1].method === 'PATCH').length === 1 ? { ok: false, status: 403, data: null } : success;
    });
    await scheduler.processDueRules();
    at(NOW + BLOCKED_MS);
    await scheduler.processDueRules();
    const rules = await scheduler.getRules();
    expect(rules[0]).toMatchObject({ active: true, lastAppliedDay: 0, lastStatus: 403 });
    expect(rules[1]).toMatchObject({ active: true, lastAppliedDay: 1 });
  });
  it('a cs.money captcha (403, errors[].code 4030) sends one request and keeps every rule active', async () => {
    seed(rule(), rule({ ruleId: '2:market', itemId: '2' }), rule({ ruleId: '3:market', itemId: '3' }));
    proxy.mockResolvedValue({ ok: false, status: 403, data: { errors: [{ code: 4030 }] } });
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(1);
    expect((await scheduler.getRules()).every((r) => r.active && !r.pausedReason && (r.consecutiveFailures ?? 0) === 0)).toBe(true);
    // The captcha was solved: after the block window the other rules are checked and repriced...
    proxy.mockReset();
    const inventory = {
      items: [
        { id: '1', listed: true },
        { id: '2', listed: true },
        { id: '3', listed: true },
      ],
    };
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? { ...success, data: inventory } : success));
    at(NOW + BLOCKED_MS);
    await scheduler.processDueRules();
    expect((await scheduler.getRules()).map((r) => r.lastAppliedDay)).toEqual([0, 1, 1]);
    // ...and the rule that hit the captcha follows at the next tick.
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect((await scheduler.getRules()).map((r) => r.lastAppliedDay)).toEqual([1, 1, 1]);
  });
  it('a declared 2xx platform error on the read is transient across worker restarts: growing retry, never counted', async () => {
    const withError = rule();
    withError.template.checkTemplate = { ...check, platformError: { paths: [['error']], ignoredValues: [2] } };
    seed(withError);
    let now = NOW;
    for (let pass = 1; pass <= 3; pass++) {
      await restartWorker();
      at(now);
      proxy.mockResolvedValueOnce({ ...success, data: { error: 5 } });
      await scheduler.processDueRules();
      expect(await current()).toMatchObject({ active: true, consecutiveFailures: 0, transientFailures: pass, lastMessage: 'check_platform_error', lastStatus: 200 });
      expect(storage['reprice_backoff']).toEqual({ market: now + 2 ** pass * 1000 });
      now = (await current())!.nextAttemptAt!;
    }
    expect(now).toBe(NOW + 35 * 60_000);
    expect(proxy).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])('a 2xx write carrying a declared platform error is transient, never success (final step: %s)', async (final) => {
    const withError = rule(final ? { startAt: NOW - 40 * DAY } : {});
    withError.template = { ...withError.template, platformError: { paths: [['error']], ignoredValues: [2] } };
    seed(withError);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ...success, data: { error: 5 } });
    await scheduler.processDueRules();
    // Not advanced and, on the final step, not deleted.
    expect(await current()).toMatchObject({ active: true, lastAppliedDay: 0, consecutiveFailures: 0, transientFailures: 1, lastMessage: 'step_platform_error' });
    expect(storage['rule_index']).toEqual(['1:market']);
    expect(storage['reprice_backoff']).toEqual({ market: NOW + 2000 });
    // The ignored code (cs.money "empty result") is not an error on a write either.
    await restartWorker();
    at(NOW + REPRICE_TRANSIENT_RETRY_MS);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ...success, data: { error: 2 } });
    await scheduler.processDueRules();
    if (final) expect(await scheduler.getRules()).toEqual([]);
    else expect(await current()).toMatchObject({ lastAppliedDay: 1 });
  });
  it('failed later pages never authorize a write or retire the rule', async () => {
    const paged = rule();
    paged.template.checkTemplate = { ...check, pagination: { offsetParam: 'offset', maxPages: 3 } };
    seed(paged);
    proxy.mockResolvedValueOnce({ ...success, data: { items: [{ id: '2' }, { id: '3' }] } }).mockResolvedValueOnce({ ok: false, status: 503, data: null });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 0, lastStatus: 503 });
    expect((await current())?.retiredReason).toBeUndefined();
    expect(proxy).toHaveBeenCalledTimes(2);
  });
  it('malformed check methods cannot be used to make a mutating reconciliation request', async () => {
    const malformed = { ...rule(), template: { ...rule().template, checkTemplate: { ...check, request: { ...check.request, method: 'POST' } } } };
    storage['rule_index'] = [malformed.ruleId];
    storage[`rule:${malformed.ruleId}`] = malformed;
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ lastAppliedDay: 0, consecutiveFailures: 1 });
  });
  it('bounds malformed check URLs instead of treating them as transient network failures', async () => {
    const malformed = rule();
    malformed.template.checkTemplate = { ...check, request: { url: 'invalid url', method: 'GET' } };
    seed(malformed);
    for (let i = 0; i < 3; i++) {
      at(NOW + i * RETRY);
      await scheduler.processDueRules();
    }
    expect(await current()).toMatchObject({ active: false, consecutiveFailures: 3, pausedReason: 'consecutive_failures', lastMessage: 'invalid_reprice_template' });
    expect((await current())?.lastStatus).toBeUndefined();
    expect(storage['reprice_backoff']).toEqual({});
    expect(proxy).not.toHaveBeenCalled();
  });
  it.each(['throws', 'denied'])('a permission lookup that %s blocks the platform and keeps the rules active', async (mode) => {
    seed(rule(), rule({ ruleId: '2:market', itemId: '2' }));
    if (mode === 'throws') vi.mocked(hasPermission).mockRejectedValueOnce(new Error('fixture'));
    else vi.mocked(hasPermission).mockResolvedValueOnce(false);
    await expect(scheduler.processDueRules()).resolves.toBeUndefined();
    for (const r of await scheduler.getRules()) {
      expect(r).toMatchObject({ active: true, consecutiveFailures: 0, lastMessage: 'permission_unavailable', lastFailureAt: NOW });
      expect(r.pausedReason).toBeUndefined();
    }
    expect(storage['reprice_backoff']).toEqual({ market: NOW + BLOCKED_MS });
    expect(proxy).not.toHaveBeenCalled();
    // Site access granted again: the next tick checks and reprices.
    at(NOW + RETRY);
    proxy.mockImplementation(async (_url, options) =>
      options.method === 'GET'
        ? {
            ...success,
            data: {
              items: [
                { id: '1', listed: true },
                { id: '2', listed: true },
              ],
            },
          }
        : success
    );
    await scheduler.processDueRules();
    expect((await scheduler.getRules()).map((r) => r.lastAppliedDay)).toEqual([1, 1]);
  });
  it('catches up an offline gap to exactly one step', async () => {
    seed(rule({ startAt: NOW - 7 * DAY }));
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy.mock.calls[1]?.[1].body).toBe('{"price":23}');
    expect((await current())?.lastAppliedDay).toBe(7);
  });
  it('applies only secondPrice after the entire term and removes the rule/index entry', async () => {
    seed(rule({ startAt: NOW - 8 * DAY, days: 3, secondPrice: 12 }));
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy.mock.calls[1]?.[1].body).toBe('{"price":12}');
    expect(await scheduler.getRules()).toEqual([]);
    expect(storage['rule_index']).toEqual([]);
  });
  it('follows declared offset pages before repricing a later match', async () => {
    const paged = rule();
    paged.template.checkTemplate = { ...check, pagination: { offsetParam: 'offset', maxPages: 3 } };
    seed(paged);
    proxy
      .mockResolvedValueOnce({ ...success, data: { items: [{ id: '2' }, { id: '3' }] } })
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy.mock.calls.map((call) => call[0])).toEqual(['https://market.example/inventory?offset=0', 'https://market.example/inventory?offset=2', 'https://market.example/listing']);
  });
  it('retains unknown status on an unpageable full page or page cap', async () => {
    seed(rule());
    proxy.mockResolvedValue({ ...success, data: { items: [{ id: '2' }, { id: '3' }] } });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 1, lastMessage: 'partial_check_response' });
    expect(proxy).toHaveBeenCalledTimes(1);
    const capped = rule();
    capped.template.checkTemplate = { ...check, pagination: { offsetParam: 'offset', maxPages: 2 } };
    seed(capped);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(3);
    expect((await current())?.retiredReason).toBeUndefined();
  });
  it('does not fire or revive a rule cancelled while checking', async () => {
    seed(rule());
    proxy.mockImplementationOnce(async () => {
      await scheduler.cancelRule('1:market');
      return listed;
    });
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(await scheduler.getRules()).toEqual([]);
  });
  it('does not overwrite a replacement registered while the old step is in flight', async () => {
    seed(rule());
    proxy.mockResolvedValueOnce(listed).mockImplementationOnce(async () => {
      await scheduler.registerRule(rule({ firstPrice: 50, createdAt: NOW }));
      return success;
    });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ firstPrice: 50, lastAppliedDay: 0, createdAt: NOW });
  });
  it('only explicit re-registration resumes a checked rule; legacy registration pauses', async () => {
    seed(rule({ active: false, pausedReason: 'consecutive_failures', consecutiveFailures: 3 }));
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
    await scheduler.registerRule(rule({ active: false, activationRequested: true, pausedReason: 'extension_update_required' }));
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 0 });
    expect((await current())?.pausedReason).toBeUndefined();
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
    const legacy = rule();
    delete legacy.template.checkTemplate;
    await scheduler.registerRule(legacy);
    expect(await current()).toMatchObject({ active: false, pausedReason: 'missing_check' });
  });
  it('does not start a concurrent pass while a check is in flight', async () => {
    seed(rule());
    proxy
      .mockImplementationOnce(async () => {
        await scheduler.processDueRules();
        return listed;
      })
      .mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
  });
  it('shares identical check pages within a pass and re-reads the target page right before each write', async () => {
    const pageSize = 60;
    // 1,000 items; every 20th is one of 50 due rules (the review's P4 layout).
    const inventory = Array.from({ length: 1000 }, (_, i) => ({ id: String(1000 + i), listed: i % 20 === 0 }));
    const pagedCheck: RepriceCheckTemplate = { ...check, matcher: { ...check.matcher, pageSize }, pagination: { offsetParam: 'offset', maxPages: 30 } };
    const ids = Array.from({ length: 50 }, (_, k) => String(1000 + k * 20));
    seed(...ids.map((id) => rule({ ruleId: `${id}:market`, itemId: id, template: { ...rule().template, checkTemplate: { ...pagedCheck, matcher: { ...pagedCheck.matcher, id } } } })));
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return success;
      const offset = Number(new URL(url).searchParams.get('offset'));
      return { ...success, data: { items: inventory.slice(offset, offset + pageSize) } };
    });
    await scheduler.processDueRules();
    const calls = proxy.mock.calls.map(([url, options]) => ({ url, method: options.method, body: options.body }));
    const writes = calls.filter((call) => call.method === 'PATCH');
    expect(writes).toHaveLength(50);
    // Without sharing every rule re-reads all pages up to its target (442 reads); now one read per rule.
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(50);
    calls.forEach((call, index) => {
      if (call.method !== 'PATCH') return;
      const id = Number(ids[writes.indexOf(call)]);
      const previous = calls[index - 1];
      expect(previous?.method).toBe('GET');
      expect(new URL(previous?.url ?? '').searchParams.get('offset')).toBe(String(Math.floor((id - 1000) / pageSize) * pageSize));
    });
    expect((await scheduler.getRules()).every((r) => r.lastAppliedDay === 1)).toBe(true);
  });
  it('a pre-write re-read that no longer finds the target writes nothing', async () => {
    const pagedCheck: RepriceCheckTemplate = { ...check, matcher: { ...check.matcher, pageSize: 3 }, pagination: { offsetParam: 'offset', maxPages: 5 } };
    const withId = (id: string) => rule({ ruleId: `${id}:market`, itemId: id, template: { ...rule().template, checkTemplate: { ...pagedCheck, matcher: { ...pagedCheck.matcher, id } } } });
    seed(withId('1'), withId('2'));
    let inventory = [
      { id: '1', listed: true },
      { id: '2', listed: true },
    ];
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') {
        inventory = [
          { id: '1', listed: true },
          { id: '2', listed: false },
        ]; // item 2 delisted meanwhile
        return success;
      }
      return { ...success, data: { items: inventory } };
    });
    await scheduler.processDueRules();
    expect(proxy.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'PATCH', 'GET']);
    expect((await scheduler.getRules())[1]).toMatchObject({ active: true, lastAppliedDay: 0, pendingNotListedAt: NOW, lastCheckStatus: false });
  });
  it('an item that shifts pages mid-scan is never retired on that single scan', async () => {
    const pagedCheck: RepriceCheckTemplate = { ...check, matcher: { ...check.matcher, id: '4', pageSize: 3 }, pagination: { offsetParam: 'offset', maxPages: 5 } };
    seed(rule({ ruleId: '4:market', itemId: '4', template: { ...rule().template, checkTemplate: pagedCheck } }));
    let inventory = ['1', '2', '3', '4', '5'].map((id) => ({ id, listed: true }));
    let reads = 0;
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return success;
      const offset = Number(new URL(url).searchParams.get('offset'));
      const page = { ...success, data: { items: inventory.slice(offset, offset + 3) } };
      if (++reads === 1) inventory = inventory.filter((item) => item.id !== '2'); // another item sells between page reads
      return page;
    });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, pendingNotListedAt: NOW, lastAppliedDay: 0 });
    expect(proxy.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, lastAppliedDay: 1 });
    expect((await current())?.retiredReason).toBeUndefined();
  });
  it('a rule replaced right before its check neither backs off the platform nor skips its other rules', async () => {
    seed(rule(), rule({ ruleId: '2:market', itemId: '2' }));
    let reads = 0;
    onGet = (keys) => {
      // 1st single-key read: the pre-check isCurrent; 2nd: the page-0 guard inside the check.
      if (keys === 'rule:1:market' && ++reads === 2) (storage['rule:1:market'] as ScheduledRule).firstPrice = 50;
    };
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? listed : success));
    await scheduler.processDueRules();
    expect(storage['reprice_backoff']).toEqual({});
    const rules = await scheduler.getRules();
    expect(rules[0]).toMatchObject({ firstPrice: 50, lastAppliedDay: 0 });
    expect(rules[0]?.lastFailureAt).toBeUndefined();
    expect(rules[1]).toMatchObject({ lastAppliedDay: 1 });
  });
  it('prunes retired rules a week after retirement and paused rules a month after the pause', async () => {
    seed(
      rule({ ruleId: 'old:market', active: false, retiredReason: 'not_listed', retiredAt: NOW - REPRICE_RETIRED_TTL_MS }),
      rule({ ruleId: 'recent:market', active: false, retiredReason: 'not_listed', retiredAt: NOW - DAY }),
      rule({ ruleId: 'stale:market', active: false, pausedReason: 'consecutive_failures', pausedAt: NOW - REPRICE_PAUSED_TTL_MS }),
      rule({ ruleId: 'paused:market', active: false, pausedReason: 'consecutive_failures', pausedAt: NOW - REPRICE_PAUSED_TTL_MS + 1 })
    );
    await scheduler.processDueRules();
    expect((await scheduler.getRules()).map((r) => r.ruleId)).toEqual(['recent:market', 'paused:market']);
    expect(storage['rule_index']).toEqual(['recent:market', 'paused:market']);
    expect(storage['rule:old:market']).toBeUndefined();
    expect(storage['rule:stale:market']).toBeUndefined();
    expect(proxy).not.toHaveBeenCalled();
  });
  it('activates checked rules stored by an older extension on worker start and catches up one step', async () => {
    // What an older registerRule stored verbatim for a safety-aware web registration.
    seed(rule({ startAt: NOW - 3 * DAY, lastAppliedDay: 1, active: false, activationRequested: true, pausedReason: 'extension_update_required', pausedAt: NOW - 3 * DAY }));
    await scheduler.ensureIndex();
    expect(await current()).toMatchObject({ active: true, startAt: NOW - 3 * DAY, lastAppliedDay: 1, consecutiveFailures: 0 });
    expect((await current())?.pausedReason).toBeUndefined();
    expect((await current())?.activationRequested).toBeUndefined();
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy.mock.calls[1]?.[1].body).toBe('{"price":27}');
    expect((await current())?.lastAppliedDay).toBe(3);
  });
  it('keeps unchecked and otherwise paused rules paused on worker start', async () => {
    const unchecked = rule({ ruleId: 'legacy:market', active: false, activationRequested: true, pausedReason: 'extension_update_required' });
    delete unchecked.template.checkTemplate;
    seed(unchecked, rule({ ruleId: 'failed:market', active: false, pausedReason: 'consecutive_failures' }));
    await scheduler.ensureIndex();
    expect((await scheduler.getRules()).map((r) => [r.active, r.pausedReason])).toEqual([
      [false, 'extension_update_required'],
      [false, 'consecutive_failures'],
    ]);
    await scheduler.processDueRules();
    expect(proxy).not.toHaveBeenCalled();
  });
  it('ships at least the extension version the web treats as safety-aware', () => {
    expect(SAFE_REPRICE_EXTENSION_VERSION).toBe('1.0.56');
    expect(isLegacyRepriceExtension(extensionPackage.version)).toBe(false);
    expect(isLegacyRepriceExtension('1.0.55')).toBe(true);
  });
  it.each([404, 400, 422])('a %i on the shared inventory read is one strike, stops the platform and pauses nothing', async (status) => {
    const threeRules = ['1', '2', '3'].map((id) => rule({ ruleId: `${id}:market`, itemId: id, template: { ...rule().template, checkTemplate: { ...check, matcher: { ...check.matcher, id } } } }));
    seed(...threeRules);
    proxy.mockResolvedValue({ ok: false, status, data: null });
    await scheduler.processDueRules();
    expect(proxy).toHaveBeenCalledTimes(1);
    const [first, ...others] = await scheduler.getRules();
    expect(first).toMatchObject({ active: true, consecutiveFailures: 1, lastStatus: status, lastMessage: 'check_http_error', nextAttemptAt: NOW + RETRY });
    expect(first?.pausedReason).toBeUndefined();
    expect(others.every((r) => r.lastFailureAt === undefined)).toBe(true);
    expect(storage['reprice_backoff']).toEqual({ market: NOW + 2000 });
    // Next day the endpoint is healthy: every rule is checked and repriced.
    await restartWorker();
    at(NOW + DAY);
    proxy.mockReset();
    const inventory = { items: ['1', '2', '3'].map((id) => ({ id, listed: true })) };
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? { ...success, data: inventory } : success));
    await scheduler.processDueRules();
    expect((await scheduler.getRules()).map((r) => [r.active, r.lastAppliedDay])).toEqual([
      [true, 2],
      [true, 2],
      [true, 2],
    ]);
  });
  it('a 4xx on an item-specific read is a strike for that rule only and does not stop the platform', async () => {
    const second = rule({ ruleId: '2:market', itemId: '2' });
    seedSingle();
    const stored = chromeStored(storage['rule:1:market']) as ScheduledRule;
    seed(stored, { ...second, template: { ...second.template, url: 'https://market.example/listing/2' } });
    proxy.mockImplementation(async (url, options) => {
      if (url === singleCheck.request.url) return { ok: false, status: 400, data: null };
      return options.method === 'GET' ? listed : success;
    });
    await scheduler.processDueRules();
    const [first, other] = await scheduler.getRules();
    expect(first).toMatchObject({ active: true, consecutiveFailures: 1, lastStatus: 400 });
    expect(first?.pausedReason).toBeUndefined();
    expect(other).toMatchObject({ lastAppliedDay: 1 });
  });
  it('an empty inventory is never proof of absence: counted, visible, never retired', async () => {
    seed(rule());
    proxy.mockResolvedValue({ ...success, data: { items: [] } });
    for (let pass = 0; pass < 3; pass++) {
      await restartWorker();
      at(NOW + pass * RETRY);
      await scheduler.processDueRules();
    }
    expect(await current()).toMatchObject({ active: false, pausedReason: 'empty_inventory', lastMessage: 'empty_check_response' });
    expect((await current())?.retiredReason).toBeUndefined();
    expect((await current())?.pendingNotListedAt).toBeUndefined();
  });
  it('absence counts once the paged scan saw other rows, even when the last page is empty', async () => {
    const paged = rule();
    paged.template.checkTemplate = { ...check, pagination: { offsetParam: 'offset', maxPages: 3 } };
    seed(paged);
    proxy.mockResolvedValueOnce({ ...success, data: { items: [{ id: '2' }, { id: '3' }] } }).mockResolvedValueOnce({ ...success, data: { items: [] } });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, pendingNotListedAt: NOW, lastMessage: 'absent_from_complete_response' });
  });
  it('pauses a rule blocked without a break for a week, and a success in between restarts the clock', async () => {
    seed(rule({ blockedSince: NOW - REPRICE_BLOCKED_PAUSE_MS + 1 }));
    proxy.mockResolvedValue({ ok: false, status: 401, data: null });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, blockedSince: NOW - REPRICE_BLOCKED_PAUSE_MS + 1, nextAttemptAt: NOW + RETRY });
    await restartWorker();
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: false, pausedReason: 'blocked_too_long', lastStatus: 401 });
    // A success clears the run of blocks (after the platform block has expired).
    seed(rule({ blockedSince: NOW - REPRICE_BLOCKED_PAUSE_MS + 1 }));
    delete storage['reprice_backoff'];
    proxy.mockReset();
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await restartWorker();
    await scheduler.processDueRules();
    expect((await current())?.blockedSince).toBeUndefined();
  });
  it('pauses a rule that failed only temporarily for a week, and a success or a counted failure restarts the clock', async () => {
    seed(rule({ transientSince: NOW - REPRICE_TRANSIENT_PAUSE_MS + 1, transientFailures: 30 }));
    proxy.mockResolvedValue({ ok: false, status: 503, data: null });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, transientSince: NOW - REPRICE_TRANSIENT_PAUSE_MS + 1, transientFailures: 31 });
    await restartWorker();
    at(NOW + RETRY);
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: false, pausedReason: 'transient_too_long', lastStatus: 503 });
    // A counted failure in between breaks the run.
    seed(rule({ transientSince: NOW - REPRICE_TRANSIENT_PAUSE_MS, transientFailures: 30 }));
    delete storage['reprice_backoff'];
    proxy.mockReset();
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ok: false, status: 409, data: null });
    await restartWorker();
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ active: true, consecutiveFailures: 1 });
    expect((await current())?.transientSince).toBeUndefined();
  });
  it.each([
    ['errors[]', { errors: [{ id: '1', message: 'Price too low' }] }],
    ['failed[]', { failed: [{ item_id: 1, message: 'Rejected' }] }],
    ['items[].success false', { items: [{ asset_id: '1', success: false }] }],
    ['items[].status rejected', { items: [{ id: '1', status: 'rejected' }] }],
  ])('a 2xx write rejecting the item (%s) is a counted failure, never success, never the final delete', async (_shape, data) => {
    const itemErrors = {
      rejectedPaths: [['errors'], ['failed']],
      resultPaths: [['items']],
      rejectedWhen: [
        { path: ['success'], values: [false] },
        { path: ['status'], values: ['rejected', 'failed'] },
      ],
      idPaths: [['id'], ['item_id'], ['asset_id']],
      id: '1',
    };
    for (const final of [false, true]) {
      storage = {};
      proxy.mockReset();
      const withItemErrors = rule(final ? { startAt: NOW - 40 * DAY } : {});
      withItemErrors.template = { ...withItemErrors.template, itemErrors };
      seed(withItemErrors);
      await restartWorker();
      proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ...success, data });
      await scheduler.processDueRules();
      expect(await current()).toMatchObject({ active: true, lastAppliedDay: 0, consecutiveFailures: 1, lastMessage: 'step_item_rejected', lastStatus: 200 });
      expect(storage['rule_index']).toEqual(['1:market']);
    }
  });
  it('a 2xx write that rejects only other items is a success', async () => {
    const withItemErrors = rule();
    withItemErrors.template = { ...withItemErrors.template, itemErrors: { rejectedPaths: [['errors']], idPaths: [['id']], id: '1' } };
    seed(withItemErrors);
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ...success, data: { errors: [{ id: '2' }] } });
    await scheduler.processDueRules();
    expect(await current()).toMatchObject({ lastAppliedDay: 1, consecutiveFailures: 0 });
  });
  it('an activation with a step already due schedules a pass soon; a fresh rule does not', async () => {
    await scheduler.registerRule(rule({ ruleId: 'fresh:market', startAt: NOW, createdAt: NOW }));
    expect(alarm).not.toHaveBeenCalled();
    await scheduler.registerRule(rule({ startAt: NOW - 3 * DAY, active: false, activationRequested: true, pausedReason: 'consecutive_failures' }));
    expect(alarm).toHaveBeenLastCalledWith('qts:reprice-continue', { when: NOW + 60_000 });
  });
  it('keeps at least the platform gap between any two requests to a platform', async () => {
    const events: string[] = [];
    vi.mocked(wait).mockImplementation(async (ms: number) => {
      events.push(`wait:${ms}`);
    });
    const pagedCheck: RepriceCheckTemplate = { ...check, matcher: { ...check.matcher, pageSize: 2 }, pagination: { offsetParam: 'offset', maxPages: 5 } };
    const withId = (id: string) => rule({ ruleId: `${id}:market`, itemId: id, template: { ...rule().template, checkTemplate: { ...pagedCheck, matcher: { ...pagedCheck.matcher, id } } } });
    seed(withId('1'), withId('2'), withId('3'), withId('4'));
    const inventory = ['1', '2', '3', '4', '5'].map((id) => ({ id, listed: true }));
    proxy.mockImplementation(async (url, options) => {
      events.push(`request:${options.method}`);
      if (options.method !== 'GET') return success;
      const offset = Number(new URL(url).searchParams.get('offset'));
      return { ...success, data: { items: inventory.slice(offset, offset + 2) } };
    });
    await scheduler.processDueRules();
    expect(events.filter((event) => event === 'request:PATCH')).toHaveLength(4);
    // Between any two requests there is at least one 500 ms wait.
    const requestIndexes = events.flatMap((event, index) => (event.startsWith('request:') ? [index] : []));
    for (let i = 1; i < requestIndexes.length; i++) {
      expect(events.slice(requestIndexes[i - 1]! + 1, requestIndexes[i]!)).toContain('wait:500');
    }
    expect(events.filter((event) => event.startsWith('wait:')).every((event) => event === 'wait:500')).toBe(true);
  });
  it('waits the platform gap between consecutive pages of one scan and before the write', async () => {
    const events: string[] = [];
    vi.mocked(wait).mockImplementation(async (ms: number) => {
      events.push(`wait:${ms}`);
    });
    const paged = rule({ ruleId: '5:market', itemId: '5' });
    paged.template.checkTemplate = { ...check, matcher: { ...check.matcher, id: '5' }, pagination: { offsetParam: 'offset', maxPages: 5 } };
    seed(paged);
    const inventory = ['1', '2', '3', '4', '5'].map((id) => ({ id, listed: true }));
    proxy.mockImplementation(async (url, options) => {
      events.push(options.method === 'GET' ? `GET offset=${new URL(url).searchParams.get('offset')}` : `${options.method}`);
      if (options.method !== 'GET') return success;
      const offset = Number(new URL(url).searchParams.get('offset'));
      return { ...success, data: { items: inventory.slice(offset, offset + 2) } };
    });
    await scheduler.processDueRules();
    expect(events).toEqual(['GET offset=0', 'wait:500', 'GET offset=2', 'wait:500', 'GET offset=4', 'wait:500', 'PATCH']);
  });
});

describe("the scheduler's runs in the support journal (QUICK-214)", () => {
  const JOURNAL = 'qts:diagnostics:journal';
  const journal = () => (storage[JOURNAL] ?? []) as Array<{ owner: string; at: number; event: Record<string, unknown> }>;

  it("files a rule's run under the account that registered it: the step written", async () => {
    seed(rule({ owner: 'user_alice' }));
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    // Not awaited by the pass: the journal's write lands just after.
    await vi.waitFor(() => expect(journal()).toEqual([{ owner: 'user_alice', at: NOW, event: { kind: 'scheduler', platform: 'market', stage: 'write', outcome: 'ok' } }]));
  });

  it('notes a failed write with its status, and a check that found the platform blocked as a retry', async () => {
    seed(rule({ owner: 'user_alice' }), rule({ ruleId: '2:other', platform: 'other', itemId: '2', owner: 'user_bob' }));
    vi.mocked(hasPermission).mockImplementation(async (platform: string) => platform === 'market');
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ok: false, status: 400, data: {} });
    await scheduler.processDueRules();
    await vi.waitFor(() => expect(journal()).toHaveLength(2));
    expect(journal().map(({ owner, event }) => [owner, event['stage'], event['outcome'], event['status']])).toEqual(
      expect.arrayContaining([
        ['user_alice', 'write', 'error', 400],
        ['user_bob', 'check', 'retry', undefined],
      ])
    );
  });

  it('journals nothing for a rule without an owner (an older web registered it)', async () => {
    seed(rule());
    proxy.mockResolvedValueOnce(listed).mockResolvedValueOnce(success);
    await scheduler.processDueRules();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage[JOURNAL]).toBeUndefined();
  });

  it('keeps an owner only when it is a Clerk user id', async () => {
    await scheduler.registerRule(rule({ owner: 'user_alice' }));
    expect(await current()).toMatchObject({ owner: 'user_alice' });
    await scheduler.registerRule(rule({ owner: 'not a clerk id', createdAt: NOW }));
    expect(await current()).not.toHaveProperty('owner');
  });

  it('the same rule delivered again keeps its owner; a new rule for the pair belongs to its registrant', async () => {
    await scheduler.registerRule(rule({ owner: 'user_alice' }));
    await scheduler.registerRule(rule({ owner: 'user_bob' }));
    expect(await current()).toMatchObject({ owner: 'user_alice' });
    await scheduler.registerRule(rule({ owner: 'user_bob', createdAt: NOW }));
    expect(await current()).toMatchObject({ owner: 'user_bob' });
  });
});
