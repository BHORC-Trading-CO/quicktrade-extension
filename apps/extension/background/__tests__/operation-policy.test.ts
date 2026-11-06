import type { HttpRequest, OperationRequest, PlatformCatalogEntry, PlatformOperation } from '@qts/contracts';
import { classifyRepriceFailure, followsOperationRedirects, graphqlOperations, matchPlatformOperation, PLATFORM_OPERATIONS } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleSiteMessage } from '../handlers/site';
import { checkLogin } from '../loginStatus';

// ─── Fixtures: requests exactly as the web clients build them ─────────────────────────────────────

const CSFLOAT_SEARCH = 'https://csfloat.com/api/v1/listings?limit=50&def_index=7&paint_index=282&category=1&type=buy_now';
const CSFLOAT_EDIT: OperationRequest = {
  url: 'https://csfloat.com/api/v1/listings/987654321',
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: '{"price":1234}',
};
const SHADOWPAY_LIST: OperationRequest = {
  url: 'https://api.shadowpay.com/api/market/market_offer_bid',
  method: 'POST',
  headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', 'x-xsrf-token': 'fixture-xsrf', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'offers%5B0%5D%5Bid%5D=1&offers%5B0%5D%5Bproject%5D=csgo&offers%5B0%5D%5Bprice%5D=1.5',
};
const WM_HEADERS = { 'content-type': 'application/json', accept: 'application/json', 'x-accept-language': 'en' };
const WM_URL = 'https://api.white.market/graphql/api';
function graphql(query: string, operationName: string, variables: Record<string, unknown> = {}): string {
  return JSON.stringify({ query, variables, operationName });
}
const WM_INSTANT_SELL = graphql('query InstantSellList($appId: SteamApp!) { instant_sell_list(appId: $appId) { total } }', 'InstantSellList', { appId: 'CSGO' });
const WM_EDIT = graphql('mutation MarketEdit($marketProductId: String!, $price: MoneyInput!) { market_edit(marketProductId: $marketProductId, price: $price) { id } }', 'MarketEdit');
const AIM_QUERY = graphql(
  'query ApiSteamInventory($input: SteamItemsInput!, $includeLocale: Boolean! = false) {\n  steam_inventory(input: $input) {\n    id\n    locale @include(if: $includeLocale) { ...L }\n  }\n}\n\nfragment L on SteamItemLocale { marketHashName }',
  'ApiSteamInventory'
);

function refusal(platform: string, request: OperationRequest, purpose?: Parameters<typeof matchPlatformOperation>[2]) {
  const match = matchPlatformOperation(platform, request, purpose);
  return match.ok ? null : match.refusal;
}

