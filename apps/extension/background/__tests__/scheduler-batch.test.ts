import { type PlatformSchedulerPolicy, REPRICE_TRANSIENT_RETRY_MS, type RepriceResponse, type ScheduledListingRule, type ScheduledRule } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wait } from '@/shared/utils';

import { buildRepriceTemplate } from '../../test-support/web/sell/repriceSchedule';
import { buildListingTemplate, csfloatLiveLotPrecondition } from '../../test-support/web/sell/scheduledListing';
import { hasPermission } from '../permissions';
import { proxyRequest } from '../proxy';
import type * as Scheduler from '../scheduler';
import { chromeStored } from './chrome-storage';

vi.mock('../permissions', () => ({ hasPermission: vi.fn() }));
vi.mock('../proxy', () => ({ proxyRequest: vi.fn() }));
vi.mock('@/shared/utils', () => ({ wait: vi.fn(async () => undefined) }));

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const proxy = vi.mocked(proxyRequest);
let storage: Record<string, unknown>;
let scheduler: typeof Scheduler;
const ok = (data: unknown): RepriceResponse => ({ ok: true, status: 200, data });
const fail = (status: number): RepriceResponse => ({ ok: false, status, data: null });

const CSMONEY_POLICY: PlatformSchedulerPolicy = { maxBatchItems: 60, maxFiresPerPass: 120 };

function listing(itemId: string): ScheduledListingRule {
  return {
    kind: 'list',
    ruleId: `list:${itemId}:cs.money`,
    platform: 'cs.money',
    itemId,
    marketHashName: 'fixture',
    listAt: NOW,
    fixedPrice: 2.34,
    template: buildListingTemplate('cs.money', itemId, 2.34, '76561198000000042')!,
    days: 0,
    firstPrice: 2.34,
    secondPrice: 2.34,
    startAt: NOW,
    lastAppliedDay: 0,
    createdAt: NOW - 1000,
    active: true,
  };
}

/** A two-day ramp started a day ago: the next step (day 1, the floor) is due now. */
function reprice(itemId: string): ScheduledRule {
  return {
    ruleId: `${itemId}:cs.money`,
    platform: 'cs.money',
    itemId,
    marketHashName: 'fixture',
    firstPrice: 10,
    secondPrice: 8,
    startAt: NOW - DAY,
    days: 1,
    lastAppliedDay: 0,
    template: buildRepriceTemplate('cs.money', itemId, undefined)!,
    active: true,
    createdAt: NOW - DAY,
  };
}

function seed(rules: ScheduledRule[], policy?: PlatformSchedulerPolicy) {
  storage['rule_index'] = rules.map((rule) => rule.ruleId);
  for (const rule of rules) storage[`rule:${rule.ruleId}`] = chromeStored(rule);
  storage['qts_platform_catalog'] = [{ id: 'cs.money', label: 'CS.Money', origins: ['https://cs.money/*'], ...(policy ? { scheduler: policy } : {}) }];
}

const ids = (count: number, from = 100) => Array.from({ length: count }, (_, index) => String(from + index));
const writes = () => proxy.mock.calls.filter(([, options]) => options.method !== 'GET');
const reads = () => proxy.mock.calls.filter(([, options]) => options.method === 'GET');
const writtenIds = (call: (typeof proxy.mock.calls)[number]) => (JSON.parse(String(call[1].body)) as { items: Array<{ id: number }> }).items.map((item) => String(item.id));
const rule = (ruleId: string) => storage[`rule:${ruleId}`] as ScheduledRule | undefined;
const itemCount = (body: string) => (JSON.parse(body) as { items: unknown[] }).items.length;

/** cs.money's inventory with these items (`onSale` for the listed ones); writes answered by `write`. */
interface InventoryOptions {
  listed?: string[];
  write?: (body: string) => RepriceResponse;
}

