// QUICK-305: the account's working browser in the extension — the page's claim answer through the real message entry
// point, the extension's own renew with its device token, and the scheduler's gate. Only the browser APIs and the QTS
// server's answers are faked.
import { ACTIVE_BROWSER_LEASE_TTL_MS, ACTIVE_BROWSER_RENEW_MS, ACTIVE_BROWSER_STANDBY_MS, type ActiveBrowserPush } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeSender } from '../../shared/bridge-policy';
import type * as ActiveBrowser from '../active-browser';
import { isWorking, stateAfterPush } from '../active-browser-model';
import { chromeStored } from './chrome-storage';

vi.mock('../../shared/config', () => ({ BRIDGE_MODE: 'production', default: { api_url: 'https://app.quicktrade.skin/api' } }));

const NOW = 1_800_000_000_000;
const DEVICE = '00000000-0000-4000-8000-0000000000aa';
const TOKEN = 'T'.repeat(43);
const PAGE: BridgeSender = { id: 'qts', tab: { id: 2 }, frameId: 0, origin: 'https://app.quicktrade.skin', url: 'https://app.quicktrade.skin/sell-mode' };

let storage: Record<string, unknown>;
let now: number;
let fetchMock: ReturnType<typeof vi.fn>;
let active: typeof ActiveBrowser;

function push(patch: Partial<ActiveBrowserPush> = {}): ActiveBrowserPush {
  return {
    clerkId: 'user_A',
    holds: true,
    leaseId: 'lease-0001',
    expiresAt: NOW + ACTIVE_BROWSER_LEASE_TTL_MS,
    serverNow: NOW,
    token: TOKEN,
    requestedAt: NOW - 100,
    receivedAt: NOW,
    ...patch,
  };
}

/** An account-wide rule (a market sync one-shot): only the working browser runs it. */
const SHARED = { origin: 'auto_sync', owner: 'user_A', platform: 'cs.money' } as const;

async function works(): Promise<boolean> {
  return (await active.activeBrowserGate())(SHARED);
}

