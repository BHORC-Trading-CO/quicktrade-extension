// QUICK-178 (QUICK-166 T11): refusals through the real message entry point. Nothing below mocks a background module:
// onRuntimeMessage → handlers/site.ts → scheduler / dnr-service / proxy, with only the browser APIs and fetch faked.
// The pure validators and handleSiteMessage are covered in operation-policy, dnr-policy, dnr-service, cookie-policy and
// scheduler-operations tests; this file proves the router and the handlers wire them in front of every side effect.
import type { ScheduledRule } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildRepriceTemplate, requestSafeRepriceActivation } from '../../test-support/web/sell/repriceSchedule';
import type { BridgeSender } from '../../shared/bridge-policy';
import type * as Router from '../runtime-router';
import { chromeStored } from './chrome-storage';

vi.mock('../../shared/config', () => ({ BRIDGE_MODE: 'production' }));

const PAGE: BridgeSender = { id: 'qts', tab: { id: 2 }, frameId: 0, origin: 'https://app.quicktrade.skin', url: 'https://app.quicktrade.skin/sell-mode' };
const UNTRUSTED: Array<[string, BridgeSender, string]> = [
  ['a content script on another site', { ...PAGE, origin: 'https://evil.test', url: 'https://evil.test/' }, 'bridge_forbidden_origin'],
  ['a lookalike host', { ...PAGE, origin: 'https://quicktrade.skin.evil.test', url: 'https://quicktrade.skin.evil.test/' }, 'bridge_forbidden_origin'],
  ['a lookalike of the app host', { ...PAGE, origin: 'https://app.quicktrade.skin.evil.com', url: 'https://app.quicktrade.skin.evil.com/' }, 'bridge_forbidden_origin'],
  ['a subdomain of the app host', { ...PAGE, origin: 'https://x.app.quicktrade.skin', url: 'https://x.app.quicktrade.skin/' }, 'bridge_forbidden_origin'],
  ['the web app over http', { ...PAGE, origin: 'http://app.quicktrade.skin', url: 'http://app.quicktrade.skin/sell-mode' }, 'bridge_forbidden_origin'],
  ['the apex, which serves only the landing', { ...PAGE, origin: 'https://quicktrade.skin', url: 'https://quicktrade.skin/' }, 'bridge_forbidden_origin'],
  ['the apex over http', { ...PAGE, origin: 'http://quicktrade.skin', url: 'http://quicktrade.skin/sell-mode' }, 'bridge_forbidden_origin'],
  ['localhost in a production build', { ...PAGE, origin: 'http://localhost:3000', url: 'http://localhost:3000/sell-mode' }, 'bridge_forbidden_origin'],
  ['another site in Firefox (no sender origin)', { ...PAGE, origin: undefined, url: 'https://evil.test/' }, 'bridge_forbidden_origin'],
  ['an embedded frame of the web app', { ...PAGE, frameId: 3 }, 'bridge_not_top_frame'],
  ['another extension', { ...PAGE, id: 'other-extension' }, 'bridge_untrusted_sender'],
  ['a web app message without a tab', { ...PAGE, tab: undefined }, 'bridge_not_top_frame'],
  ["the extension's own popup (no tab)", { id: 'qts', url: 'chrome-extension://qts/popup.html' }, 'bridge_not_top_frame'],
  ["the extension's popup opened as a tab", { id: 'qts', tab: { id: 5 }, frameId: 0, origin: 'chrome-extension://qts', url: 'chrome-extension://qts/popup.html' }, 'bridge_forbidden_origin'],
];

const NOW = 30 * 86_400_000;
function webRule(itemId: string): ScheduledRule {
  return {
    ruleId: `${itemId}:cs.money`,
    platform: 'cs.money',
    itemId,
    marketHashName: 'fixture',
    firstPrice: 100,
    secondPrice: 80,
    startAt: NOW,
    days: 5,
    lastAppliedDay: 0,
    template: buildRepriceTemplate('cs.money', itemId, undefined)!,
    active: true,
    createdAt: NOW,
  };
}
const SEEDED = requestSafeRepriceActivation(webRule('41'));
const CSFLOAT_SEARCH = 'https://csfloat.com/api/v1/listings?limit=50&def_index=7&paint_index=282&category=1&type=buy_now';
const CSFLOAT_EDIT = { url: 'https://csfloat.com/api/v1/listings/987654321', method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"price":1234}' };
const DNR_RULE = {
  id: 2001,
  priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] },
  condition: { urlFilter: '|https://cs.money/', resourceTypes: ['xmlhttprequest', 'other'] },
};

