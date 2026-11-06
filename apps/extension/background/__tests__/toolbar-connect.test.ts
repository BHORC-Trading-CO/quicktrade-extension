// 1.6.0: no UI of its own. A connect request waits for the click on the toolbar icon, which is the user gesture the
// browser's permission prompt needs; `permissions.request` must be the click handler's first, synchronous call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ToolbarConnect from '../toolbar-connect';

vi.mock('../../shared/config', () => ({ config: { frontend_root: 'https://app.quicktrade.skin' } }));

const NOW = 1_000_000;
const TTL = 5 * 60 * 1000;

let service: typeof ToolbarConnect;
let session: Record<string, unknown>;
const sessionGet = vi.fn();
const sessionSet = vi.fn();
const sessionRemove = vi.fn();
const request = vi.fn();
const tabsCreate = vi.fn();
const tabsUpdate = vi.fn();
const alarmsCreate = vi.fn();
const alarmsClear = vi.fn();
const setBadgeText = vi.fn();
const setBadgeBackgroundColor = vi.fn();
/** What happened, in order: proves `permissions.request` comes before any storage read in the click. */
let calls: string[];

function stubBrowser(toolbarName: 'action' | 'browserAction', withSession = true) {
  vi.stubGlobal('browser', {
    storage: withSession ? { session: { get: sessionGet, set: sessionSet, remove: sessionRemove } } : {},
    permissions: { request },
    tabs: { create: tabsCreate, update: tabsUpdate },
    alarms: { create: alarmsCreate, clear: alarmsClear },
    [toolbarName]: { setBadgeText, setBadgeBackgroundColor, onClicked: { addListener: vi.fn() } },
  });
}

async function load(toolbarName: 'action' | 'browserAction' = 'action', withSession = true) {
  vi.resetModules();
  stubBrowser(toolbarName, withSession);
  service = await import('../toolbar-connect');
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  session = {};
  calls = [];
  sessionGet.mockImplementation(async (key: string) => {
    calls.push('session.get');
    return key in session ? { [key]: structuredClone(session[key]) } : {};
  });
  sessionSet.mockImplementation(async (values: Record<string, unknown>) => void Object.assign(session, structuredClone(values)));
  sessionRemove.mockImplementation(async (key: string) => void delete session[key]);
  request.mockImplementation(async () => {
    calls.push('permissions.request');
    return true;
  });
  tabsCreate.mockResolvedValue({ id: 9 });
  tabsUpdate.mockResolvedValue({ id: 2 });
  alarmsCreate.mockResolvedValue(undefined);
  alarmsClear.mockResolvedValue(true);
  setBadgeText.mockResolvedValue(undefined);
  setBadgeBackgroundColor.mockResolvedValue(undefined);
  await load();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('keeping a request', () => {
  it('stores validated ids with the asking tab and an expiry, marks the icon and sets the expiry alarm', async () => {
    expect(await service.armToolbarConnect(['tradeit.gg', 'skinport.com'], 2)).toBe('toolbar');
    expect(session['qts:pendingConnect']).toEqual({ platforms: ['tradeit.gg', 'skinport.com'], tabId: 2, expiresAt: NOW + TTL });
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '+' });
    expect(alarmsCreate).toHaveBeenCalledExactlyOnceWith('qts:pendingConnectExpiry', { when: NOW + TTL });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('works on Firefox MV2 (browserAction) and without storage.session', async () => {
    await load('browserAction', false);
    await service.armToolbarConnect(['tradeit.gg'], null);
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '+' });
    service.onToolbarClicked();
    expect(request).toHaveBeenCalledExactlyOnceWith({ origins: ['https://tradeit.gg/*'] });
  });

  it.each([
    ['not an object', 'tradeit.gg'],
    ['unknown ids only', { platforms: ['evil.test', 'https://*/*'], tabId: 1, expiresAt: NOW + 1 }],
    ['no expiry', { platforms: ['tradeit.gg'], tabId: 1 }],
  ])('reads back nothing from a stored value with %s', (_name, value) => {
    expect(service.parsePendingConnect(value)).toBeNull();
  });

  it('drops unknown ids and a bad tab id from a stored value', () => {
    expect(service.parsePendingConnect({ platforms: ['evil.test', 'tradeit.gg'], tabId: -3, expiresAt: NOW })).toEqual({ platforms: ['tradeit.gg'], tabId: null, expiresAt: NOW });
  });
});

