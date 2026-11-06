import type { DnrRule } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHaloSkinsRule, HALOSKINS_PRIME_MAX_AGE_MS, primeHaloSkins } from '../haloskins-service';
import { handleSiteMessage } from '../handlers/site';

const contains = vi.fn();
const cookieGet = vi.fn();
const updateDynamicRules = vi.fn();
const getDynamicRules = vi.fn();
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  contains.mockResolvedValue(true);
  cookieGet.mockImplementation(async ({ name }: { name: string }) => ({ value: `fixture-${name}`, httpOnly: true }));
  updateDynamicRules.mockResolvedValue(undefined);
  getDynamicRules.mockResolvedValue([buildHaloSkinsRule('fixture-private', 'fixture-ua', 'qts')]);
  fetchMock.mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { userAgent: 'fixture-background-ua' });
  vi.stubGlobal('browser', {
    permissions: { contains },
    cookies: { get: cookieGet },
    runtime: { getURL: () => 'moz-extension://qts/' },
    storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    declarativeNetRequest: { updateDynamicRules, getDynamicRules },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Module state (last prime time) is shared across tests, so each on-demand test starts a day later. */
let clock = Date.now();
function advanceClock(ms: number) {
  clock += ms;
  vi.spyOn(Date, 'now').mockReturnValue(clock);
}

/** The product search the web client sends (an allowlisted operation, QUICK-171). */
function proxy(url: string) {
  return handleSiteMessage({
    type: 'site:proxy_request',
    data: { requestId: url, platform: 'haloskins.com', request: { url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"keyword":"fixture"}' } },
  });
}

const HALO_SEARCH = 'https://www.haloskins.com/api/steam-trade-center/search/product/list?appId=730';

describe('background-owned HaloSkins priming', () => {
  it('reads fixed cookies/partition and installs only the fixed background rule', async () => {
    expect(await primeHaloSkins()).toBeUndefined();
    expect(contains).toHaveBeenCalledWith({ origins: ['https://www.haloskins.com/*'] });
    expect(cookieGet.mock.calls.map(([details]) => details)).toEqual([
      { url: 'https://www.haloskins.com', name: 'cf_clearance', partitionKey: { topLevelSite: 'https://haloskins.com' } },
      ...['prodToken', 'sessionId', 'device_id'].map((name) => ({ url: 'https://www.haloskins.com', name })),
    ]);
    expect(updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [1014],
      addRules: [
        {
          id: 1014,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://www.haloskins.com' },
              { header: 'Referer', operation: 'set', value: 'https://www.haloskins.com/' },
              { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
              { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
              { header: 'Cookie', operation: 'set', value: 'cf_clearance=fixture-cf_clearance; prodToken=fixture-prodToken; sessionId=fixture-sessionId; device_id=fixture-device_id' },
              { header: 'User-Agent', operation: 'set', value: 'fixture-background-ua' },
            ],
          },
          condition: {
            urlFilter: '|https://www.haloskins.com/api/',
            requestDomains: ['www.haloskins.com'],
            resourceTypes: ['xmlhttprequest', 'other'],
            excludedInitiatorDomains: ['haloskins.com'],
            initiatorDomains: ['qts'],
          },
        },
      ],
    });
  });

  it.each(['permission', 'clearance'])('removes the old rule when %s is absent', async (missing) => {
    if (missing === 'permission') contains.mockResolvedValue(false);
    else cookieGet.mockResolvedValue(null);
    await primeHaloSkins();
    expect(updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [1014], addRules: [] });
    if (missing === 'permission') expect(cookieGet).not.toHaveBeenCalled();
  });

  it('does not restore a stale rule if a permission revoke overlaps an earlier refresh', async () => {
    let finishRead: ((value: { value: string }) => void) | undefined;
    cookieGet.mockImplementationOnce(
      () =>
        new Promise<{ value: string }>((resolve) => {
          finishRead = resolve;
        })
    );
    const first = primeHaloSkins();
    await vi.waitFor(() => expect(finishRead).toBeDefined());
    contains.mockResolvedValue(false);
    const revoked = primeHaloSkins();
    finishRead?.({ value: 'fixture-old' });
    await Promise.all([first, revoked]);
    expect(updateDynamicRules).toHaveBeenLastCalledWith({ removeRuleIds: [1014], addRules: [] });
  });

  it('ignores page attempts to overwrite 1014, including a cookie-less legacy base rule', async () => {
    await primeHaloSkins();
    updateDynamicRules.mockClear();
    const base: DnrRule = { id: 1014, action: { type: 'modifyHeaders', requestHeaders: [] }, condition: { urlFilter: 'https://foreign.test/*' } };
    expect(await handleSiteMessage({ type: 'site:set_dnr_rules', data: { rules: [base] } })).toMatchObject({
      ok: true,
      data: { status: 'rejected', rejected: [{ id: 1014, reason: 'id_out_of_range' }] },
    });
    expect(updateDynamicRules).not.toHaveBeenCalled();
    const unrelated: DnrRule = {
      id: 2001,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] },
      condition: { urlFilter: '|https://cs.money/', resourceTypes: ['xmlhttprequest'] },
    };
    const reply = await handleSiteMessage({ type: 'site:set_dnr_rules', data: { rules: [base, unrelated] } });
    // Installed as sent, for the extension's own requests only (QUICK-291), plus the T5 exclusion of the marketplace's own tab (QUICK-172).
    const installed = { ...unrelated, condition: { ...unrelated.condition, initiatorDomains: ['qts'], excludedInitiatorDomains: ['cs.money'] } };
    expect(updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [2001], addRules: [installed] });
    expect(reply).toEqual({ ok: true, data: { status: 'partial', installedIds: [2001], rejected: [{ id: 1014, reason: 'id_out_of_range' }] } });
    expect(JSON.stringify(reply)).not.toContain('fixture-private');
  });

  it('makes the old web primer a no-op by resolving cf_clearance to null', async () => {
    const reply = await handleSiteMessage({ type: 'site:get_cookie', data: { requestId: 'legacy-prime', url: 'https://www.haloskins.com', name: 'cf_clearance' } });
    expect(reply).toEqual({ ok: true, data: { requestId: 'legacy-prime', value: null, error: 'cookie_not_allowed' } });
    expect(cookieGet).not.toHaveBeenCalled();
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });

  it('does not prime on permission announcements (the web probes every 2 s)', async () => {
    expect(await handleSiteMessage({ type: 'site:get_permissions' })).toEqual({ ok: true, data: {} });
    expect(cookieGet).not.toHaveBeenCalled();
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });

  it.each(['permissions', 'cookies', 'dnr'])('cleans up after %s errors without logging or returning secret values', async (api) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failingApi = api === 'permissions' ? contains : api === 'cookies' ? cookieGet : updateDynamicRules;
    failingApi.mockRejectedValueOnce(new Error('fixture-private-cookie'));
    expect(await primeHaloSkins()).toBeUndefined();
    expect(updateDynamicRules).toHaveBeenLastCalledWith({ removeRuleIds: [1014] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-private-cookie');
    warn.mockRestore();
  });
});