function inventory(items: string[], { listed = [], write = () => ok({}) }: InventoryOptions = {}) {
  proxy.mockImplementation(async (_url, options) => {
    if (options.method !== 'GET') return write(String(options.body));
    return ok({ items: items.map((id) => ({ id, onSale: listed.includes(id) })) });
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

describe('batched scheduled writes (QUICK-289)', () => {
  it('lists due cs.money one-shots in one write, each retired as listed', async () => {
    const items = ids(3);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items);

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(1);
    expect(writtenIds(writes()[0]!)).toEqual(items);
    expect(JSON.parse(String(writes()[0]![1].body))).toEqual({ items: items.map((id) => ({ id: Number(id), price: 2.34 })) });
    for (const id of items) expect(rule(`list:${id}:cs.money`)).toMatchObject({ active: false, retiredReason: 'listed' });
  });

  it('spends no platform gap on a rule whose checks the shared reads answered', async () => {
    const items = ids(10);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items);

    await scheduler.processDueRules();

    // One gap after the first rule's read, one after the batch's fresh read, one before its write: not one per rule.
    expect(vi.mocked(wait).mock.calls.length).toBeLessThan(5);
  });

  it('reads the shared inventory once for the checks and once, fresh, right before the write', async () => {
    const items = ids(3);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items);

    await scheduler.processDueRules();

    expect(reads()).toHaveLength(2);
  });

  it('splits a larger batch into writes of the policy size', async () => {
    const items = ids(65);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items);

    await scheduler.processDueRules();

    expect(writes().map((call) => writtenIds(call).length)).toEqual([60, 5]);
  });

  it('writes every rule alone without a scheduler policy, as before', async () => {
    const items = ids(3);
    seed(items.map(listing));
    inventory(items);

    await scheduler.processDueRules();

    expect(writes().map(writtenIds)).toEqual(items.map((id) => [id]));
  });

  it('clamps a policy above the build limit to its bounds', async () => {
    const items = ids(130);
    seed(items.map(listing), { maxBatchItems: 10_000, maxFiresPerPass: 10_000 });
    inventory(items);

    await scheduler.processDueRules();

    expect(writes().map((call) => writtenIds(call).length)).toEqual([100, 30]);
  });

  it('reprices due cs.money ramps in one write at each rule’s price', async () => {
    const items = ids(2);
    seed(items.map(reprice), CSMONEY_POLICY);
    inventory(items, { listed: items });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0]![1].body))).toEqual({ items: items.map((id) => ({ id: Number(id), price: 8 })) });
    // The ramp's last step: the rules are done.
    for (const id of items) expect(rule(`${id}:cs.money`)).toBeUndefined();
  });

  it('leaves out a rule the fresh read no longer finds listable, without recording anything', async () => {
    const items = ids(3);
    seed(items.map(listing), CSMONEY_POLICY);
    let readCount = 0;
    proxy.mockImplementation(async (_url, options) => {
      if (options.method !== 'GET') return ok({});
      readCount++;
      // The second read (the batch's fresh one) sees the first item already on sale.
      return ok({ items: items.map((id) => ({ id, onSale: readCount > 1 && id === items[0] })) });
    });
    const before = rule(`list:${items[0]}:cs.money`);

    await scheduler.processDueRules();

    expect(writtenIds(writes()[0]!)).toEqual(items.slice(1));
    expect(rule(`list:${items[0]}:cs.money`)).toEqual(before);
  });

  it('fails only the item a 2xx answer rejects', async () => {
    const items = ids(3);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items, { write: () => ok({ errors: [{ id: Number(items[1]) }] }) });

    await scheduler.processDueRules();

    expect(rule(`list:${items[0]}:cs.money`)).toMatchObject({ retiredReason: 'listed' });
    expect(rule(`list:${items[2]}:cs.money`)).toMatchObject({ retiredReason: 'listed' });
    expect(rule(`list:${items[1]}:cs.money`)).toMatchObject({ lastMessage: 'step_item_rejected' });
    expect(rule(`list:${items[1]}:cs.money`)?.retiredReason).toBeUndefined();
  });

  it('retries a refused batch item by item, and lists what each item’s own write takes', async () => {
    const items = ids(3);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items, { write: (body) => (itemCount(body) > 1 ? { ok: false, status: 400, data: { errors: [{ code: 9999 }] } } : ok({})) });

    await scheduler.processDueRules();

    expect(writes().map((call) => writtenIds(call).length)).toEqual([3, 1, 1, 1]);
    for (const id of items) expect(rule(`list:${id}:cs.money`)).toMatchObject({ retiredReason: 'listed' });
  });

  it('stops isolating when an item alone meets a terminal refusal too, and pauses nobody for it', async () => {
    const items = ids(4);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items, { write: () => fail(400) });

    await scheduler.processDueRules();

    // As for a write sent alone, a terminal status stops the platform for the pass; the rest keep the batch's answer.
    expect(writes().map((call) => writtenIds(call).length)).toEqual([4, 1]);
    for (const id of items) {
      const stored = rule(`list:${id}:cs.money`)!;
      expect(stored.pausedReason).toBeUndefined();
      expect(stored).toMatchObject({ active: true, lastStatus: 400 });
    }
    expect(storage['reprice_backoff']).toMatchObject({ 'cs.money': expect.any(Number) });
  });

  it('stops isolating when the first two items alone repeat a non-terminal refusal: an account-level one', async () => {
    const items = ids(4);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items, { write: () => fail(409) });

    await scheduler.processDueRules();

    expect(writes().map((call) => writtenIds(call).length)).toEqual([4, 1, 1]);
    for (const id of items) expect(rule(`list:${id}:cs.money`)).toMatchObject({ active: true, lastStatus: 409 });
  });

  it('shares one identity scan among trade-protected one-shots, and reads it again only for the write', async () => {
    const copies = ids(3).map((id, index) => ({ id, name: `Fixture ${index}`, float: `0.12345${index}`, seed: index }));
    const rules = copies.map(({ id, name, float, seed: copySeed }) => ({
      ...listing(id),
      template: buildListingTemplate('cs.money', id, 2.34, '76561198000000042', { name, float, seed: copySeed })!,
    }));
    seed(rules, CSMONEY_POLICY);
    proxy.mockImplementation(async (_url, options) => {
      if (options.method !== 'GET') return ok({});
      // Steam re-issued every asset id since scheduling: the rows carry new ids.
      return ok({ items: copies.map(({ id, name, float, seed: copySeed }) => ({ id: `9${id}`, onSale: false, fullName: name, float: Number(float), pattern: copySeed })) });
    });

    await scheduler.processDueRules();

    expect(reads()).toHaveLength(2);
    expect(writes()).toHaveLength(1);
    expect(writtenIds(writes()[0]!)).toEqual(copies.map(({ id }) => `9${id}`));
  });

  it('keeps every one-shot of a rate-limited batch reserved as an uncertain write, and backs the platform off', async () => {
    const items = ids(3);
    seed(items.map(listing), CSMONEY_POLICY);
    inventory(items, { write: () => fail(429) });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(1);
    for (const id of items) expect(rule(`list:${id}:cs.money`)).toMatchObject({ active: false, pausedReason: 'listing_outcome_unknown' });
    expect(storage['reprice_backoff']).toMatchObject({ 'cs.money': expect.any(Number) });
  });
});