let router: typeof Router;
let storage: Record<string, unknown>;
const local = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
const alarmsCreate = vi.fn();
const contains = vi.fn();
const cookieGet = vi.fn();
const getDynamicRules = vi.fn();
const updateDynamicRules = vi.fn();
const fetchMock = vi.fn();
const tabsCreate = vi.fn();
const runtimeSendMessage = vi.fn();
const permissionsRemove = vi.fn();
/** By default the browser refuses a prompt without a gesture, as Firefox does from a runtime message. */
const permissionsRequest = vi.fn();
let session: Record<string, unknown>;
const sessionSet = vi.fn();
const setBadgeText = vi.fn();
const setBadgeBackgroundColor = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  storage = { rule_index: [SEEDED.ruleId], [`rule:${SEEDED.ruleId}`]: chromeStored(SEEDED) };
  local.get.mockImplementation(async (keys: string | string[] | null) => {
    if (keys === null) return chromeStored(storage);
    return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((key) => key in storage).map((key) => [key, chromeStored(storage[key])]));
  });
  local.set.mockImplementation(async (values: Record<string, unknown>) => void Object.assign(storage, chromeStored(values)));
  local.remove.mockImplementation(async (keys: string | string[]) => (typeof keys === 'string' ? [keys] : keys).forEach((key) => delete storage[key]));
  contains.mockResolvedValue(true);
  cookieGet.mockResolvedValue({ value: 'fixture-cookie-value', httpOnly: false });
  getDynamicRules.mockResolvedValue([{ id: 1014 }]);
  updateDynamicRules.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  tabsCreate.mockResolvedValue({ id: 9 });
  runtimeSendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
  permissionsRemove.mockResolvedValue(true);
  permissionsRequest.mockRejectedValue(new Error('permissions.request may only be called from a user input handler'));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  session = {};
  sessionSet.mockImplementation(async (values: Record<string, unknown>) => void Object.assign(session, structuredClone(values)));
  setBadgeText.mockResolvedValue(undefined);
  setBadgeBackgroundColor.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('browser', {
    runtime: { id: 'qts', getURL: (path = '/') => `chrome-extension://qts${path}`, sendMessage: runtimeSendMessage },
    storage: { local, session: { set: sessionSet } },
    action: { setBadgeText, setBadgeBackgroundColor },
    alarms: { create: alarmsCreate },
    tabs: { create: tabsCreate },
    permissions: { contains, remove: permissionsRemove, request: permissionsRequest },
    cookies: { get: cookieGet },
    declarativeNetRequest: { getDynamicRules, updateDynamicRules },
  });
  router = await import('../runtime-router');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A trusted message: dispatched (true) and answered once the handler settles. */
async function send(message: unknown): Promise<unknown> {
  const reply = vi.fn();
  expect(router.onRuntimeMessage(message, PAGE, reply)).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
  return reply.mock.calls[0]?.[0];
}

/** An untrusted message: answered at once with the bridge error, before any handler, storage or browser API runs. */
async function refuse(message: unknown, sender: BridgeSender, error: string): Promise<void> {
  const before = structuredClone(storage);
  const reply = vi.fn();
  expect(router.onRuntimeMessage(message, sender, reply)).toBe(false);
  expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: false, error });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reply).toHaveBeenCalledOnce();
  for (const api of [
    local.get,
    local.set,
    local.remove,
    alarmsCreate,
    contains,
    cookieGet,
    getDynamicRules,
    updateDynamicRules,
    fetchMock,
    tabsCreate,
    runtimeSendMessage,
    permissionsRemove,
    sessionSet,
    setBadgeText,
  ]) {
    expect(api).not.toHaveBeenCalled();
  }
  expect(storage).toEqual(before);
  expect(session).toEqual({});
}

