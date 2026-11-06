// QUICK-232: the account's QTS buy orders pushed by the web, through the real message entry point
// (onRuntimeMessage → handlers/site.ts → buy-orders-store.ts), with only the browser APIs faked.
import type { BuyOrdersSnapshot } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeSender } from '../../shared/bridge-policy';
import type * as Router from '../runtime-router';
import { chromeStored } from './chrome-storage';

vi.mock('../../shared/config', () => ({ BRIDGE_MODE: 'production' }));

const PAGE: BridgeSender = { id: 'qts', tab: { id: 2 }, frameId: 0, origin: 'https://app.quicktrade.skin', url: 'https://app.quicktrade.skin/buy-orders' };
const KEY = 'qts_buy_orders';

const RULE = {
  id: 'r1',
  name: 'Printstream MW cheap',
  item: 'M4A1-S | Printstream (Minimal Wear)',
  category: 'any',
  minFloat: 0.07,
  maxFloat: 0.1,
  wears: [],
  seeds: [],
  phase: null,
  sticker: '',
  maxStickerPremiumPct: null,
  sources: ['csfloat'],
  maxPriceCents: 27_000,
  belowEstimatePct: 8,
  maxItemsPerDay: 3,
  dailyBudgetCents: 80_000,
  enabled: true,
  mode: 'auto',
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
} as const;

function snapshot(patch: Partial<BuyOrdersSnapshot> = {}): BuyOrdersSnapshot {
  return { clerkId: 'user_one', revision: 2, dailyBudgetCents: 150_000, rules: [{ ...RULE, wears: [], seeds: [], sources: ['csfloat'] }], updatedAt: '2026-10-25T10:00:00.000Z', ...patch };
}

let router: typeof Router;
let storage: Record<string, unknown>;
const local = { get: vi.fn(), set: vi.fn() };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  storage = {};
  local.get.mockImplementation(async (keys: string | string[]) =>
    Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((key) => key in storage).map((key) => [key, chromeStored(storage[key])]))
  );
  local.set.mockImplementation(async (values: Record<string, unknown>) => {
    // A slow write, so two pushes in flight would interleave without the store's queue.
    await new Promise((resolve) => setTimeout(resolve, 5));
    Object.assign(storage, chromeStored(values));
  });
  vi.stubGlobal('browser', { runtime: { id: 'qts', getURL: (path = '/') => `chrome-extension://qts${path}` }, storage: { local } });
  router = await import('../runtime-router');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function push(data: unknown, sender: BridgeSender = PAGE): Promise<unknown> {
  const reply = vi.fn();
  router.onRuntimeMessage({ type: 'site:set_buy_orders', data }, sender, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
  return reply.mock.calls[0]?.[0];
}

describe('set_buy_orders (QUICK-232)', () => {
  it('keeps a valid snapshot and answers its revision', async () => {
    expect(await push(snapshot())).toEqual({ ok: true, data: { stored: true, revision: 2 } });
    expect(storage[KEY]).toEqual(chromeStored(snapshot()));
  });

  it('keeps only a newer revision of the same account', async () => {
    await push(snapshot({ revision: 5 }));
    expect(await push(snapshot({ revision: 4, rules: [] }))).toEqual({ ok: true, data: { stored: false, revision: 5 } });
    expect(await push(snapshot({ revision: 5, rules: [] }))).toEqual({ ok: true, data: { stored: false, revision: 5 } });
    expect((storage[KEY] as BuyOrdersSnapshot).rules).toHaveLength(1);
    expect(await push(snapshot({ revision: 6, rules: [] }))).toEqual({ ok: true, data: { stored: true, revision: 6 } });
    expect((storage[KEY] as BuyOrdersSnapshot).rules).toEqual([]);
  });

  it('replaces another account’s rules whatever the revision', async () => {
    await push(snapshot({ revision: 9 }));
    expect(await push(snapshot({ clerkId: 'user_two', revision: 1 }))).toEqual({ ok: true, data: { stored: true, revision: 1 } });
    expect((storage[KEY] as BuyOrdersSnapshot).clerkId).toBe('user_two');
  });

  it('never lets an older push that arrives together win', async () => {
    await Promise.all([push(snapshot({ revision: 8 })), push(snapshot({ revision: 7, rules: [] }))]);
    expect((storage[KEY] as BuyOrdersSnapshot).revision).toBe(8);
  });

  it.each([
    ['no account', snapshot({ clerkId: '' })],
    ['a rule outside the contract', snapshot({ rules: [{ ...snapshot().rules[0]!, maxPriceCents: 270.5 }] })],
    ['a rule in auto mode without the account budget', snapshot({ dailyBudgetCents: null })],
    ['more than 10 rules on', snapshot({ rules: Array.from({ length: 11 }, (_, i) => ({ ...snapshot().rules[0]!, id: `r${i}` })) })],
    ['not an object', 'rules'],
  ])('refuses %s and keeps what it had', async (_label, data) => {
    await push(snapshot());
    local.set.mockClear();
    expect(await push(data)).toEqual({ ok: false, error: 'buy_orders_refused:invalid' });
    expect(local.set).not.toHaveBeenCalled();
    expect(storage[KEY]).toEqual(chromeStored(snapshot()));
  });

  it('refuses a sender that is not the web app before reading anything', async () => {
    const reply = vi.fn();
    expect(router.onRuntimeMessage({ type: 'site:set_buy_orders', data: snapshot() }, { ...PAGE, origin: 'https://evil.test', url: 'https://evil.test/' }, reply)).toBe(false);
    expect(reply).toHaveBeenCalledWith({ ok: false, error: 'bridge_forbidden_origin' });
    expect(local.get).not.toHaveBeenCalled();
  });
});
