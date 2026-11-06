import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/shared/storage';

import type * as ListingBlocks from '../listing-blocks';
import { chromeStored } from './chrome-storage';

vi.mock('../../shared/config', () => ({ BRIDGE_MODE: 'production' }));

let storage: Record<string, unknown>;
let blocks: typeof ListingBlocks;
const NOW = 1_800_000_000_000;
const snapshot = (owner = 'user_A', at = 100, assetIds = ['42']) => ({ owner, at, assetIds, expiresAt: Object.fromEntries(assetIds.map((id) => [id, NOW + 60_000])) });

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  storage = {};
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => chromeStored({ [key]: storage[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storage, chromeStored(values));
        }),
      },
    },
  });
  blocks = await import('../listing-blocks');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pushed listing blocks', () => {
  it('stores through the real app-origin runtime route and refuses foreign senders before storage access', async () => {
    Object.assign(browser, { runtime: { id: 'qts', getURL: () => 'chrome-extension://qts/' } });
    const { onRuntimeMessage } = await import('../runtime-router');
    const sender = { id: 'qts', tab: { id: 2 }, frameId: 0, origin: 'https://app.quicktrade.skin', url: 'https://app.quicktrade.skin/sell-mode' };
    const reply = vi.fn();
    const message = { type: 'site:set_listing_blocks', data: snapshot() };
    for (const origin of ['https://foreign.test', 'https://quicktrade.skin', 'https://app.quicktrade.skin.evil.test']) {
      expect(onRuntimeMessage(message, { ...sender, origin, url: origin }, reply)).toBe(false);
    }
    expect(browser.storage.local.get).not.toHaveBeenCalled();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    reply.mockClear();
    expect(onRuntimeMessage(message, sender, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true, data: { accepted: true } }));
    expect(storage[StorageKeys.listingBlocks]).toEqual([snapshot()]);
  });

  it.each([
    null,
    {},
    snapshot(''),
    snapshot('someone'),
    snapshot('user_bad owner'),
    snapshot('user_A', -1),
    snapshot('user_A', NaN),
    snapshot('user_A', Infinity),
    snapshot('user_A', 1.5),
    snapshot('user_A', 1, ['']),
    snapshot('user_A', 1, ['42', '42']),
    snapshot(
      'user_A',
      1,
      Array.from({ length: 401 }, (_, i) => String(i))
    ),
    { ...snapshot(), assetIds: [42] },
    { ...snapshot(), assetIds: '42' },
    { ...snapshot(), expiresAt: undefined },
    { ...snapshot(), expiresAt: {} },
    { ...snapshot(), expiresAt: { '42': NaN } },
    { ...snapshot(), expiresAt: { '42': Infinity } },
    { ...snapshot(), expiresAt: { '42': -1 } },
    { ...snapshot(), expiresAt: { '42': 1.5 } },
    { ...snapshot(), expiresAt: { '42': 'later' } },
    { ...snapshot(), expiresAt: { '42': NOW + 1, '43': NOW + 1 } },
  ])('refuses invalid snapshots without a write: %j', async (value) => {
    expect(await blocks.setListingBlocks(value)).toEqual({ accepted: false });
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('stores at most 400 unique ids, including an empty list, and only newer timestamps win', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => String(i));
    expect(await blocks.setListingBlocks(snapshot('user_A', 100, ids))).toEqual({ accepted: true });
    expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '399' })).toBe(true);
    expect(await blocks.setListingBlocks(snapshot('user_A', 99, []))).toEqual({ accepted: false });
    expect(await blocks.setListingBlocks(snapshot('user_A', 100, []))).toEqual({ accepted: false });
    expect(await blocks.setListingBlocks(snapshot('user_A', 101, []))).toEqual({ accepted: true });
    expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '399' })).toBe(false);
  });

  it('serializes concurrent pushes and keeps the newest three owners across a worker restart', async () => {
    await Promise.all([
      blocks.setListingBlocks(snapshot('user_A', 100)),
      blocks.setListingBlocks(snapshot('user_B', 200)),
      blocks.setListingBlocks(snapshot('user_C', 300)),
      blocks.setListingBlocks(snapshot('user_A', 400, ['43'])),
      blocks.setListingBlocks(snapshot('user_D', 500)),
      blocks.setListingBlocks(snapshot('user_A', 350, [])),
    ]);
    expect(storage[StorageKeys.listingBlocks]).toEqual([snapshot('user_D', 500), snapshot('user_A', 400, ['43']), snapshot('user_C', 300)]);
    vi.resetModules();
    blocks = await import('../listing-blocks');
    expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: 43 })).toBe(true);
    expect(await blocks.isListingBlocked({ owner: 'user_B', itemId: '42' })).toBe(false);
    expect(await blocks.isListingBlocked({ itemId: '43' })).toBe(false);
    expect(await blocks.isListingBlocked({ owner: 'user_C', itemId: 'original' }, '42')).toBe(true);
  });

  it('validates persisted data and uses the newest snapshot for duplicate owners', async () => {
    storage[StorageKeys.listingBlocks] = [snapshot('user_A', 200, []), snapshot('user_A', 100), snapshot('bad'), { owner: 'user_B' }];
    expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '42' })).toBe(false);
    expect(await blocks.isListingBlocked({ owner: 'user_B', itemId: '42' })).toBe(false);
    storage[StorageKeys.listingBlocks] = 'invalid';
    expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '42' })).toBe(false);
  });
});

it('expires and prunes individual assets after restart with the app tab closed, retaining snapshot ordering', async () => {
  await blocks.setListingBlocks({ ...snapshot('user_A', 100, ['42', '43']), expiresAt: { '42': NOW + 1000, '43': NOW + 2000 } });
  expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '42' })).toBe(true);
  vi.resetModules();
  blocks = await import('../listing-blocks');
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 1000);
  expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '42' })).toBe(false);
  expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: 'other' }, '43')).toBe(true);
  expect(storage[StorageKeys.listingBlocks]).toEqual([{ owner: 'user_A', at: 100, assetIds: ['43'], expiresAt: { '43': NOW + 2000 } }]);
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 2000);
  expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '43' })).toBe(false);
  expect(storage[StorageKeys.listingBlocks]).toEqual([{ owner: 'user_A', at: 100, assetIds: [], expiresAt: {} }]);
  expect(await blocks.setListingBlocks(snapshot('user_A', 99))).toEqual({ accepted: false });
});

it('serializes expiry pruning with a newer push so a read cannot restore the expired snapshot', async () => {
  await blocks.setListingBlocks({ ...snapshot(), expiresAt: { '42': NOW } });
  await Promise.all([blocks.isListingBlocked({ owner: 'user_A', itemId: '42' }), blocks.setListingBlocks(snapshot('user_A', 200, ['43']))]);
  expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '43' })).toBe(true);
});

it('keeps a legacy persisted block bounded until a fresh expiry-aware push replaces it', async () => {
  // Round 2 did not persist notice times. Never release its blocks immediately on an extension update.
  storage[StorageKeys.listingBlocks] = [{ owner: 'user_A', at: NOW, assetIds: ['42'] }];
  expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '42' })).toBe(true);
  expect(storage[StorageKeys.listingBlocks]).toEqual([{ owner: 'user_A', at: NOW, assetIds: ['42'], expiresAt: { '42': NOW + 604800000 } }]);
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 604800000);
  expect(await blocks.isListingBlocked({ owner: 'user_A', itemId: '42' })).toBe(false);
});