describe('the toolbar icon click', () => {
  it('asks the browser first, synchronously, for the bundled origins, then forgets the request', async () => {
    await service.armToolbarConnect(['lis-skins.com', 'tradeit.gg'], 2);
    calls = [];
    service.onToolbarClicked();
    // Called before the handler returned: no await in front of it.
    expect(request).toHaveBeenCalledExactlyOnceWith({ origins: ['https://lis-skins.com/*', 'https://app.lis-skins.com/*', 'https://tradeit.gg/*'] });
    expect(calls[0]).toBe('permissions.request');
    await flush();
    expect(session).toEqual({});
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    expect(alarmsClear).toHaveBeenCalledWith('qts:pendingConnectExpiry');
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('forgets the request when the user declines too', async () => {
    request.mockResolvedValueOnce(false);
    await service.armToolbarConnect(['tradeit.gg'], 2);
    service.onToolbarClicked();
    await flush();
    expect(session).toEqual({});
    service.onToolbarClicked();
    await flush();
    expect(request).toHaveBeenCalledOnce();
    expect(tabsCreate).toHaveBeenCalledExactlyOnceWith({ url: 'https://app.quicktrade.skin/platforms' });
  });

  it('opens the Platforms page without a request', async () => {
    service.onToolbarClicked();
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(tabsCreate).toHaveBeenCalledExactlyOnceWith({ url: 'https://app.quicktrade.skin/platforms' });
  });

  it('does not ask for an expired request: it opens the Platforms page', async () => {
    await service.armToolbarConnect(['tradeit.gg'], 2);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + TTL + 1);
    service.onToolbarClicked();
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(session).toEqual({});
    expect(tabsCreate).toHaveBeenCalledExactlyOnceWith({ url: 'https://app.quicktrade.skin/platforms' });
  });

  it('after a worker restart, reads the stored request and still asks', async () => {
    await service.armToolbarConnect(['tradeit.gg'], 2);
    await load();
    service.onToolbarClicked();
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith({ origins: ['https://tradeit.gg/*'] });
    expect(session).toEqual({});
  });

  it('when the browser refuses to prompt after a restart, keeps the request in memory and returns to the asking tab', async () => {
    await service.armToolbarConnect(['tradeit.gg'], 2);
    await load();
    request.mockRejectedValueOnce(new Error('permissions.request may only be called from a user input handler'));
    service.onToolbarClicked();
    await flush();
    expect(tabsUpdate).toHaveBeenCalledExactlyOnceWith(2, { active: true });
    expect(tabsCreate).not.toHaveBeenCalled();
    // The next click prompts at once from memory.
    calls = [];
    service.onToolbarClicked();
    expect(calls[0]).toBe('permissions.request');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('opens the Platforms page when the asking tab is gone', async () => {
    await service.armToolbarConnect(['tradeit.gg'], 2);
    await load();
    request.mockRejectedValueOnce(new Error('no gesture'));
    tabsUpdate.mockRejectedValueOnce(new Error('No tab with id: 2'));
    service.onToolbarClicked();
    await flush();
    expect(tabsCreate).toHaveBeenCalledExactlyOnceWith({ url: 'https://app.quicktrade.skin/platforms' });
  });
});

describe('worker start and expiry', () => {
  it('restores a live request into memory, so the click prompts without reading storage', async () => {
    await service.armToolbarConnect(['tradeit.gg'], 2);
    await load();
    await service.restorePendingConnect();
    calls = [];
    service.onToolbarClicked();
    expect(calls).toEqual(['permissions.request']);
  });

  it('clears an expired request and the icon mark at start', async () => {
    session['qts:pendingConnect'] = { platforms: ['tradeit.gg'], tabId: 2, expiresAt: NOW - 1 };
    await service.restorePendingConnect();
    expect(session).toEqual({});
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  it('the expiry alarm forgets a request nobody clicked for, and keeps a newer one', async () => {
    await service.armToolbarConnect(['tradeit.gg'], 2);
    await service.expirePendingConnect(NOW + 1);
    expect(session['qts:pendingConnect']).toBeDefined();
    await service.expirePendingConnect(NOW + TTL);
    expect(session).toEqual({});
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });
});
