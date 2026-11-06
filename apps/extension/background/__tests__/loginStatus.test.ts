import type { LoginCheck } from '@qts/contracts';
import type { PlatformCatalogEntry } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkAllLogins, classifyRequestResult, getJsonPath, observeLogin } from '../loginStatus';

function requestCheck(extra: Partial<Extract<LoginCheck, { kind: 'request' }>> = {}): Extract<LoginCheck, { kind: 'request' }> {
  return { kind: 'request', url: 'https://x/api/me', ...extra };
}

const NOW = 1_800_000_000_000;

function answer(status: number, data: unknown = null, extra: { headers?: Record<string, string>; error?: string } = {}) {
  return { status, data, ...extra };
}

describe('getJsonPath', () => {
  it('reads a nested value by dot-path', () => {
    expect(getJsonPath({ user: { steam_id: '123' } }, 'user.steam_id')).toBe('123');
  });

  it('returns undefined when a segment is missing', () => {
    expect(getJsonPath({ user: {} }, 'user.steam_id')).toBeUndefined();
  });

  it('returns undefined for a non-object root', () => {
    expect(getJsonPath(null, 'user.steam_id')).toBeUndefined();
  });
});

describe('classifyRequestResult', () => {
  it('returns logged-in for a 200 with no truthyPath', () => {
    expect(classifyRequestResult(requestCheck(), answer(200), NOW)).toEqual({ login: 'logged-in', evidence: 'request' });
  });

  it('returns logged-in when truthyPath is present and truthy', () => {
    expect(classifyRequestResult(requestCheck({ truthyPath: 'user.steam_id' }), answer(200, { user: { steam_id: '123' } }), NOW)).toEqual({ login: 'logged-in', evidence: 'request' });
  });

  it('reads a JSON body the proxy handed back as text (wrong content-type)', () => {
    expect(classifyRequestResult(requestCheck({ truthyPath: 'username' }), answer(200, '{"username":"x"}'), NOW)).toEqual({ login: 'logged-in', evidence: 'request' });
  });

  it('returns logged-out when the truthyPath holds an explicit empty value (a recognised signed-out answer)', () => {
    for (const body of [{ user: { steam_id: null } }, { user: { steam_id: '' } }, { user: null }, { user: false }]) {
      expect(classifyRequestResult(requestCheck({ truthyPath: 'user.steam_id' }), answer(200, body), NOW)).toEqual({ login: 'logged-out', evidence: 'request' });
    }
  });

  it('never reads a body that lacks the truthyPath as a logout: the shape is unrecognised (QUICK-202 r1)', () => {
    for (const body of [{}, { user: {} }, { error: 'Internal error' }, { user: 'x' }, { message: 'Service unavailable' }]) {
      expect(classifyRequestResult(requestCheck({ truthyPath: 'user.steam_id' }), answer(200, body), NOW)).toEqual({ login: 'unknown', issue: 'unexpected', httpStatus: 200 });
    }
  });

  it('reads a documented signed-out body (loggedOutMatch) as logged-out, and nothing else that lacks the path', () => {
    const check = requestCheck({ truthyPath: 'user', loggedOutMatch: { path: 'success', equals: false } });
    expect(classifyRequestResult(check, answer(200, { success: false }), NOW)).toEqual({ login: 'logged-out', evidence: 'request' });
    expect(classifyRequestResult(check, answer(200, { success: true }), NOW)).toEqual({ login: 'unknown', issue: 'unexpected', httpStatus: 200 });
    expect(classifyRequestResult(check, answer(200, { success: false, user: { id: 1 } }), NOW)).toEqual({ login: 'logged-in', evidence: 'request' });
  });

  it('returns logged-out for an explicit loggedOutStatus', () => {
    expect(classifyRequestResult(requestCheck({ loggedOutStatus: [401] }), answer(401), NOW)).toEqual({ login: 'logged-out', evidence: 'request' });
  });

  it('returns logged-out for HTTP 401 even when the descriptor does not list it (an authentication rejection)', () => {
    expect(classifyRequestResult(requestCheck(), answer(401), NOW)).toEqual({ login: 'logged-out', evidence: 'request' });
  });

  it('honors a custom okStatus set', () => {
    expect(classifyRequestResult(requestCheck({ okStatus: [204] }), answer(204), NOW)).toEqual({ login: 'logged-in', evidence: 'request' });
  });

  it('returns logged-out when a status is in both loggedOutStatus and okStatus', () => {
    expect(classifyRequestResult(requestCheck({ okStatus: [200], loggedOutStatus: [200] }), answer(200), NOW).login).toBe('logged-out');
  });

  it.each([500, 502, 503, 520])('never reads HTTP %i as logged out: the platform failed, the login is unknown', (status) => {
    expect(classifyRequestResult(requestCheck({ truthyPath: 'user' }), answer(status, '<html>error</html>'), NOW)).toEqual({ login: 'unknown', issue: 'server_error', httpStatus: status });
  });

  it('reads a generic 403 as blocked with an unknown login, not as logged out', () => {
    expect(classifyRequestResult(requestCheck({ truthyPath: 'user' }), answer(403, 'Forbidden'), NOW)).toEqual({ login: 'unknown', issue: 'blocked', httpStatus: 403 });
  });

  it('reads 451 as an unexpected answer, never as a region block (no verified signal)', () => {
    expect(classifyRequestResult(requestCheck(), answer(451), NOW)).toEqual({ login: 'unknown', issue: 'unexpected', httpStatus: 451 });
  });

  it('recognises a Cloudflare challenge by its cf-mitigated header', () => {
    expect(classifyRequestResult(requestCheck({ loggedOutStatus: [403] }), answer(403, '<html>Just a moment…</html>', { headers: { 'cf-mitigated': 'challenge' } }), NOW)).toEqual({
      login: 'unknown',
      issue: 'captcha',
      httpStatus: 403,
    });
  });

  it('recognises the cs.money captcha answer (403 with error code 4030)', () => {
    expect(classifyRequestResult(requestCheck(), answer(403, { errors: [{ code: 4030 }] }), NOW)).toEqual({ login: 'unknown', issue: 'captcha', httpStatus: 403 });
  });

  it('reads 429 as rate limited, with the retry time when the platform gives one', () => {
    expect(classifyRequestResult(requestCheck(), answer(429, null, { headers: { 'retry-after': '30' } }), NOW)).toEqual({
      login: 'unknown',
      issue: 'rate_limited',
      httpStatus: 429,
      retryAt: NOW + 30_000,
    });
    expect(classifyRequestResult(requestCheck(), answer(429), NOW)).toEqual({ login: 'unknown', issue: 'rate_limited', httpStatus: 429 });
  });

  it('reads a network failure (status 0) as unreachable, not logged out', () => {
    expect(classifyRequestResult(requestCheck(), answer(0, null, { error: 'Failed to fetch' }), NOW)).toEqual({ login: 'unknown', issue: 'network' });
  });

  it('reads a body it cannot parse on an ok status as unexpected', () => {
    expect(classifyRequestResult(requestCheck({ truthyPath: 'user' }), answer(200, '<!doctype html><html>'), NOW)).toEqual({ login: 'unknown', issue: 'unexpected', httpStatus: 200 });
    expect(classifyRequestResult(requestCheck({ truthyPath: 'user' }), answer(200, ['a']), NOW)).toEqual({ login: 'unknown', issue: 'unexpected', httpStatus: 200 });
  });

  it('reads another status as unexpected', () => {
    expect(classifyRequestResult(requestCheck(), answer(404), NOW)).toEqual({ login: 'unknown', issue: 'unexpected', httpStatus: 404 });
  });

  it('separates a refused probe, a withheld redirect and a missing permission', () => {
    expect(classifyRequestResult(requestCheck(), answer(403, null, { error: 'operation_refused:path' }), NOW)).toEqual({ login: 'unknown', issue: 'check_refused' });
    expect(classifyRequestResult(requestCheck(), answer(0, null, { error: 'operation_refused:redirect' }), NOW)).toEqual({ login: 'unknown', issue: 'unexpected' });
    expect(classifyRequestResult(requestCheck(), answer(403, null, { error: 'permission_denied: https://x/*' }), NOW)).toEqual({ login: 'unknown', issue: 'not_granted' });
  });
});