/** The cs.money policy the web catalog publishes since QUICK-289 PR 2: the item limit plus its error map. */
const CSMONEY_ERRORS_POLICY: PlatformSchedulerPolicy = {
  ...CSMONEY_POLICY,
  errors: {
    codePaths: [['errors', 'code']],
    rules: [
      { status: 400, code: 134, stage: 'write', outcome: 'transient', halveBatch: true },
      { status: 400, code: 9999, stage: 'write', outcome: 'transient' },
    ],
  },
};
const refusal = (code: number): RepriceResponse => ({ ok: false, status: 400, data: { errors: [{ code }] } });

describe('the policy error map (QUICK-289 PR 2)', () => {
  it('sends a batch refused as too large (cs.money 134) again in halves, and keeps the pass’s later batches as small', async () => {
    const items = ids(6);
    seed(items.map(listing), { ...CSMONEY_ERRORS_POLICY, maxBatchItems: 4 });
    inventory(items, { write: (body) => (itemCount(body) > 2 ? refusal(134) : ok({})) });

    await scheduler.processDueRules();

    expect(writes().map((call) => writtenIds(call).length)).toEqual([4, 2, 2, 2]);
    for (const id of items) expect(rule(`list:${id}:cs.money`)).toMatchObject({ retiredReason: 'listed' });
  });

  it('retries a batch cs.money refused with 9999 later, as a whole: no item is isolated, failed or paused', async () => {
    const items = ids(3);
    seed(items.map(listing), CSMONEY_ERRORS_POLICY);
    inventory(items, { write: () => refusal(9999) });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(1);
    for (const id of items) {
      const stored = rule(`list:${id}:cs.money`)!;
      expect(stored).toMatchObject({ active: true, transientFailures: 1, consecutiveFailures: 0, lastStatus: 400 });
      expect(stored.pausedReason).toBeUndefined();
    }
    expect(storage['reprice_backoff']).toMatchObject({ 'cs.money': expect.any(Number) });
  });

  it('reads a refusal the map does not name by the built-in rules: a refused batch is isolated as before', async () => {
    const items = ids(3);
    seed(items.map(listing), CSMONEY_ERRORS_POLICY);
    inventory(items, { write: (body) => (itemCount(body) > 1 ? refusal(1) : ok({})) });

    await scheduler.processDueRules();

    expect(writes().map((call) => writtenIds(call).length)).toEqual([3, 1, 1, 1]);
  });

  it('blocks the platform on a refusal the map reads as `auth`, without isolating the batch', async () => {
    const items = ids(3);
    const errors = { codePaths: [['errors', 'code']], rules: [{ status: 400, code: 109, outcome: 'auth' as const }] };
    seed(items.map(listing), { ...CSMONEY_POLICY, errors });
    inventory(items, { write: () => refusal(109) });

    await scheduler.processDueRules();

    // Account-level: one write, nothing isolated, every rule kept (blocked, not counted).
    expect(writes()).toHaveLength(1);
    for (const id of items) expect(rule(`list:${id}:cs.money`)).toMatchObject({ active: true, consecutiveFailures: 0, blockedSince: NOW });
  });
});

