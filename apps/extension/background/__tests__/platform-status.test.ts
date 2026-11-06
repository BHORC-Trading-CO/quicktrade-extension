// QUICK-202: the status service behind `get_platform_statuses`. Only browser APIs and fetch are faked.
import type { PlatformCatalogEntry } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DnrService from '../dnr-service';
import type * as StatusService from '../platform-status';
import { chromeStored } from './chrome-storage';

const NOW = 1_800_000_000_000;
const CATALOG: PlatformCatalogEntry[] = [
  { id: 'cs.money', label: 'CS.Money', origins: ['https://cs.money/*'], defaultGranted: true, loginCheck: { kind: 'cookie', url: 'https://cs.money', name: 'steamid' } },
  {
    id: 'csfloat.com',
    label: 'CSFloat',
    origins: ['https://csfloat.com/*'],
    defaultGranted: true,
    loginCheck: { kind: 'request', url: 'https://csfloat.com/api/v1/me', okStatus: [200], loggedOutStatus: [401], truthyPath: 'user.steam_id' },
  },
  {
    id: 'lis-skins.com',
    label: 'LIS-Skins',
    origins: ['https://lis-skins.com/*', 'https://app.lis-skins.com/*'],
    loginCheck: { kind: 'request', url: 'https://app.lis-skins.com/api/v2/push-notifications', okStatus: [200], loggedOutStatus: [401] },
  },
  { id: 'haloskins.com', label: 'HaloSkins', origins: ['https://www.haloskins.com/*', 'https://haloskins.com/*'] },
];
const DNR_RULE = {
  id: 2001,
  priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] },
  condition: { urlFilter: '|https://csfloat.com/', resourceTypes: ['xmlhttprequest', 'other'] },
};
const ALLOWED_KEYS = new Set(['platform', 'permission', 'login', 'evidence', 'issue', 'httpStatus', 'retryAt', 'checkedAt']);

let service: typeof StatusService;
let dnr: typeof DnrService;
let now: number;
let granted: Set<string>;
const contains = vi.fn();
const cookieGet = vi.fn();
const updateDynamicRules = vi.fn();
const fetchMock = vi.fn();

