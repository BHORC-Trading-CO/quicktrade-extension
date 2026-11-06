// QUICK-226: buy operations are reachable only from the buy executor. The page's proxy, login probes and the scheduler
// are refused by the matcher (internal operations); the executor's sender refuses anything but a buy operation and
// needs the granted origin; and no other source file can send one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, win32 } from 'node:path';

import type { OperationRequest } from '@qts/contracts';
import { csfloatBuyRequest, csMoneyBotConfirmRequest, csMoneyBotDeclineRequest, csMoneyBotHoldRequest, csMoneyPurchaseRequest, matchPlatformOperation, PLATFORM_OPERATIONS } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MARKET_BUY_OPERATION_IDS, sendBuyRequest } from '../market-buy/buy-request';

const BUYS: Array<[string, string, OperationRequest]> = [
  ['csfloat.listings.buy', 'csfloat.com', csfloatBuyRequest('813296748293324890', 26_800)],
  ['csfloat.listings.buy (2FA)', 'csfloat.com', csfloatBuyRequest('813296748293324890', 26_800, '123456')],
  ['csmoney.market.purchase', 'cs.money', csMoneyPurchaseRequest('555000111', 1_234)],
  ['csmoney.trade.send-offer', 'cs.money', csMoneyBotHoldRequest({ id: 1 }, 1_234)],
  ['csmoney.trade.confirm-virtual', 'cs.money', csMoneyBotConfirmRequest(4401)],
  ['csmoney.trade.virtual.decline', 'cs.money', csMoneyBotDeclineRequest(4401)],
];

describe('buy operations in the bundled table', () => {
  it('are exactly the internal, mutating, unscheduled operations the executor sends', () => {
    const all = Object.values(PLATFORM_OPERATIONS).flat();
    const buys = all.filter((operation) => MARKET_BUY_OPERATION_IDS.has(operation.id));
    expect(buys.map((operation) => operation.id).toSorted()).toEqual([...MARKET_BUY_OPERATION_IDS].toSorted());
    for (const operation of buys) expect(operation).toMatchObject({ internal: true, mutates: true, method: 'POST' });
    for (const operation of buys) expect(operation.schedule).toBeUndefined();
  });

  it.each(BUYS)('%s matches for the executor only: never for the page, a login probe or the scheduler', (_id, platform, request) => {
    expect(matchPlatformOperation(platform, request, { purpose: 'internal' })).toMatchObject({ ok: true });
    for (const purpose of ['page', 'login', 'schedule-check', 'schedule-write'] as const) {
      expect(matchPlatformOperation(platform, request, { purpose })).toMatchObject({ ok: false, refusal: { reason: 'purpose' } });
    }
  });
});

const contains = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  contains.mockResolvedValue(true);
  fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9' } }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('browser', { permissions: { contains }, storage: { local: { get: vi.fn(async () => ({})) } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendBuyRequest', () => {
  it('sends the body exactly as built, with the session cookies and no redirects', async () => {
    const built = csfloatBuyRequest('813296748293324890', 26_800);
    const answer = await sendBuyRequest('csfloat.com', built);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://csfloat.com/api/v1/listings/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"total_price":26800,"contract_ids":["813296748293324890"]}',
      credentials: 'include',
      redirect: 'error',
    });
    expect(answer).toEqual({ ok: true, status: 200, data: { ok: true }, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9' } });
  });

  it.each([
    [
      'a page operation',
      'csfloat.com',
      { url: 'https://csfloat.com/api/v1/listings/1', method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"price":1}' },
      'operation_refused:purpose',
    ],
    [
      "white.market's token refresh (internal, not a buy)",
      'white.market',
      {
        url: 'https://api.white.market/graphql/api',
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-accept-language': 'en' },
        body: JSON.stringify({ query: 'mutation AuthToken { auth_token { accessToken } }', operationName: 'AuthToken' }),
      },
      'operation_refused:purpose',
    ],
    ['another host', 'csfloat.com', { ...csfloatBuyRequest('1', 1), url: 'https://evil.test/api/v1/listings/buy' }, 'operation_refused:host'],
    ['an extra header', 'csfloat.com', { ...csfloatBuyRequest('1', 1), headers: { 'Content-Type': 'application/json', Cookie: 'session=x' } }, 'operation_refused:header'],
  ])('refuses %s without a network call', async (_name, platform, request, error) => {
    expect(await sendBuyRequest(platform, request)).toEqual({ ok: false, status: 403, data: null, error });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('needs the granted origin', async () => {
    contains.mockResolvedValue(false);
    expect(await sendBuyRequest('cs.money', csMoneyPurchaseRequest('1', 100))).toMatchObject({ ok: false, status: 403, error: 'permission_denied: https://cs.money/*' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed fetch is status 0 (the request may have left); a text answer stays text', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await sendBuyRequest('cs.money', csMoneyPurchaseRequest('1', 100))).toEqual({ ok: false, status: 0, data: null, error: 'network' });
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect(await sendBuyRequest('cs.money', csMoneyPurchaseRequest('1', 100))).toMatchObject({ ok: false, status: 502, data: '<html>bad gateway</html>' });
  });
});

/** Every production source file of the extension (tests and generated output excluded). */
function sources(dir: string, root = dir, relativePath = relative): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (['node_modules', '.output', '.wxt', 'dist', '__tests__'].includes(name)) return [];
    if (statSync(full).isDirectory()) return sources(full, root, relativePath);
    return /\.(ts|tsx)$/.test(name) ? [{ path: relativePath(root, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') }] : [];
  });
}

describe.each([
  ['native', relative],
  ['Windows', win32.relative],
] as const)('no other code can send a buy (%s paths)', (_name, relativePath) => {
  const root = join(__dirname, '..', '..');
  const files = sources(root, root, relativePath);

  it('only the executor uses the buy sender', () => {
    const users = files.filter((file) => /\bsendBuyRequest\b/.test(file.text)).map((file) => file.path);
    expect(users.toSorted()).toEqual(['background/market-buy/buy-request.ts', 'background/market-buy/executor.ts']);
  });

  it("only the token refresh and the buy sender run operations for the 'internal' purpose", () => {
    const users = files.filter((file) => /purpose: 'internal'|, 'internal'\)/.test(file.text)).map((file) => file.path);
    expect(users.toSorted()).toEqual(['background/market-buy/buy-request.ts', 'background/proxy.ts']);
  });

  it('the buy endpoints are built only by @qts/contracts (no URL of one in the extension)', () => {
    const paths = ['/api/v1/listings/buy', '/1.0/market/purchase', '/2.0/send-offer', 'confirm_virtual_offer', '/virtual/'];
    expect(files.filter((file) => paths.some((path) => file.text.includes(path))).map((file) => file.path)).toEqual([]);
  });
});