describe('explicit price schedules (QUICK-289 PR 2)', () => {
  /** A ramp whose web-planned day 1 price (9.13) is not the linear one (9). */
  function scheduled(itemId: string): ScheduledRule {
    return {
      ...reprice(itemId),
      days: 2,
      schedule: [
        { at: NOW - DAY, price: 10 },
        { at: NOW - 1000, price: 9.13 },
        { at: NOW + DAY, price: 8 },
      ],
    };
  }

  it('fires the latest step whose time has passed, not the linear ramp', async () => {
    seed([scheduled('100')], CSMONEY_POLICY);
    inventory(['100'], { listed: ['100'] });

    await scheduler.processDueRules();

    expect(JSON.parse(String(writes()[0]![1].body))).toEqual({ items: [{ id: 100, price: 9.13 }] });
    expect(rule('100:cs.money')).toMatchObject({ lastAppliedDay: 1, active: true });
  });

  it('writes nothing while no new step is due', async () => {
    seed([{ ...scheduled('100'), lastAppliedDay: 1 }], CSMONEY_POLICY);
    inventory(['100'], { listed: ['100'] });

    await scheduler.processDueRules();

    expect(proxy).not.toHaveBeenCalled();
  });

  it('refuses to register a malformed schedule', async () => {
    const malformed = {
      ...scheduled('100'),
      schedule: [
        { at: NOW, price: 10 },
        { at: NOW - 1, price: 8 },
      ],
    };

    await expect(scheduler.registerRule(malformed)).rejects.toThrow('invalid_price_schedule');
    expect(rule('100:cs.money')).toBeUndefined();
  });
});

