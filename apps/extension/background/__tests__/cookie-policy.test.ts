import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleSiteMessage } from '../handlers/site';
import { checkLogin } from '../loginStatus';
import { getCookie } from '../proxy';

const cookieGet = vi.fn();
const contains = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  contains.mockResolvedValue(true);
  cookieGet.mockResolvedValue({ value: 'fixture-readable', httpOnly: false });
  vi.stubGlobal('browser', { permissions: { contains }, cookies: { get: cookieGet } });
});
afterEach(() => vi.unstubAllGlobals());

describe('page cookie reads', () => {
  it.each([
    ['https://shadowpay.com', 'XSRF-TOKEN'],
    ['https://buff.market', 'csrf_token'],
    ['https://buff.163.com', 'csrf_token'],
  ])('allows only the non-HttpOnly %s / %s pair', async (url, name) => {
    expect(await getCookie(url, name)).toEqual({ value: 'fixture-readable' });
    expect(cookieGet).toHaveBeenCalledWith({ url, name });
  });

  it.each([
    ['https://steamcommunity.com', 'steamLoginSecure'],
    // Session tokens the background turns into auth headers itself (QUICK-171): never page-readable.
    ['https://aim.market', '__user-store'],
    ['https://white.market', 'access-token'],
    ['https://dmarket.com', 'dm-trade-token'],
    ['https://shadowpay.com', 'session'],
    ['https://shadowpay.com.evil.test', 'XSRF-TOKEN'],
    ['https://sub.shadowpay.com', 'XSRF-TOKEN'],
    ['https://shadowpay.com:444', 'XSRF-TOKEN'],
    ['http://shadowpay.com', 'XSRF-TOKEN'],
    ['https://shadowpay.com@evil.test', 'XSRF-TOKEN'],
    ['blob:https://shadowpay.com/id', 'XSRF-TOKEN'],
    ['bad URL', 'XSRF-TOKEN'],
    ...['cf_clearance', 'prodToken', 'sessionId', 'device_id'].map((name) => ['https://www.haloskins.com', name]),
  ])('refuses %s / %s before reading cookies', async (url, name) => {
    expect(await getCookie(url, name)).toEqual({ value: null, error: 'cookie_not_allowed' });
    expect(cookieGet).not.toHaveBeenCalled();
    expect(contains).not.toHaveBeenCalled();
  });

  it('does not accept a partition key from the page', async () => {
    expect(await getCookie('https://shadowpay.com', 'XSRF-TOKEN', { topLevelSite: 'https://shadowpay.com' })).toEqual({ value: null, error: 'cookie_partition_not_allowed' });
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it.each([true, undefined])('refuses an allowlisted cookie unless httpOnly is explicitly false (%s)', async (httpOnly) => {
    cookieGet.mockResolvedValue({ value: 'fixture-private', httpOnly });
    const result = await handleSiteMessage({ type: 'site:get_cookie', data: { requestId: 'cookie-1', url: 'https://shadowpay.com', name: 'XSRF-TOKEN' } });
    expect(result).toEqual({ ok: true, data: { requestId: 'cookie-1', value: null, error: 'cookie_http_only' } });
    expect(JSON.stringify(result)).not.toContain('fixture-private');
  });

  it('keeps requestId and null for the old web on a non-allowlisted refusal', async () => {
    expect(await handleSiteMessage({ type: 'site:get_cookie', data: { requestId: 'steam-1', url: 'https://steamcommunity.com', name: 'steamLoginSecure' } })).toEqual({
      ok: true,
      data: { requestId: 'steam-1', value: null, error: 'cookie_not_allowed' },
    });
  });

  it('refuses when host permission is missing', async () => {
    contains.mockResolvedValue(false);
    expect(await getCookie('https://shadowpay.com', 'XSRF-TOKEN')).toEqual({ value: null, error: 'cookie_permission_denied' });
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('returns null for a missing cookie', async () => {
    cookieGet.mockResolvedValue(null);
    expect(await getCookie('https://shadowpay.com', 'XSRF-TOKEN')).toEqual({ value: null });
  });

  it.each(['permissions', 'cookies'])('sanitizes %s API failures and still resolves the request', async (api) => {
    (api === 'permissions' ? contains : cookieGet).mockRejectedValue(new Error('fixture-private-error'));
    expect(await handleSiteMessage({ type: 'site:get_cookie', data: { requestId: 'failed-1', url: 'https://shadowpay.com', name: 'XSRF-TOKEN' } })).toEqual({
      ok: true,
      data: { requestId: 'failed-1', value: null, error: 'cookie_read_failed' },
    });
  });

  it('login checks expose status only even for HttpOnly Steam cookies', async () => {
    cookieGet.mockResolvedValue({ value: 'fixture-private', httpOnly: true });
    expect(
      await checkLogin({
        id: 'steamcommunity.com',
        label: 'Steam',
        origins: ['https://steamcommunity.com/*'],
        loginCheck: { kind: 'cookie', url: 'https://steamcommunity.com', name: 'steamLoginSecure' },
      })
    ).toBe('logged-in');
    expect(await handleSiteMessage({ type: 'site:get_user_data_from_platforms' })).toEqual({ ok: false, error: 'unhandled site message: site:get_user_data_from_platforms' });
  });
});