function answer(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(async () => {
  vi.resetModules();
  now = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  storage = { 'qts:buy_orders_device': DEVICE };
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('browser', {
    runtime: { id: 'qts', getURL: () => 'chrome-extension://qts/' },
    storage: {
      local: {
        get: vi.fn(async (key: string) => chromeStored({ [key]: storage[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storage, chromeStored(values));
        }),
        remove: vi.fn(async (key: string) => {
          delete storage[key];
        }),
      },
    },
  });
  active = await import('../active-browser');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the working browser in the extension', () => {
  it('runs its rules as before until a page tells it about the lease, and sends nothing to ask', async () => {
    expect(await works()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await active.activeBrowserView('r1')).toEqual({ requestId: 'r1', deviceId: DEVICE, clerkId: null, holds: false, working: true, expiresAt: null, hasToken: false });
  });

  it('takes the claim answer only from the web app’s own origin', async () => {
    const { onRuntimeMessage } = await import('../runtime-router');
    const reply = vi.fn();
    const message = { type: 'site:set_active_browser', data: push() };
    expect(onRuntimeMessage(message, { ...PAGE, origin: 'https://quicktrade.skin', url: 'https://quicktrade.skin/' }, reply)).toBe(false);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(storage['qts:active_browser']).toBeUndefined();

    reply.mockClear();
    expect(onRuntimeMessage(message, PAGE, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining({ clerkId: 'user_A', holds: true, working: true, hasToken: true }) }));
  });

  it('works while it holds a live lease, waits while another browser does, and starts the scheduler when it gets the lease', async () => {
    const started = vi.fn();
    active.onActiveBrowserWorking(started);

    await active.acceptActiveBrowserPush(push({ holds: false, leaseId: null, expiresAt: null }));
    expect(await works()).toBe(false);
    expect(started).not.toHaveBeenCalled();

    await active.acceptActiveBrowserPush(push({ requestedAt: NOW + 1, receivedAt: NOW + 2 }));
    expect(started).toHaveBeenCalledOnce();
    expect(await works()).toBe(true);
  });

  it('renews with its token at most once a minute while it works, and stops when another browser took the lease', async () => {
    await active.acceptActiveBrowserPush(push());
    now += ACTIVE_BROWSER_RENEW_MS - 1;
    expect(await works()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    now += 1;
    fetchMock.mockResolvedValueOnce(answer(200, { serverNow: now, holds: false, leaseId: null, expiresAt: null }));
    expect(await works()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.quicktrade.skin/api/active-browser/renew',
      expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify({ deviceId: DEVICE, token: TOKEN }) })
    );
  });

  it('keeps working while the server cannot be reached (nobody else can get the lease then), and stops on its answer', async () => {
    await active.acceptActiveBrowserPush(push());
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    now = NOW + ACTIVE_BROWSER_LEASE_TTL_MS + 60_000;
    expect(await works()).toBe(true);
    fetchMock.mockResolvedValue(answer(503, { message: 'active_browser_unavailable' }));
    now += ACTIVE_BROWSER_RENEW_MS;
    expect(await works()).toBe(true);
    fetchMock.mockResolvedValue(answer(200, { serverNow: now, holds: false, leaseId: null, expiresAt: null }));
    now += ACTIVE_BROWSER_RENEW_MS;
    expect(await works()).toBe(false);
  });

  it('runs as before once the server has no lease route (rolled back): the stored lease is dropped', async () => {
    await active.acceptActiveBrowserPush(push({ holds: false, leaseId: null, expiresAt: null }));
    now += ACTIVE_BROWSER_RENEW_MS;
    fetchMock.mockResolvedValueOnce(answer(404, { message: 'Cannot POST' }));
    expect(await works()).toBe(true);
    expect(storage['qts:active_browser']).toBeUndefined();
  });

  it('runs this browser’s own rules whoever works, and only its account’s account-wide rules while it works', async () => {
    await active.acceptActiveBrowserPush(push({ holds: false, leaseId: null, expiresAt: null }));
    const waiting = await active.activeBrowserGate();
    expect(waiting({ kind: 'list', owner: 'user_A', platform: 'cs.money' })).toBe(true);
    expect(waiting({ owner: 'user_A', platform: 'waxpeer.com' })).toBe(true);
    expect(waiting({ platform: 'csfloat.com' })).toBe(true);
    expect(waiting({ owner: 'user_A', platform: 'csfloat.com' })).toBe(false);
    expect(waiting(SHARED)).toBe(false);

    await active.acceptActiveBrowserPush(push({ requestedAt: NOW + 1, receivedAt: NOW + 2 }));
    const working = await active.activeBrowserGate();
    expect(working(SHARED)).toBe(true);
    expect(working({ ...SHARED, owner: 'user_B' })).toBe(false);
  });

  it('ignores the lease part of an answer older than the newest it has', async () => {
    await active.acceptActiveBrowserPush(push({ requestedAt: NOW + 10, receivedAt: NOW + 20 }));
    await active.acceptActiveBrowserPush(push({ holds: false, leaseId: null, expiresAt: null, requestedAt: NOW, receivedAt: NOW + 30 }));
    expect(await works()).toBe(true);
  });

  it('on standby, takes the lease once the holder’s ran out (the other browser was closed)', async () => {
    const started = vi.fn();
    active.onActiveBrowserWorking(started);
    await active.acceptActiveBrowserPush(push({ holds: false, leaseId: null, expiresAt: null }));

    now += ACTIVE_BROWSER_STANDBY_MS - 1;
    await active.tickActiveBrowser();
    expect(fetchMock).not.toHaveBeenCalled();

    now += 1;
    fetchMock.mockResolvedValueOnce(answer(200, { serverNow: now, holds: true, leaseId: 'lease-0002', expiresAt: now + ACTIVE_BROWSER_LEASE_TTL_MS }));
    await active.tickActiveBrowser();
    expect(started).toHaveBeenCalledOnce();
    expect(await works()).toBe(true);
  });

  it('drops a token the server no longer knows and asks no more until a page hands a new one', async () => {
    await active.acceptActiveBrowserPush(push());
    now += ACTIVE_BROWSER_STANDBY_MS;
    fetchMock.mockResolvedValueOnce(answer(401, { message: 'active_browser_token' }));
    await active.tickActiveBrowser();
    expect((await active.activeBrowserView()).hasToken).toBe(false);

    now += ACTIVE_BROWSER_STANDBY_MS;
    await active.tickActiveBrowser();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps its token across claim answers of the same account, never across accounts', async () => {
    await active.acceptActiveBrowserPush(push());
    await active.acceptActiveBrowserPush(push({ token: undefined }));
    expect((await active.activeBrowserView()).hasToken).toBe(true);
    await active.acceptActiveBrowserPush(push({ clerkId: 'user_B', token: undefined }));
    expect(await active.activeBrowserView()).toMatchObject({ clerkId: 'user_B', hasToken: false });
  });
});

describe('the lease on the server’s clock', () => {
  it('reads the lease against the server’s clock, not this computer’s', () => {
    // This computer runs 10 minutes behind the server: the lease ends 10 minutes earlier on its own clock.
    const state = stateAfterPush(null, push({ serverNow: NOW + 600_000, expiresAt: NOW + 600_000 + ACTIVE_BROWSER_LEASE_TTL_MS }));
    expect(isWorking(state, NOW + ACTIVE_BROWSER_LEASE_TTL_MS - 1_000)).toBe(true);
    expect(isWorking(state, NOW + ACTIVE_BROWSER_LEASE_TTL_MS + 1_000)).toBe(false);
  });
});