describe('cs.money one-shots held behind their CSFloat lots (cross-list hold, batched)', () => {
  const CSFLOAT_STEAM_ID = '76561198000000043';
  function held(itemId: string): ScheduledListingRule {
    const base = listing(itemId);
    return { ...base, template: { ...base.template, precondition: csfloatLiveLotPrecondition(itemId, CSFLOAT_STEAM_ID)! } };
  }
  const stallReads = () => proxy.mock.calls.filter(([url]) => url.includes('/stall'));
  const inventoryReads = () => proxy.mock.calls.filter(([url, options]) => options.method === 'GET' && !url.includes('/stall'));

  interface HeldMarkets {
    /** The items with an unsold CSFloat lot, per stall read (1-based). */
    lots: (read: number) => string[];
    /** cs.money's inventory read; the items unlisted unless overridden. */
    inventoryAnswer?: () => RepriceResponse;
  }

  function markets(items: string[], { lots, inventoryAnswer }: HeldMarkets) {
    let stallRead = 0;
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return ok({});
      if (url.includes('/stall')) {
        stallRead++;
        const live = lots(stallRead);
        return ok({ data: live.map((id) => ({ id: `lot-${id}`, item: { asset_id: id } })), total_count: live.length });
      }
      return inventoryAnswer?.() ?? ok({ items: items.map((id) => ({ id, onSale: false })) });
    });
  }

  it('lists four held one-shots due together in one write, from one shared read of each market and one fresh read before the write', async () => {
    const items = ids(4);
    seed(items.map(held), CSMONEY_POLICY);
    markets(items, { lots: () => items });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(1);
    expect(writtenIds(writes()[0]!)).toEqual(items);
    // One read of the cs.money inventory and of the CSFloat stall for the four checks, one of each right before the write.
    expect(inventoryReads()).toHaveLength(2);
    expect(stallReads()).toHaveLength(2);
    expect(stallReads().every(([, options]) => options.platform === 'csfloat.com')).toBe(true);
    for (const id of items) expect(rule(`list:${id}:cs.money`)).toMatchObject({ active: false, retiredReason: 'listed' });
  });

  it('retires a one-shot whose lot is gone and leaves it out of the write', async () => {
    const items = ids(4);
    seed(items.map(held), CSMONEY_POLICY);
    markets(items, { lots: () => items.slice(1) });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(1);
    expect(writtenIds(writes()[0]!)).toEqual(items.slice(1));
    expect(rule(`list:${items[0]}:cs.money`)).toMatchObject({ active: false, retiredReason: 'required_lot_gone' });
  });

  it('retires a one-shot whose lot sold after its own check, by the fresh read right before the write', async () => {
    const items = ids(4);
    seed(items.map(held), CSMONEY_POLICY);
    // The pass's shared stall read still shows every lot; the batch's own read no longer has the last one.
    markets(items, { lots: (read) => (read === 1 ? items : items.slice(0, 3)) });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(1);
    expect(writtenIds(writes()[0]!)).toEqual(items.slice(0, 3));
    expect(rule(`list:${items[3]}:cs.money`)).toMatchObject({ active: false, retiredReason: 'required_lot_gone' });
  });

  it('leaves out a one-shot cs.money already lists, without reading a lot for it', async () => {
    const items = ids(4);
    seed(items.map(held), CSMONEY_POLICY);
    markets(items, { lots: () => items, inventoryAnswer: () => ok({ items: items.map((id) => ({ id, onSale: id === items[2] })) }) });

    await scheduler.processDueRules();

    expect(writtenIds(writes()[0]!)).toEqual([items[0], items[1], items[3]]);
    expect(rule(`list:${items[2]}:cs.money`)).toMatchObject({ active: false, retiredReason: 'already_listed' });
  });

  it('writes nothing for one-shots whose lot read failed, and retries them within minutes', async () => {
    const items = ids(2);
    seed(items.map(held), CSMONEY_POLICY);
    proxy.mockImplementation(async (url, options) => {
      if (options.method !== 'GET') return ok({});
      if (url.includes('/stall')) return fail(503);
      return ok({ items: items.map((id) => ({ id, onSale: false })) });
    });

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(0);
    for (const id of items) {
      expect(rule(`list:${id}:cs.money`)).toMatchObject({ active: true, lastMessage: 'precondition_check_http_error', nextAttemptAt: NOW + REPRICE_TRANSIENT_RETRY_MS });
    }
  });
});

describe('cs.money 400 code 4 on the inventory read (observed right after writes)', () => {
  const CODE_4_POLICY: PlatformSchedulerPolicy = {
    ...CSMONEY_ERRORS_POLICY,
    errors: { codePaths: [['errors', 'code']], rules: [...CSMONEY_ERRORS_POLICY.errors!.rules, { status: 400, code: 4, stage: 'check', outcome: 'transient' }] },
  };

  it('is transient: the one-shot looks again within minutes, uncounted, and cs.money backs off for the pass', async () => {
    const items = ids(2);
    seed(items.map(listing), CODE_4_POLICY);
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? refusal(4) : ok({})));

    await scheduler.processDueRules();

    expect(writes()).toHaveLength(0);
    // The first rule's read failed and cs.money stopped for the pass: the second was not read.
    expect(reads()).toHaveLength(1);
    expect(rule(`list:${items[0]}:cs.money`)).toMatchObject({
      active: true,
      lastStatus: 400,
      lastMessage: 'check_http_error',
      consecutiveFailures: 0,
      transientFailures: 1,
      nextAttemptAt: NOW + REPRICE_TRANSIENT_RETRY_MS,
    });
    expect(storage['reprice_backoff']).toMatchObject({ 'cs.money': expect.any(Number) });
  });

  it('without the map entry stays a counted failure retried hours later, as before', async () => {
    seed([listing('100')], CSMONEY_ERRORS_POLICY);
    proxy.mockImplementation(async (_url, options) => (options.method === 'GET' ? refusal(4) : ok({})));

    await scheduler.processDueRules();

    expect(rule('list:100:cs.money')).toMatchObject({ consecutiveFailures: 1 });
    expect(rule('list:100:cs.money')!.nextAttemptAt! - NOW).toBeGreaterThan(60 * 60_000);
  });
});