describe('operation matcher (bundled PLATFORM_OPERATIONS)', () => {
  it('matches the requests the web builds', () => {
    expect(matchPlatformOperation('csfloat.com', { url: CSFLOAT_SEARCH, method: 'GET' })).toMatchObject({ ok: true, operation: { id: 'csfloat.listings.search' } });
    expect(matchPlatformOperation('csfloat.com', CSFLOAT_EDIT)).toMatchObject({ ok: true, operation: { id: 'csfloat.listing.edit', mutates: true } });
    expect(matchPlatformOperation('shadowpay.com', SHADOWPAY_LIST)).toMatchObject({ ok: true, operation: { id: 'shadowpay.offer.create' } });
    expect(matchPlatformOperation('white.market', { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: WM_EDIT })).toMatchObject({
      ok: true,
      operation: { id: 'whitemarket.market.edit' },
    });
    expect(matchPlatformOperation('aim.market', { url: 'https://aim.market/v1/api/graphql', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: AIM_QUERY })).toMatchObject({
      ok: true,
      operation: { id: 'aim.inventory' },
    });
  });

  it.each([
    ['unknown platform', 'evil.market', { url: CSFLOAT_SEARCH, method: 'GET' }, 'unknown_platform'],
    ['plain http', 'csfloat.com', { url: CSFLOAT_SEARCH.replace('https:', 'http:'), method: 'GET' }, 'invalid_url'],
    ['explicit port', 'csfloat.com', { url: CSFLOAT_SEARCH.replace('csfloat.com/', 'csfloat.com:444/'), method: 'GET' }, 'invalid_url'],
    ['userinfo', 'csfloat.com', { url: CSFLOAT_SEARCH.replace('https://', 'https://user:pw@'), method: 'GET' }, 'invalid_url'],
    ['fragment', 'csfloat.com', { url: `${CSFLOAT_SEARCH}#x`, method: 'GET' }, 'invalid_url'],
    ['wrong host', 'csfloat.com', { url: CSFLOAT_SEARCH.replace('csfloat.com', 'evil.csfloat.com'), method: 'GET' }, 'host'],
    ["another platform's host", 'csfloat.com', { url: 'https://cs.money/1.0/market/history', method: 'GET' }, 'host'],
    ['wrong method', 'csfloat.com', { ...CSFLOAT_EDIT, method: 'PUT' }, 'method'],
    ['unknown path', 'csfloat.com', { url: 'https://csfloat.com/api/v1/me/api-keys', method: 'GET' }, 'path'],
    ['typed path parameter', 'csfloat.com', { url: 'https://csfloat.com/api/v1/users/me%2F..%2Fadmin/stall', method: 'GET' }, 'path'],
    ['traversal to another path', 'csfloat.com', { url: 'https://csfloat.com/api/v1/listings/1/../../me/api-keys', method: 'GET' }, 'path'],
    ['extra query key', 'csfloat.com', { url: `${CSFLOAT_SEARCH}&redirect=1`, method: 'GET' }, 'query'],
    ['query on a query-less operation', 'csfloat.com', { url: 'https://csfloat.com/api/v1/me?x=1', method: 'GET' }, 'query'],
    ['extra header', 'csfloat.com', { ...CSFLOAT_EDIT, headers: { 'Content-Type': 'application/json', Cookie: 'session=x' } }, 'header'],
    ['page-supplied auth header', 'white.market', { url: WM_URL, method: 'POST', headers: { ...WM_HEADERS, Authorization: 'Bearer x' }, body: WM_EDIT }, 'header'],
    ['body on a body-less operation', 'csfloat.com', { url: CSFLOAT_SEARCH, method: 'GET', body: '{}' }, 'body'],
    ['form body on a JSON operation', 'csfloat.com', { ...CSFLOAT_EDIT, body: 'price=1' }, 'body'],
    ['JSON content type on a form operation', 'shadowpay.com', { ...SHADOWPAY_LIST, headers: { ...SHADOWPAY_LIST.headers, 'Content-Type': 'application/json' } }, 'body'],
    ['missing body', 'csfloat.com', { ...CSFLOAT_EDIT, body: undefined }, 'body'],
  ] as Array<[string, string, OperationRequest, string]>)('refuses %s', (_name, platform, request, reason) => {
    expect(refusal(platform, request)).toMatchObject({ reason });
  });

  it.each([
    ['a mutation named like the query', graphql('mutation InstantSellList { market_remove(marketProductId: "x") { id } }', 'InstantSellList')],
    ['an extra root field', graphql('query InstantSellList { instant_sell_list(appId: CSGO) { total } market_my { totalCount } }', 'InstantSellList')],
    ['an aliased foreign root field', graphql('query InstantSellList { instant_sell_list: auth_token { accessToken } }', 'InstantSellList')],
    ['a root fragment spread', graphql('query InstantSellList { ...F } fragment F on Query { auth_token { accessToken } }', 'InstantSellList')],
    ['a second operation', graphql('query InstantSellList { instant_sell_list(appId: CSGO) { total } } mutation X { auth_token { accessToken } }', 'X')],
    ['a persisted-query extension', JSON.stringify({ query: 'query InstantSellList { instant_sell_list(appId: CSGO) { total } }', operationName: 'InstantSellList', extensions: {} })],
    ['a mismatched operationName', graphql('query InstantSellList { instant_sell_list(appId: CSGO) { total } }', 'MarketMy')],
    ['an unreadable document', graphql('query InstantSellList { instant_sell_list(appId: "CSGO) { total } }', 'InstantSellList')],
  ])('refuses a GraphQL body with %s', (_name, body) => {
    expect(refusal('white.market', { url: WM_URL, method: 'POST', headers: WM_HEADERS, body })).toMatchObject({ reason: 'graphql' });
  });

  it('reads GraphQL documents with variables defaults, directives, block strings and comments', () => {
    expect(graphqlOperations('# c\nquery Q($a: In = {b: "}"}) @x(y: 1) { f(s: """ { """) @include(if: $a) { g } h: k }')).toEqual([{ type: 'query', name: 'Q', fields: ['f', 'k'] }]);
    expect(graphqlOperations('{ a }')).toEqual([{ type: 'query', name: null, fields: ['a'] }]);
    // `\"""` does not end a block string: the root field after it is seen, as the server sees it.
    expect(graphqlOperations('{ a(s: """x\\""" y""") b }')).toEqual([{ type: 'query', name: null, fields: ['a', 'b'] }]);
  });

  it('limits each purpose: page never runs internal operations, login only reads, the scheduler only its own', () => {
    const authToken = graphql('mutation AuthToken { auth_token { accessToken } }', 'AuthToken');
    expect(refusal('white.market', { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: authToken })).toEqual({ reason: 'purpose', detail: 'white-market.auth-token' });
    expect(refusal('white.market', { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: authToken }, { purpose: 'internal' })).toBeNull();
    expect(refusal('csfloat.com', CSFLOAT_EDIT, { purpose: 'login' })).toMatchObject({ reason: 'purpose' });
    expect(refusal('csfloat.com', { url: 'https://csfloat.com/api/v1/listings/1', method: 'DELETE', headers: { 'Content-Type': 'application/json' } }, { purpose: 'schedule-write' })).toEqual({
      reason: 'purpose',
      detail: 'csfloat.listing.remove',
    });
    expect(refusal('csfloat.com', CSFLOAT_EDIT, { purpose: 'schedule-write' })).toBeNull();
    expect(refusal('csfloat.com', { url: CSFLOAT_SEARCH, method: 'GET' }, { purpose: 'schedule-check' })).toMatchObject({ reason: 'purpose' });
  });

  it('a narrowing list can only remove operations', () => {
    expect(refusal('csfloat.com', CSFLOAT_EDIT, { allowedIds: ['csfloat.me'] })).toEqual({ reason: 'narrowed', detail: 'csfloat.listing.edit' });
    expect(refusal('csfloat.com', { url: 'https://evil.test/x', method: 'GET' }, { allowedIds: ['evil.anything'] })).toMatchObject({ reason: 'host' });
  });

  it('every operation is well-formed: exact https host, anchored path, lower-case header names', () => {
    for (const operations of Object.values(PLATFORM_OPERATIONS)) {
      for (const operation of operations) {
        expect(operation.host).toMatch(/^[a-z0-9.-]+$/);
        expect(operation.path.startsWith('/')).toBe(true);
        expect(operation.headers?.every((name) => name === name.toLowerCase()) ?? true).toBe(true);
        if (operation.schedule === 'write') expect(operation.mutates).toBe(true);
        if (operation.schedule === 'check') expect(operation.mutates).toBe(false);
      }
    }
    const ids = Object.values(PLATFORM_OPERATIONS).flatMap((operations) => operations.map((operation) => operation.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── The background: proxy_request, auth headers, redirects, catalog narrowing, login probes ─────────

const contains = vi.fn();
const cookieGet = vi.fn();
const fetchMock = vi.fn();
const warn = vi.fn();
let catalog: PlatformCatalogEntry[] = [];

function json(data: unknown, init: { status?: number; url?: string; redirected?: boolean } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: init.redirected ?? false,
    url: init.url ?? '',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  catalog = [];
  contains.mockResolvedValue(true);
  cookieGet.mockResolvedValue(null);
  fetchMock.mockImplementation(async () => json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(warn);
  vi.stubGlobal('browser', {
    permissions: { contains },
    cookies: { get: cookieGet },
    storage: { local: { get: vi.fn(async () => ({ qts_platform_catalog: catalog })) } },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function proxy(platform: string, request: HttpRequest, requestId = 'r1') {
  const { handleSiteMessage: handle } = await import('../handlers/site');
  return handle({ type: 'site:proxy_request', data: { requestId, platform, request } });
}

describe('proxy_request executes only allowlisted operations', () => {
  it('refuses before any network call and logs no values', async () => {
    const reply = await proxy('csfloat.com', { url: `${CSFLOAT_SEARCH}&secret=fixture-secret-value`, method: 'GET', headers: { 'X-Fixture': 'fixture-secret-header' } });
    expect(reply).toEqual({ ok: true, data: { requestId: 'r1', ok: false, status: 403, data: null, error: 'operation_refused:query' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toEqual({ platform: 'csfloat.com', purpose: 'page', reason: 'query', detail: 'secret', method: 'GET', host: 'csfloat.com' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-secret');
  });

  it('answers the requestId of a malformed payload without sending anything', async () => {
    const { handleSiteMessage: handle } = await import('../handlers/site');
    expect(await handle({ type: 'site:proxy_request', data: { requestId: 'bad', platform: 'csfloat.com' } })).toMatchObject({
      ok: true,
      data: { requestId: 'bad', ok: false, status: 403, error: 'operation_refused:invalid_url' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an allowlisted request with the page cookies, never letting the browser follow a write’s redirect', async () => {
    const reply = await proxy('csfloat.com', { url: CSFLOAT_EDIT.url, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"price":1234}' });
    expect(reply).toMatchObject({ ok: true, data: { requestId: 'r1', ok: true, status: 200, data: { ok: true } } });
    expect(fetchMock).toHaveBeenCalledWith(CSFLOAT_EDIT.url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"price":1234}',
      credentials: 'include',
      redirect: 'manual',
    });
  });

  it('still requires the granted origin', async () => {
    contains.mockResolvedValue(false);
    expect(await proxy('csfloat.com', { url: CSFLOAT_SEARCH, method: 'GET' })).toMatchObject({ data: { ok: false, status: 403, error: 'permission_denied: https://csfloat.com/*' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('withholds the answer of a followed (declared) redirect that ends outside the allowlist', async () => {
    fetchMock.mockResolvedValue(json({ apiKey: 'fixture-secret' }, { redirected: true, url: 'https://steamcommunity.com/id/fixture-vanity/edit/info' }));
    const reply = await proxy('steamcommunity.com', { url: 'https://steamcommunity.com/my/', method: 'GET' });
    expect(reply).toEqual({ ok: true, data: { requestId: 'r1', ok: false, status: 0, data: null, error: 'operation_refused:redirect' } });
    expect(JSON.stringify(reply)).not.toContain('fixture-secret');
  });

  it.each([
    ['a declared redirect (Steam /my/ → profile)', 'https://steamcommunity.com/id/fixture-vanity/'],
    ['a redirect onto another read operation', 'https://steamcommunity.com/profiles/76561198000000001/'],
  ])('answers %s', async (_name, finalUrl) => {
    fetchMock.mockResolvedValue(json({ profile: true }, { redirected: true, url: finalUrl }));
    expect(await proxy('steamcommunity.com', { url: 'https://steamcommunity.com/my/', method: 'GET' })).toMatchObject({ data: { ok: true, status: 200 } });
  });

  it.each([
    ['inventory history', '/profiles/76561198000000001/inventoryhistory/?ajax=1&l=english&app%5B%5D=730', '/id/fixture-vanity/inventoryhistory?ajax=1'],
    ['trade history', '/profiles/76561198000000001/tradehistory/?l=english', '/id/fixture-vanity/tradehistory?l=english'],
    ['sent offer history', '/profiles/76561198000000001/tradeoffers/sent/?history=1&l=english', '/id/fixture-vanity/tradeoffers/sent?history=1&l=english'],
    ['received offer history', '/profiles/76561198000000001/tradeoffers/?history=1&l=english', '/id/fixture-vanity/tradeoffers?history=1&l=english'],
  ])('answers Steam %s redirected to a vanity URL', async (_name, path, finalPath) => {
    fetchMock.mockResolvedValue(json({ success: true }, { redirected: true, url: `https://steamcommunity.com${finalPath}` }));
    expect(
      await proxy('steamcommunity.com', {
        url: `https://steamcommunity.com${path}`,
        method: 'GET',
        ...(path.includes('inventoryhistory') ? { headers: { 'X-Requested-With': 'XMLHttpRequest' } } : {}),
      })
    ).toMatchObject({ data: { ok: true, status: 200 } });
  });

  it('a page-published catalog narrows but cannot widen', async () => {
    catalog = [{ id: 'csfloat.com', label: 'CSFloat', origins: ['https://csfloat.com/*'], operations: ['csfloat.me', 'evil.everything'] }];
    expect(await proxy('csfloat.com', { url: CSFLOAT_SEARCH, method: 'GET' })).toMatchObject({ data: { ok: false, status: 403, error: 'operation_refused:narrowed' } });
    expect(await proxy('csfloat.com', { url: 'https://csfloat.com/api/v1/me', method: 'GET' })).toMatchObject({ data: { ok: true } });
    expect(await proxy('csfloat.com', { url: 'https://csfloat.com/api/v1/me/api-keys', method: 'GET' })).toMatchObject({ data: { error: 'operation_refused:path' } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends a GraphQL body as checked: a duplicate key cannot smuggle another document', async () => {
    const smuggled = `{"query":"mutation AuthToken { auth_token { accessToken } }",${WM_EDIT.slice(1)}`;
    cookieGet.mockResolvedValue({ value: 'fixture-access', httpOnly: false });
    await proxy('white.market', { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: smuggled });
    expect(fetchMock.mock.calls[0]?.[1].body).toBe(JSON.stringify(JSON.parse(WM_EDIT)));
  });

  it('refuses both retired DMarket endpoints before any marketplace request', async () => {
    for (const path of ['/exchange/v1/market/items', '/exchange/v1/user/items']) {
      expect(await proxy('dmarket.com', { url: `https://api.dmarket.com${path}`, method: 'GET' })).toMatchObject({ data: { status: 403, error: 'operation_refused:path' } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('pins credentials an operation declares (DMarket omits its session cookie)', async () => {
    await proxy('dmarket.com', { url: 'https://api.dmarket.com/exchange/v1/market/items/v2?side=market&title=x', method: 'GET', headers: { jkkat: 'abc' }, credentials: 'include' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' });
  });
});

/**
 * What fetch answers a 3xx with under `redirect: 'manual'`: an opaque redirect, status 0 and no headers, so no Location
 * (the Fetch standard's opaque-redirect filtered response; seen in a Chrome 156 extension service worker with host access).
 */
function opaqueRedirect(url: string) {
  return {
    ok: false,
    status: 0,
    type: 'opaqueredirect',
    redirected: false,
    url,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
    text: async () => '',
  };
}

describe('QUICK-292: the browser follows only the redirects a read operation declares', () => {
  const WM_EDIT_REQUEST: HttpRequest = { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: WM_EDIT };

  it('lets the browser follow only GET reads that declare redirects and carry no background auth', () => {
    const followed = Object.values(PLATFORM_OPERATIONS)
      .flat()
      .filter(followsOperationRedirects)
      .map(({ id }) => id);
    expect(followed.toSorted()).toEqual([
      'csmoney.page.market',
      'steam.inventory-history',
      'steam.market.history',
      'steam.market.wallet',
      'steam.profile',
      'steam.trade-history',
      'steam.trade-offers.received',
      'steam.trade-offers.sent',
    ]);
    const read: PlatformOperation = { id: 'fixture.read', method: 'GET', host: 'fixture.test', path: '/r/', body: 'none', mutates: false, redirects: ['/r2/'] };
    expect(followsOperationRedirects(read)).toBe(true);
    const auth: PlatformOperation['auth'] = { cookieUrl: 'https://fixture.test', cookie: 'token', header: 'authorization', format: 'bearer' };
    for (const operation of [
      { ...read, redirects: undefined },
      { ...read, redirects: [] },
      { ...read, method: 'POST' as const },
      { ...read, mutates: true },
      { ...read, internal: true },
      { ...read, auth },
    ]) {
      expect(followsOperationRedirects(operation)).toBe(false);
    }
  });

  it.each([
    ['a CSFloat listing edit (PATCH)', 'csfloat.com', CSFLOAT_EDIT],
    ['a ShadowPay listing (form POST)', 'shadowpay.com', SHADOWPAY_LIST],
    ['a white.market GraphQL mutation (Bearer added by the background)', 'white.market', WM_EDIT_REQUEST],
  ] as Array<[string, string, HttpRequest]>)('a 3xx answer to %s is an unknown result: never followed, never success, never "not sent"', async (_name, platform, request) => {
    cookieGet.mockResolvedValue({ value: 'fixture-access', httpOnly: false });
    fetchMock.mockResolvedValue(opaqueRedirect(request.url));
    expect(await proxy(platform, request)).toEqual({ ok: true, data: { requestId: 'r1', ok: false, status: 0, data: null, error: 'redirect_result_unknown' } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('the scheduler’s write gets the same unknown result, which it retries as transient', async () => {
    const { proxyRequest } = await import('../proxy');
    fetchMock.mockResolvedValue(opaqueRedirect(CSFLOAT_EDIT.url));
    const result = await proxyRequest(CSFLOAT_EDIT.url, { method: 'PATCH', headers: CSFLOAT_EDIT.headers, body: CSFLOAT_EDIT.body, platform: 'csfloat.com', purpose: 'schedule-write' });
    expect(result).toEqual({ ok: false, status: 0, data: null, error: 'redirect_result_unknown' });
    expect(classifyRepriceFailure(result.status)).toBe('transient');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it.each([
    ['a GET read (CSFloat search)', 'csfloat.com', { url: CSFLOAT_SEARCH, method: 'GET' }],
    ['a GraphQL query sent as POST (white.market)', 'white.market', { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: WM_INSTANT_SELL }],
  ] as Array<[string, string, HttpRequest]>)('a 3xx answer to %s without declared redirects is withheld before its target is contacted', async (_name, platform, request) => {
    cookieGet.mockResolvedValue({ value: 'fixture-access', httpOnly: false });
    fetchMock.mockResolvedValue(opaqueRedirect(request.url));
    expect(await proxy(platform, request)).toEqual({ ok: true, data: { requestId: 'r1', ok: false, status: 0, data: null, error: 'operation_refused:redirect' } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({ platform, reason: 'redirect' });
  });

  it.each([
    ['Steam /my/ to the signed-in profile', 'steamcommunity.com', { url: 'https://steamcommunity.com/my/', method: 'GET' }, 'https://steamcommunity.com/id/fixture-vanity/'],
    [
      'Steam inventory history to the vanity URL',
      'steamcommunity.com',
      { url: 'https://steamcommunity.com/profiles/76561198000000001/inventoryhistory/?ajax=1&l=english', method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest' } },
      'https://steamcommunity.com/id/fixture-vanity/inventoryhistory?ajax=1',
    ],
    [
      'Steam market history to the login page',
      'steamcommunity.com',
      { url: 'https://steamcommunity.com/market/myhistory/render/?query=&start=0&count=10', method: 'GET' },
      'https://steamcommunity.com/login/home/?goto=market',
    ],
    ['the cs.money market page to a locale copy', 'cs.money', { url: 'https://cs.money/market/buy/', method: 'GET' }, 'https://cs.money/ru/market/buy/'],
  ] as Array<[string, string, HttpRequest, string]>)('keeps following a declared read redirect: %s', async (_name, platform, request, finalUrl) => {
    fetchMock.mockResolvedValue(json({ page: true }, { redirected: true, url: finalUrl }));
    expect(await proxy(platform, request)).toMatchObject({ data: { ok: true, status: 200, data: { page: true } } });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'follow' });
  });
});

describe('auth headers come from the background, never from the page', () => {
  const WM_INSTANT_SELL_REQUEST: HttpRequest = { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: WM_INSTANT_SELL };

  it('white.market: reads access-token and sends it as a Bearer header', async () => {
    cookieGet.mockImplementation(async ({ name }: { name: string }) => (name === 'access-token' ? { value: 'fixture-access', httpOnly: false } : null));
    const reply = await proxy('white.market', WM_INSTANT_SELL_REQUEST);
    expect(reply).toMatchObject({ data: { ok: true, status: 200 } });
    expect(cookieGet).toHaveBeenCalledWith({ url: 'https://white.market', name: 'access-token' });
    expect(fetchMock.mock.calls[0]?.[1].headers).toEqual({ ...WM_HEADERS, Authorization: 'Bearer fixture-access' });
    expect(JSON.stringify(reply)).not.toContain('fixture-access');
  });

  it('white.market: a 401 mints a fresh token once (internal operation) and retries; the token never reaches the page', async () => {
    cookieGet.mockResolvedValue({ value: 'fixture-stale', httpOnly: false });
    fetchMock
      .mockResolvedValueOnce(json({ errors: [] }, { status: 401 }))
      .mockResolvedValueOnce(json({ data: { auth_token: { accessToken: 'fixture-minted' } } }))
      .mockResolvedValueOnce(json({ data: { instant_sell_list: { total: 1 } } }));
    const reply = await proxy('white.market', WM_INSTANT_SELL_REQUEST);
    expect(reply).toMatchObject({ data: { ok: true, status: 200, data: { data: { instant_sell_list: { total: 1 } } } } });
    expect(JSON.stringify(reply)).not.toContain('fixture-minted');
    const [mint, retry] = [fetchMock.mock.calls[1], fetchMock.mock.calls[2]];
    expect(mint?.[0]).toBe(WM_URL);
    expect(JSON.parse(String(mint?.[1].body))).toMatchObject({ operationName: 'AuthToken' });
    expect(mint?.[1]).toMatchObject({ credentials: 'include', redirect: 'error' });
    expect(mint?.[1].headers).not.toHaveProperty('Authorization');
    expect(retry?.[1].headers).toMatchObject({ Authorization: 'Bearer fixture-minted' });

    // The minted token is reused for the next request instead of the stale cookie.
    fetchMock.mockResolvedValueOnce(json({ data: {} }));
    await proxy('white.market', { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: WM_EDIT });
    expect(fetchMock.mock.calls[3]?.[1].headers).toMatchObject({ Authorization: 'Bearer fixture-minted' });
  });

  it('white.market: without a cookie the token is minted first', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { auth_token: { accessToken: 'fixture-minted' } } }));
    await proxy('white.market', WM_INSTANT_SELL_REQUEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1].headers).toMatchObject({ Authorization: 'Bearer fixture-minted' });
  });

  it('a signed-out user gets 401 locally, without a marketplace request', async () => {
    fetchMock.mockResolvedValueOnce(json({ errors: [{ message: 'unauthorized' }] }, { status: 401 }));
    expect(await proxy('white.market', WM_INSTANT_SELL_REQUEST)).toMatchObject({ data: { ok: false, status: 401, error: 'operation_refused:auth_unavailable' } });
    expect(fetchMock).toHaveBeenCalledOnce(); // the mint attempt only
    fetchMock.mockClear();
    expect(await proxy('dmarket.com', { url: 'https://api.dmarket.com/exchange/v1/user/assets?side=user&title=x', method: 'GET', headers: { jkkat: 'abc' }, credentials: 'omit' })).toMatchObject({
      data: { ok: false, status: 401, error: 'operation_refused:auth_unavailable' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aim.market: the Bearer is the accessToken field of the URL-encoded __user-store cookie', async () => {
    cookieGet.mockResolvedValue({ value: encodeURIComponent(JSON.stringify({ accessToken: 'fixture-aim', user: {} })), httpOnly: false });
    await proxy('aim.market', { url: 'https://aim.market/v1/api/graphql', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: AIM_QUERY });
    expect(cookieGet).toHaveBeenCalledWith({ url: 'https://aim.market', name: '__user-store' });
    expect(fetchMock.mock.calls[0]?.[1].headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer fixture-aim' });
  });

  it('DMarket: the raw dm-trade-token from dmarket.com, without cookies', async () => {
    cookieGet.mockResolvedValue({ value: 'fixture-dm', httpOnly: false });
    await proxy('dmarket.com', { url: 'https://api.dmarket.com/exchange/v1/user/assets?side=user&title=x', method: 'GET', headers: { jkkat: 'abc' }, credentials: 'omit' });
    expect(cookieGet).toHaveBeenCalledWith({ url: 'https://dmarket.com', name: 'dm-trade-token' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { jkkat: 'abc', Authorization: 'fixture-dm' }, credentials: 'omit' });
  });

  it('the auth cookie is read only with the cookie origin granted', async () => {
    cookieGet.mockResolvedValue({ value: 'fixture-dm', httpOnly: false });
    contains.mockImplementation(async ({ origins }: { origins: string[] }) => origins[0] !== 'https://dmarket.com/*');
    expect(await proxy('dmarket.com', { url: 'https://api.dmarket.com/exchange/v1/user/assets?side=user', method: 'GET', headers: { jkkat: 'abc' } })).toMatchObject({
      data: { status: 401, error: 'operation_refused:auth_unavailable' },
    });
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('the page can neither mint a token nor read the session cookies', async () => {
    expect(await proxy('white.market', { url: WM_URL, method: 'POST', headers: WM_HEADERS, body: graphql('mutation AuthToken { auth_token { accessToken } }', 'AuthToken') })).toMatchObject({
      data: { status: 403, error: 'operation_refused:purpose' },
    });
    for (const [url, name] of [
      ['https://white.market', 'access-token'],
      ['https://aim.market', '__user-store'],
      ['https://dmarket.com', 'dm-trade-token'],
    ]) {
      expect(await handleSiteMessage({ type: 'site:get_cookie', data: { requestId: name, url, name } })).toEqual({ ok: true, data: { requestId: name, value: null, error: 'cookie_not_allowed' } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookieGet).not.toHaveBeenCalled();
  });
});

function entry(loginCheck: PlatformCatalogEntry['loginCheck']): PlatformCatalogEntry {
  return { id: 'csfloat.com', label: 'CSFloat', origins: ['https://csfloat.com/*'], loginCheck };
}

describe('login probes from the page-published catalog', () => {
  it('runs an allowlisted read probe', async () => {
    fetchMock.mockResolvedValue(json({ user: { steam_id: '1' } }));
    expect(await checkLogin(entry({ kind: 'request', url: 'https://csfloat.com/api/v1/me', truthyPath: 'user.steam_id' }))).toBe('logged-in');
  });

  it('answers unknown, not logged-out, when the probe never completes (network failure)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await checkLogin(entry({ kind: 'request', url: 'https://csfloat.com/api/v1/me', truthyPath: 'user.steam_id' }))).toBe('unknown');
  });

  it.each([
    [
      'a mutating operation',
      { kind: 'request' as const, url: 'https://csfloat.com/api/v1/listings', method: 'POST' as const, body: '{"asset_id":"1","price":1}', headers: { 'Content-Type': 'application/json' } },
    ],
    ['a non-allowlisted endpoint', { kind: 'request' as const, url: 'https://csfloat.com/api/v1/me/api-keys' }],
    ["another platform's endpoint", { kind: 'request' as const, url: 'https://cs.money/1.0/market/history' }],
  ])('answers unknown for %s without a request', async (_name, loginCheck) => {
    expect(await checkLogin(entry(loginCheck))).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