describe('reprice scheduler messages from untrusted senders', () => {
  describe.each([
    ['register_rule', { type: 'site:register_rule', data: requestSafeRepriceActivation(webRule('42')) }],
    ['cancel_rule', { type: 'site:cancel_rule', data: { ruleId: SEEDED.ruleId } }],
    ['list_rules', { type: 'site:list_rules' }],
  ])('%s', (_name, message) => {
    it.each(UNTRUSTED)('is refused from %s', async (_sender, sender, error) => {
      await refuse(message, sender, error);
    });
  });

  it('accepts the same messages from the web app tab (control)', async () => {
    expect(await send({ type: 'site:register_rule', data: requestSafeRepriceActivation(webRule('42')) })).toEqual({ ok: true, data: null });
    expect(await send({ type: 'site:list_rules' })).toMatchObject({ ok: true, data: { rules: [{ ruleId: '41:cs.money' }, { ruleId: '42:cs.money', active: true }] } });
    expect(await send({ type: 'site:cancel_rule', data: { ruleId: SEEDED.ruleId } })).toEqual({ ok: true, data: null });
    expect(storage['rule_index']).toEqual(['42:cs.money']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a rule whose write is not a schedulable operation, even from the web app tab', async () => {
    const rule = requestSafeRepriceActivation({ ...webRule('42'), template: { ...webRule('42').template, url: 'https://evil.test/1.0/market/sell-orders' } });
    expect(await send({ type: 'site:register_rule', data: rule })).toEqual({ ok: false, error: 'operation_refused:host' });
    expect(Object.keys(storage).toSorted()).toEqual(['rule:41:cs.money', 'rule_index']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a rule whose write is a purchase (QUICK-226: buy operations are the executor’s only)', async () => {
    const template = { ...webRule('42').template, url: 'https://cs.money/1.0/market/purchase', body: '{"items":[{"id":"1","price":1}]}' };
    const rule = requestSafeRepriceActivation({ ...webRule('42'), template });
    expect(await send({ type: 'site:register_rule', data: rule })).toEqual({ ok: false, error: 'operation_refused:purpose' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('market buys through the entry point (QUICK-226)', () => {
  const BUY = {
    requestId: 'b1',
    attemptId: '00000000-0000-4000-8000-000000000001',
    source: 'csfloat',
    listingId: '813296748293324890',
    priceCents: 26800,
    origin: { kind: 'manual' },
  };

  it.each(UNTRUSTED)('is refused from %s', async (_sender, sender, error) => {
    await refuse({ type: 'site:market_buy', data: BUY }, sender, error);
  });

  it.each([
    ['the apex, which serves only the landing', 'https://quicktrade.skin'],
    ['the apex over Firefox (no sender origin)', undefined],
  ])('is refused from %s at the bridge, before any read or claim', async (_name, origin) => {
    const apex: BridgeSender = { ...PAGE, origin, url: 'https://quicktrade.skin/market' };
    const reply = vi.fn();
    expect(router.onRuntimeMessage({ type: 'site:market_buy', data: BUY }, apex, reply)).toBe(false);
    expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'bridge_forbidden_origin' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(contains).not.toHaveBeenCalled();
  });

  it('answers a malformed request with its requestId and sends nothing', async () => {
    expect(await send({ type: 'site:market_buy', data: { ...BUY, priceCents: 268.5 } })).toMatchObject({
      ok: true,
      data: { requestId: 'b1', outcome: 'not_sent', reason: 'invalid_request', sent: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('page DNR rules through the entry point', () => {
  it.each([
    ['a credential header', { ...DNR_RULE, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'set', value: 'session=fixture' }] } }, 'header_not_allowed'],
    ['a blocking action', { ...DNR_RULE, action: { type: 'block' } }, 'action_not_allowed'],
    ['a background-owned id', { ...DNR_RULE, id: 1014 }, 'id_out_of_range'],
    ['a domain-wide filter', { ...DNR_RULE, condition: { ...DNR_RULE.condition, urlFilter: '||cs.money/' } }, 'url_filter_not_allowed'],
    ['top-level navigations', { ...DNR_RULE, condition: { ...DNR_RULE.condition, resourceTypes: ['main_frame'] } }, 'resource_type_not_allowed'],
    ['a regex condition', { ...DNR_RULE, condition: { ...DNR_RULE.condition, regexFilter: '.*' } }, 'condition_not_allowed'],
  ])('refuses %s without touching the browser rules', async (_name, rule, reason) => {
    expect(await send({ type: 'site:set_dnr_rules', data: { rules: [rule] } })).toEqual({ ok: true, data: { status: 'rejected', installedIds: [], rejected: [{ id: rule.id, reason }] } });
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });

  it.each(['app.quicktrade.skin', 'quicktrade.skin', 'qts'])('refuses a rule for the web app or extension host %s even though permissions.contains says yes', async (host) => {
    const rule = { ...DNR_RULE, condition: { ...DNR_RULE.condition, urlFilter: `|https://${host}/` } };
    expect(await send({ type: 'site:set_dnr_rules', data: { rules: [rule] } })).toMatchObject({ ok: true, data: { status: 'rejected', installedIds: [] } });
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });

  it('refuses a host the user has not granted', async () => {
    contains.mockResolvedValue(false);
    expect(await send({ type: 'site:set_dnr_rules', data: { rules: [DNR_RULE] } })).toEqual({
      ok: true,
      data: { status: 'rejected', installedIds: [], rejected: [{ id: 2001, reason: 'host_not_granted' }] },
    });
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });

  it('installs a valid rule from the web app tab (control)', async () => {
    expect(await send({ type: 'site:set_dnr_rules', data: { rules: [DNR_RULE] } })).toEqual({ ok: true, data: { status: 'ok', installedIds: [2001], rejected: [] } });
    expect(updateDynamicRules).toHaveBeenCalledOnce();
  });

  it.each(UNTRUSTED)('refuses a valid rule from %s', async (_sender, sender, error) => {
    await refuse({ type: 'site:set_dnr_rules', data: { rules: [DNR_RULE] } }, sender, error);
  });
});

describe('proxy requests outside the allowlist through the entry point', () => {
  it.each([
    ['plain http', 'csfloat.com', { url: CSFLOAT_SEARCH.replace('https:', 'http:'), method: 'GET' }, 'invalid_url'],
    ['an unknown platform', 'evil.market', { url: CSFLOAT_SEARCH, method: 'GET' }, 'unknown_platform'],
    ['a foreign host', 'csfloat.com', { url: 'https://evil.test/api/v1/listings', method: 'GET' }, 'host'],
    ["another platform's host", 'csfloat.com', { url: 'https://cs.money/1.0/market/history', method: 'GET' }, 'host'],
    ['an unlisted path', 'csfloat.com', { url: 'https://csfloat.com/api/v1/me/api-keys', method: 'GET' }, 'path'],
    ['another method', 'csfloat.com', { ...CSFLOAT_EDIT, method: 'PUT' }, 'method'],
    ['an extra query key', 'csfloat.com', { url: `${CSFLOAT_SEARCH}&redirect=1`, method: 'GET' }, 'query'],
    ['a page-supplied Cookie header', 'csfloat.com', { ...CSFLOAT_EDIT, headers: { 'Content-Type': 'application/json', Cookie: 'session=fixture' } }, 'header'],
    [
      'a CSFloat purchase (QUICK-226)',
      'csfloat.com',
      { url: 'https://csfloat.com/api/v1/listings/buy', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"total_price":1,"contract_ids":["1"]}' },
      'purpose',
    ],
    [
      'a cs.money purchase (QUICK-226)',
      'cs.money',
      { url: 'https://cs.money/1.0/market/purchase', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"items":[{"id":"1","price":0.01}]}' },
      'purpose',
    ],
    [
      'a cs.money bot hold (QUICK-226)',
      'cs.money',
      { url: 'https://cs.money/2.0/send-offer', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"skins":{"bot":[],"user":[]},"balance":-1}' },
      'purpose',
    ],
    [
      'a cs.money bot confirmation (QUICK-226)',
      'cs.money',
      { url: 'https://cs.money/confirm_virtual_offer', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"offer_id":"1","action":"confirm"}' },
      'purpose',
    ],
    [
      'an internal token-minting operation',
      'white.market',
      {
        url: 'https://api.white.market/graphql/api',
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-accept-language': 'en' },
        body: JSON.stringify({ query: 'mutation AuthToken { auth_token { accessToken } }', variables: {}, operationName: 'AuthToken' }),
      },
      'purpose',
    ],
  ])('refuses %s before any network call', async (_name, platform, request, reason) => {
    expect(await send({ type: 'site:proxy_request', data: { requestId: 'r1', platform, request } })).toEqual({
      ok: true,
      data: { requestId: 'r1', ok: false, status: 403, data: null, error: `operation_refused:${reason}` },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('sends an allowlisted request from the web app tab (control)', async () => {
    expect(await send({ type: 'site:proxy_request', data: { requestId: 'r1', platform: 'csfloat.com', request: { url: CSFLOAT_SEARCH, method: 'GET' } } })).toMatchObject({
      ok: true,
      data: { requestId: 'r1', ok: true, status: 200 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(UNTRUSTED)('refuses an allowlisted request from %s', async (_sender, sender, error) => {
    await refuse({ type: 'site:proxy_request', data: { requestId: 'r1', platform: 'csfloat.com', request: { url: CSFLOAT_SEARCH, method: 'GET' } } }, sender, error);
  });
});

describe('cookie reads through the entry point', () => {
  it('refuses an allowlisted cookie the browser reports as HttpOnly, without its value', async () => {
    cookieGet.mockResolvedValue({ value: 'fixture-private-session', httpOnly: true });
    const reply = await send({ type: 'site:get_cookie', data: { requestId: 'c1', url: 'https://shadowpay.com', name: 'XSRF-TOKEN' } });
    expect(reply).toEqual({ ok: true, data: { requestId: 'c1', value: null, error: 'cookie_http_only' } });
    expect(JSON.stringify(reply)).not.toContain('fixture-private');
  });

  it.each([
    ['https://steamcommunity.com', 'steamLoginSecure'],
    ['https://csfloat.com', 'session'],
    ['https://cs.money', 'csgo_ses'],
    ['https://white.market', 'access-token'],
    ['https://www.haloskins.com', 'cf_clearance'],
    ['https://shadowpay.com.evil.test', 'XSRF-TOKEN'],
  ])('refuses %s / %s before reading any cookie', async (url, name) => {
    expect(await send({ type: 'site:get_cookie', data: { requestId: 'c1', url, name } })).toEqual({ ok: true, data: { requestId: 'c1', value: null, error: 'cookie_not_allowed' } });
    expect(cookieGet).not.toHaveBeenCalled();
    expect(contains).not.toHaveBeenCalled();
  });

  it('reads an allowlisted, page-readable cookie from the web app tab (control)', async () => {
    expect(await send({ type: 'site:get_cookie', data: { requestId: 'c1', url: 'https://shadowpay.com', name: 'XSRF-TOKEN' } })).toEqual({
      ok: true,
      data: { requestId: 'c1', value: 'fixture-cookie-value' },
    });
  });

  it.each(UNTRUSTED)('refuses an allowlisted, page-readable cookie from %s', async (_sender, sender, error) => {
    await refuse({ type: 'site:get_cookie', data: { requestId: 'c1', url: 'https://shadowpay.com', name: 'XSRF-TOKEN' } }, sender, error);
  });
});

describe('platform statuses through the entry point (QUICK-202)', () => {
  const CATALOG = [{ id: 'cs.money', label: 'CS.Money', origins: ['https://cs.money/*'], loginCheck: { kind: 'cookie', url: 'https://cs.money', name: 'steamid' } }];

  it.each(UNTRUSTED)('is refused from %s', async (_sender, sender, error) => {
    await refuse({ type: 'site:get_platform_statuses', data: { requestId: 's1', platforms: ['cs.money'] } }, sender, error);
  });

  it('answers the web app tab with status-only rows for known ids, echoing its request id (control)', async () => {
    storage['qts_platform_catalog'] = CATALOG;
    const reply = await send({ type: 'site:get_platform_statuses', data: { requestId: 's1', platforms: ['evil.test', 'cs.money', 'cs.money', 'constructor'] } });
    expect(reply).toEqual({ ok: true, data: { requestId: 's1', statuses: [{ platform: 'cs.money', permission: 'granted', login: 'logged-in', evidence: 'cookie', checkedAt: NOW }] } });
    expect(JSON.stringify(reply)).not.toContain('fixture-cookie-value');
    expect(cookieGet).toHaveBeenCalledExactlyOnceWith({ url: 'https://cs.money', name: 'steamid' });
  });

  it('never turns a published cookie check into a cookie oracle', async () => {
    storage['qts_platform_catalog'] = [{ ...CATALOG[0], loginCheck: { kind: 'cookie', url: 'https://cs.money', name: 'csgo_ses' } }];
    const reply = await send({ type: 'site:get_platform_statuses', data: { requestId: 's2', platforms: ['cs.money'] } });
    expect(reply).toMatchObject({ ok: true, data: { statuses: [{ platform: 'cs.money', login: 'unknown', issue: 'check_refused' }] } });
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('checks every bundled platform when the page names none, and probes no origin it was not granted', async () => {
    contains.mockImplementation(async ({ origins }: { origins: string[] }) => origins.every((origin) => origin === 'https://cs.money/*'));
    const reply = (await send({ type: 'site:get_platform_statuses', data: { requestId: 's3' } })) as { data: { statuses: Array<{ platform: string; permission: string }> } };
    expect(reply.data.statuses).toHaveLength(22);
    expect(reply.data.statuses.filter((status) => status.permission === 'granted').map((status) => status.platform)).toEqual(['cs.money']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('connection commands through the entry point (QUICK-202)', () => {
  describe.each([
    ['open_connect', { type: 'site:open_connect', data: { platforms: ['tradeit.gg'], locale: 'ru' } }],
    ['disconnect_platforms', { type: 'site:disconnect_platforms', data: { platforms: ['tradeit.gg'] } }],
    ['set_ui_locale', { type: 'site:set_ui_locale', data: { locale: 'ru' } }],
  ])('%s', (_name, message) => {
    it.each(UNTRUSTED)('is refused from %s', async (_sender, sender, error) => {
      await refuse(message, sender, error);
    });
  });

  it('asks the browser at once from the page click, for the bundled domains of known ids only', async () => {
    permissionsRequest.mockResolvedValue(true);
    expect(await send({ type: 'site:open_connect', data: { platforms: ['https://*/*', 'evil.test', 'tradeit.gg'] } })).toEqual({
      ok: true,
      data: { opened: 'prompt' },
    });
    expect(permissionsRequest).toHaveBeenCalledExactlyOnceWith({ origins: ['https://tradeit.gg/*'] });
    expect(session).toEqual({});
    expect(setBadgeText).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('counts a declined prompt as asked: nothing waits for the toolbar icon', async () => {
    permissionsRequest.mockResolvedValue(false);
    expect(await send({ type: 'site:open_connect', data: { platforms: ['tradeit.gg'] } })).toEqual({ ok: true, data: { opened: 'prompt' } });
    expect(session).toEqual({});
  });

  it('keeps a toolbar request for known ids only, with the asking tab, and opens no page, when the browser will not ask from the page (control)', async () => {
    expect(await send({ type: 'site:open_connect', data: { platforms: ['https://*/*', 'evil.test', 'tradeit.gg', 'skinport.com'], locale: 'ru' } })).toEqual({
      ok: true,
      data: { opened: 'toolbar' },
    });
    expect(session['qts:pendingConnect']).toEqual({ platforms: ['tradeit.gg', 'skinport.com'], tabId: 2, expiresAt: NOW + 5 * 60 * 1000 });
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: '+' });
    expect(alarmsCreate).toHaveBeenCalledExactlyOnceWith('qts:pendingConnectExpiry', { when: NOW + 5 * 60 * 1000 });
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(storage).not.toHaveProperty('qts_site_locale');
    expect(contains).not.toHaveBeenCalled();
  });

  it('keeps nothing without a known platform', async () => {
    expect(await send({ type: 'site:open_connect', data: { platforms: ['https://*/*'], locale: 'xx' } })).toEqual({ ok: false, error: 'no_platforms' });
    expect(session).toEqual({});
    expect(setBadgeText).not.toHaveBeenCalled();
  });

  it('removes optional access to known platforms only (control)', async () => {
    expect(await send({ type: 'site:disconnect_platforms', data: { platforms: ['csfloat.com', 'evil.test', 'tradeit.gg'] } })).toEqual({ ok: true, data: { removed: ['tradeit.gg'] } });
    expect(permissionsRemove).toHaveBeenCalledExactlyOnceWith({ origins: ['https://tradeit.gg/*'] });
  });

  it('accepts the site locale and stores nothing: the extension has no page to translate (control)', async () => {
    expect(await send({ type: 'site:set_ui_locale', data: { locale: 'pt-BR' } })).toEqual({ ok: true, data: null });
    expect(storage).not.toHaveProperty('qts_site_locale');
    expect(local.set).not.toHaveBeenCalled();
  });
});

describe('the legacy popup request (QUICK-202)', () => {
  it('keeps a toolbar request for every platform the extension cannot reach, opening no page', async () => {
    contains.mockImplementation(async ({ origins }: { origins: string[] }) =>
      origins.every((origin) => ['https://cs.money/*', 'https://csfloat.com/*', 'https://steamcommunity.com/*', 'https://lis-skins.com/*'].includes(origin))
    );
    expect(await send({ type: 'site:open_popup' })).toEqual({ ok: true, data: { opened: 'toolbar' } });
    const platforms = (session['qts:pendingConnect'] as { platforms: string[] }).platforms;
    expect(platforms).toHaveLength(19);
    expect(platforms).toContain('lis-skins.com');
    expect(platforms).not.toContain('cs.money');
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('keeps nothing when every platform is reachable', async () => {
    expect(await send({ type: 'site:open_popup' })).toEqual({ ok: false, error: 'no_platforms' });
    expect(session).toEqual({});
  });

  it.each(UNTRUSTED)('is refused from %s', async (_sender, sender, error) => {
    await refuse({ type: 'site:open_popup' }, sender, error);
  });
});