describe('platform answers (the published descriptors, QUICK-202 r1)', () => {
  // The descriptors as apps/web/src/constants/platformCatalog.ts publishes them (its test pins the loggedOutMatch).
  const SKINBARON = requestCheck({ okStatus: [200], truthyPath: 'loggedIn' });
  const SKINPORT = requestCheck({ okStatus: [200], truthyPath: 'user', loggedOutMatch: { path: 'success', equals: false } });
  const BUFF = requestCheck({ okStatus: [200], truthyPath: 'data', loggedOutMatch: { path: 'code', equals: 'Login Required' } });
  const TRADEIT = requestCheck({ okStatus: [200], truthyPath: 'success' });
  const verdict = (check: ReturnType<typeof requestCheck>, body: unknown) => classifyRequestResult(check, answer(200, body), NOW).login;

  it.each([
    ['SkinBaron', SKINBARON, { loggedIn: true }, { loggedIn: false }],
    ['Skinport', SKINPORT, { success: true, user: { id: 42 } }, { success: false }],
    ['BUFF', BUFF, { code: 'OK', data: { id: 'U1' } }, { code: 'Login Required' }],
    ['Tradeit', TRADEIT, { success: true }, { success: false }],
  ])('%s: its signed-in and signed-out answers', (_name, check, signedIn, signedOut) => {
    expect(verdict(check, signedIn)).toBe('logged-in');
    expect(verdict(check, signedOut)).toBe('logged-out');
  });

  it.each([
    ['SkinBaron', SKINBARON, [{}, { error: 'Internal' }, { loggedin: false }]],
    ['Skinport', SKINPORT, [{}, { success: true }, { message: 'Too many requests' }]],
    ['BUFF', BUFF, [{}, { code: 'Internal Server Error' }, { code: 'Action Forbidden', msg: 'x' }]],
    ['Tradeit', TRADEIT, [{}, { error: 'maintenance' }]],
  ])('%s: an answer of another shape leaves the login unknown', (_name, check, bodies) => {
    for (const body of bodies) expect(verdict(check, body)).toBe('unknown');
  });
});