function csfloatAnswer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  now = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  granted = new Set(['https://cs.money/*', 'https://csfloat.com/*', 'https://steamcommunity.com/*']);
  contains.mockImplementation(async ({ origins }: { origins: string[] }) => origins.every((origin) => granted.has(origin)));
  cookieGet.mockResolvedValue({ value: 'fixture-cookie-value', httpOnly: false });
  updateDynamicRules.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async () => csfloatAnswer(200, { user: { steam_id: '76561198000000001', balance: 4200 } }));
  vi.stubGlobal('fetch', fetchMock);
  const storage = { qts_platform_catalog: CATALOG };
  vi.stubGlobal('browser', {
    runtime: { getURL: () => 'chrome-extension://qts/' },
    storage: { local: { get: vi.fn(async () => chromeStored(storage)) } },
    permissions: { contains },
    cookies: { get: cookieGet },
    declarativeNetRequest: { updateDynamicRules },
  });
  service = await import('../platform-status');
  dnr = await import('../dnr-service');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('platform statuses', () => {
  it('answers one status-only row per platform, with no cookie value, body or account id', async () => {
    const statuses = await service.getPlatformStatuses(['cs.money', 'csfloat.com']);
    expect(statuses).toEqual([
      { platform: 'cs.money', permission: 'granted', login: 'logged-in', evidence: 'cookie', checkedAt: NOW },
      { platform: 'csfloat.com', permission: 'granted', login: 'logged-in', evidence: 'request', checkedAt: NOW },
    ]);
    const json = JSON.stringify(statuses);
    for (const secret of ['fixture-cookie-value', '76561198000000001', '4200', 'steamid']) expect(json).not.toContain(secret);
    for (const status of statuses) expect(Object.keys(status).every((key) => ALLOWED_KEYS.has(key))).toBe(true);
  });

  it('checks nothing on a platform with missing or partial access', async () => {
    granted.add('https://app.lis-skins.com/*');
    const statuses = await service.getPlatformStatuses(['lis-skins.com', 'tradeit.gg']);
    expect(statuses).toEqual([
      { platform: 'lis-skins.com', permission: 'partial', login: 'unknown', issue: 'not_granted', checkedAt: NOW },
      { platform: 'tradeit.gg', permission: 'missing', login: 'unknown', issue: 'not_granted', checkedAt: NOW },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks the bundled origins, not the ones the page published', async () => {
    const storage = { qts_platform_catalog: [{ ...CATALOG[0], origins: ['https://evil.test/*'] }] };
    vi.stubGlobal('browser', { ...browser, storage: { local: { get: vi.fn(async () => chromeStored(storage)) } } });
    await service.getPlatformStatuses(['cs.money']);
    expect(contains.mock.calls.flatMap(([arg]) => arg.origins)).not.toContain('https://evil.test/*');
    expect(contains).toHaveBeenCalledWith({ origins: ['https://cs.money/*'] });
  });

  it('reports a granted platform without a published or bundled check as no_check', async () => {
    granted.add('https://www.haloskins.com/*').add('https://haloskins.com/*');
    granted.add('https://tradeit.gg/*');
    expect(await service.getPlatformStatuses(['haloskins.com', 'tradeit.gg'])).toEqual([
      { platform: 'haloskins.com', permission: 'granted', login: 'unknown', issue: 'no_check', checkedAt: NOW },
      { platform: 'tradeit.gg', permission: 'granted', login: 'unknown', issue: 'no_check', checkedAt: NOW },
    ]);
  });

  it('never reads a server error as logged out', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await service.getPlatformStatuses(['csfloat.com'])).toEqual([{ platform: 'csfloat.com', permission: 'granted', login: 'unknown', issue: 'server_error', httpStatus: 502, checkedAt: NOW }]);
  });

  it('waits for a DNR install that reached the background first before probing', async () => {
    const pending = Promise.withResolvers<void>();
    updateDynamicRules.mockImplementation(() => pending.promise);
    const install = dnr.installPageDnrRules({ rules: [DNR_RULE] });
    const statuses = service.getPlatformStatuses(['csfloat.com']);
    await vi.waitFor(() => expect(updateDynamicRules).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    pending.resolve();
    await install;
    expect(await statuses).toMatchObject([{ platform: 'csfloat.com', login: 'logged-in' }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('checks again a cached answer made before header rules for that platform were installed (QUICK-202 r1)', async () => {
    fetchMock.mockImplementation(async () => new Response('Forbidden', { status: 403 }));
    expect(await service.getPlatformStatuses(['csfloat.com'])).toMatchObject([{ platform: 'csfloat.com', login: 'unknown', issue: 'blocked' }]);
    now += 1_000;
    await dnr.installPageDnrRules({ rules: [DNR_RULE] });
    fetchMock.mockImplementation(async () => csfloatAnswer(200, { user: { steam_id: '76561198000000001' } }));
    expect(await service.getPlatformStatuses(['csfloat.com'])).toMatchObject([{ platform: 'csfloat.com', login: 'logged-in' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a cached answer when only another platform got header rules', async () => {
    await service.getPlatformStatuses(['csfloat.com']);
    now += 1_000;
    await dnr.installPageDnrRules({ rules: [{ ...DNR_RULE, id: 2002, condition: { ...DNR_RULE.condition, urlFilter: '|https://cs.money/' } }] });
    await service.getPlatformStatuses(['csfloat.com']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('serves a recent answer from its cache and a forced refresh only after the cooldown', async () => {
    await service.getPlatformStatuses(['csfloat.com']);
    now += 2_000;
    await service.getPlatformStatuses(['csfloat.com']);
    await service.getPlatformStatuses(['csfloat.com'], { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += service.STATUS_FORCE_COOLDOWN_MS;
    await service.getPlatformStatuses(['csfloat.com'], { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += service.STATUS_CACHE_MS;
    await service.getPlatformStatuses(['csfloat.com']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('runs one check per platform for concurrent requests (several tabs)', async () => {
    const [first, second] = await Promise.all([service.getPlatformStatuses(['csfloat.com'], { force: true }), service.getPlatformStatuses(['csfloat.com'], { force: true })]);
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not probe a rate-limited platform again before its retry time, even when forced', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    expect(await service.getPlatformStatuses(['csfloat.com'])).toEqual([
      { platform: 'csfloat.com', permission: 'granted', login: 'unknown', issue: 'rate_limited', httpStatus: 429, retryAt: NOW + 120_000, checkedAt: NOW },
    ]);
    now += 60_000;
    await service.getPlatformStatuses(['csfloat.com'], { force: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    now += 61_000;
    await service.getPlatformStatuses(['csfloat.com'], { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-checks a cached platform whose access changed since', async () => {
    await service.getPlatformStatuses(['csfloat.com']);
    granted.delete('https://csfloat.com/*');
    expect(await service.getPlatformStatuses(['csfloat.com'])).toEqual([{ platform: 'csfloat.com', permission: 'missing', login: 'unknown', issue: 'not_granted', checkedAt: NOW }]);
  });

  it('drops the answer of a check whose access was revoked while it ran', async () => {
    fetchMock.mockImplementation(async () => {
      granted.delete('https://csfloat.com/*');
      return csfloatAnswer(200, { user: { steam_id: '76561198000000001' } });
    });
    expect(await service.getPlatformStatuses(['csfloat.com'])).toEqual([{ platform: 'csfloat.com', permission: 'missing', login: 'unknown', issue: 'not_granted', checkedAt: NOW }]);
  });

  it('waits again for a probe that timed out instead of sending a second request (QUICK-202 r1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockImplementation(() => pending.promise);
    const first = service.getPlatformStatuses(['csfloat.com']);
    await vi.advanceTimersByTimeAsync(service.STATUS_CHECK_TIMEOUT_MS);
    expect(await first).toMatchObject([{ platform: 'csfloat.com', login: 'unknown', issue: 'timeout' }]);

    now += service.STATUS_FORCE_COOLDOWN_MS;
    const retry = service.getPlatformStatuses(['csfloat.com'], { force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    pending.resolve(csfloatAnswer(200, { user: { steam_id: '76561198000000001' } }));
    expect(await retry).toMatchObject([{ platform: 'csfloat.com', login: 'logged-in' }]);

    // Once it settled, a later retry sends a new request.
    fetchMock.mockImplementation(async () => csfloatAnswer(200, { user: { steam_id: '76561198000000001' } }));
    now += service.STATUS_FORCE_COOLDOWN_MS;
    await service.getPlatformStatuses(['csfloat.com'], { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a check that does not answer in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const statuses = service.getPlatformStatuses(['csfloat.com']);
    await vi.advanceTimersByTimeAsync(service.STATUS_CHECK_TIMEOUT_MS);
    expect(await statuses).toEqual([{ platform: 'csfloat.com', permission: 'granted', login: 'unknown', issue: 'timeout', checkedAt: NOW }]);
  });
});