describe('on-demand HaloSkins priming (no polling alarm)', () => {
  it('refreshes rule 1014 before a HaloSkins request when it is stale, at most once per window', async () => {
    advanceClock(24 * 60 * 60 * 1000);
    expect(await proxy(HALO_SEARCH)).toMatchObject({ ok: true, data: { requestId: HALO_SEARCH, ok: true, status: 200 } });
    expect(updateDynamicRules).toHaveBeenCalledOnce();
    expect(updateDynamicRules.mock.calls[0][0].addRules).toHaveLength(1);
    expect(updateDynamicRules.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);

    advanceClock(HALOSKINS_PRIME_MAX_AGE_MS - 1);
    await proxy(HALO_SEARCH);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updateDynamicRules).toHaveBeenCalledOnce();

    advanceClock(1);
    await proxy(HALO_SEARCH);
    expect(updateDynamicRules).toHaveBeenCalledTimes(2);
    expect(updateDynamicRules.mock.invocationCallOrder[1]).toBeLessThan(fetchMock.mock.invocationCallOrder[2]);
  });

  it('waits for a refresh already in flight instead of sending with stale cookies', async () => {
    advanceClock(24 * 60 * 60 * 1000);
    let finishRead: ((value: { value: string }) => void) | undefined;
    cookieGet.mockImplementationOnce(
      () =>
        new Promise<{ value: string }>((resolve) => {
          finishRead = resolve;
        })
    );
    const startup = primeHaloSkins();
    const request = proxy(HALO_SEARCH);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    finishRead?.({ value: 'fixture-fresh' });
    await Promise.all([startup, request]);
    expect(updateDynamicRules).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(updateDynamicRules.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it.each(['https://csfloat.com/api/v1/listings', 'https://haloskins.com/api/x', 'https://www.haloskins.com.evil.test/api/x', 'http://www.haloskins.com/api/x', 'not a url'])(
    'does not prime for %s',
    async (url) => {
      advanceClock(24 * 60 * 60 * 1000);
      await proxy(url);
      expect(updateDynamicRules).not.toHaveBeenCalled();
      expect(cookieGet).not.toHaveBeenCalled();
    }
  );
});