describe('observeLogin', () => {
  const contains = vi.fn();
  const cookieGet = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    contains.mockResolvedValue(true);
    cookieGet.mockResolvedValue({ value: 'fixture-session-value' });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('browser', { permissions: { contains }, cookies: { get: cookieGet }, storage: { local: { get: vi.fn(async () => ({})) } } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports only the presence of the bundled login cookie, never its value', async () => {
    const entry: PlatformCatalogEntry = {
      id: 'steamcommunity.com',
      label: 'Steam',
      origins: ['https://steamcommunity.com/*'],
      loginCheck: { kind: 'cookie', url: 'https://steamcommunity.com', name: 'steamLoginSecure' },
    };
    const observed = await observeLogin(entry);
    expect(observed).toEqual({ login: 'logged-in', evidence: 'cookie' });
    expect(JSON.stringify(observed)).not.toContain('fixture-session-value');
  });

  it.each([
    ['another cookie of the platform', { kind: 'cookie' as const, url: 'https://steamcommunity.com', name: 'sessionid' }, 'steamcommunity.com'],
    ['another host', { kind: 'cookie' as const, url: 'https://evil.test', name: 'steamLoginSecure' }, 'steamcommunity.com'],
    ['a platform without a bundled cookie', { kind: 'cookie' as const, url: 'https://csfloat.com', name: 'session' }, 'csfloat.com'],
    ['an unknown platform', { kind: 'cookie' as const, url: 'https://evil.test', name: 'session' }, 'evil.test'],
  ])('refuses a cookie check for %s without reading any cookie', async (_name, loginCheck, id) => {
    expect(await observeLogin({ id, label: id, origins: [`https://${id}/*`], loginCheck })).toEqual({ login: 'unknown', issue: 'check_refused' });
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('reports a platform without a login check as no_check', async () => {
    expect(await observeLogin({ id: 'haloskins.com', label: 'HaloSkins', origins: ['https://www.haloskins.com/*'] })).toEqual({ login: 'unknown', issue: 'no_check' });
  });

  it('checks nothing without host permission', async () => {
    contains.mockResolvedValue(false);
    expect(await observeLogin({ id: 'cs.money', label: 'CS.Money', origins: ['https://cs.money/*'], loginCheck: { kind: 'cookie', url: 'https://cs.money', name: 'steamid' } })).toEqual({
      login: 'unknown',
      issue: 'not_granted',
    });
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('classifies a probe that answered 500 as a server error, without the body', async () => {
    fetchMock.mockResolvedValue(new Response('{"user":{"steam_id":"76561198000000000"}}', { status: 500, headers: { 'content-type': 'application/json' } }));
    const observed = await observeLogin({
      id: 'csfloat.com',
      label: 'CSFloat',
      origins: ['https://csfloat.com/*'],
      loginCheck: { kind: 'request', url: 'https://csfloat.com/api/v1/me', okStatus: [200], loggedOutStatus: [401], truthyPath: 'user.steam_id' },
    });
    expect(observed).toEqual({ login: 'unknown', issue: 'server_error', httpStatus: 500 });
    expect(JSON.stringify(observed)).not.toContain('7656119');
  });
});

describe('checkAllLogins hooks', () => {
  // Entries without a `loginCheck` resolve to 'unknown' without touching any browser API, so the
  // progress hooks can be tested without mocking `browser`/`fetch`.
  function entry(id: string): PlatformCatalogEntry {
    return { id, label: id, origins: [`https://${id}/*`] };
  }

  it('fires onResult for every entry with its status', async () => {
    const results: Array<[string, string]> = [];
    const map = await checkAllLogins([entry('a'), entry('b')], { onResult: (id, status) => results.push([id, status]) });
    expect(map).toEqual({ a: 'unknown', b: 'unknown' });
    // Checks run concurrently, so onResult order is not guaranteed — assert membership, not order.
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining<[string, string]>([
        ['a', 'unknown'],
        ['b', 'unknown'],
      ])
    );
  });

  it('does not fire onStart for entries that have no loginCheck', async () => {
    const started: string[] = [];
    await checkAllLogins([entry('a'), entry('b')], { onStart: (id) => started.push(id) });
    expect(started).toEqual([]);
  });
});
