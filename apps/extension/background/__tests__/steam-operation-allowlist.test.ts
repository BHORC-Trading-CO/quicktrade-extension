import type { PlatformOperation } from '@qts/contracts';
import { isAllowedSteamSignedOperation, isPathPatternWithin, isSteamHost, PLATFORM_OPERATIONS, STEAM_SIGNED_OPERATION_ALLOWLIST, validateOperationTableDocument } from '@qts/contracts';
import { describe, expect, it } from 'vitest';

// The bundled Steam floor of a signed operation table (steam-operation-allowlist.ts): what a signature may carry on
// steamcommunity.com / *.steampowered.com / *.steamstatic.com, and everything it may not.

const NOW = 1_800_000_000_000;

function read(host: string, path: string, extra: Partial<PlatformOperation> = {}): PlatformOperation {
  return { id: 'steam.signed', method: 'GET', host, path, body: 'none', mutates: false, ...extra };
}

function write(path: string, extra: Partial<PlatformOperation> = {}): PlatformOperation {
  return { id: 'steam.signed-write', method: 'POST', host: 'steamcommunity.com', path, body: 'form', headers: ['content-type'], mutates: true, ...extra };
}

/** The verdict of the full document check on a table with this one Steam operation. */
function documentRefusal(operation: PlatformOperation): unknown {
  const parsed = validateOperationTableDocument({ version: 2, issuedAt: NOW, expiresAt: NOW + 1000, table: { 'steamcommunity.com': [operation] } });
  return parsed.ok ? null : parsed.refusal.reason;
}

describe('Steam allowlist for signed operation tables', () => {
  it('keeps every bundled Steam operation representable', () => {
    const steam = Object.values(PLATFORM_OPERATIONS)
      .flat()
      .filter((operation) => isSteamHost(operation.host));
    expect(steam.length).toBeGreaterThan(0);
    for (const operation of steam) expect(isAllowedSteamSignedOperation(operation), operation.id).toBe(true);
  });

  it('every rule is a valid operation pattern on an exact Steam host', () => {
    for (const rule of STEAM_SIGNED_OPERATION_ALLOWLIST) {
      expect(isSteamHost(rule.host), rule.path).toBe(true);
      expect(rule.mutates, rule.path).toBe(rule.method !== 'GET');
    }
  });

  it.each([
    ['accepting a trade offer', write('/tradeoffer/{tradeOfferId:int}/accept')],
    ['accepting with another parameter name', write('/tradeoffer/{id:int}/accept')],
    ['accepting one literal offer id', write('/tradeoffer/123456/accept')],
    ['sending a trade offer', write('/tradeoffer/new/send')],
    ['the trade-offer page', read('steamcommunity.com', '/tradeoffer/{id:int}/', { redirects: ['/login/home/'] })],
    ['the inventory', read('steamcommunity.com', '/inventory/{steamId:int}/730/2', { query: ['l', 'count'] })],
    ['the legacy profile inventory', read('steamcommunity.com', '/profiles/{steamId:int}/inventory/json/730/{contextId:int}')],
    ['GetTradeOffers', read('api.steampowered.com', '/IEconService/GetTradeOffers/v1/', { query: ['get_received_offers', 'active_only'] })],
    ['GetTradeOffer', read('api.steampowered.com', '/IEconService/GetTradeOffer/v1/', { query: ['tradeofferid'] })],
    ['a narrower redirect', read('steamcommunity.com', '/profiles/{steamId:int}/tradehistory/', { redirects: ['/id/{vanity:id}/tradehistory'] })],
    ['a subset of the rule query keys and headers', read('steamcommunity.com', '/market/search', { query: ['q'], headers: ['accept'] })],
    ['an accept without headers', write('/tradeoffer/{id:int}/accept', { headers: [] })],
  ])('allows %s', (_name, operation) => {
    expect(isAllowedSteamSignedOperation(operation)).toBe(true);
    expect(documentRefusal(operation)).toBeNull();
  });

  it.each([
    ['declining a trade offer', write('/tradeoffer/{id:int}/decline')],
    ['cancelling a trade offer', write('/tradeoffer/{id:int}/cancel')],
    ['a trailing slash on accept', write('/tradeoffer/{id:int}/accept/')],
    ['a missing trailing slash on the offer page', read('steamcommunity.com', '/tradeoffer/{id:int}')],
    ['an upper-case path', write('/TradeOffer/{id:int}/accept')],
    ['a wider parameter type', write('/tradeoffer/{id:id}/accept')],
    ['a literal the parameter type refuses', write('/tradeoffer/new/accept')],
    ['an accept declared as a read', write('/tradeoffer/{id:int}/accept', { mutates: false })],
    ['an accept as GET', read('steamcommunity.com', '/tradeoffer/{id:int}/accept')],
    ['an accept with a JSON body', write('/tradeoffer/{id:int}/accept', { body: 'json' })],
    ['an accept with cookie auth', write('/tradeoffer/{id:int}/accept', { auth: { cookieUrl: 'https://steamcommunity.com', cookie: 'sessionid', header: 'x-session', format: 'raw' } })],
    ['a scheduled accept', write('/tradeoffer/{id:int}/accept', { schedule: 'write' })],
    ['an internal operation', read('steamcommunity.com', '/my/', { internal: true })],
    ['a redirect outside the rule', read('steamcommunity.com', '/my/', { redirects: ['/account/'] })],
    ['a redirect on a write', write('/tradeoffer/new/send', { redirects: ['/login/home/'] })],
    ['the Web API key page', read('steamcommunity.com', '/dev/apikey')],
    ['registering a Web API key', write('/dev/registerkey')],
    ['the login page', read('steamcommunity.com', '/login/home/')],
    ['logging in', write('/login/dologin/')],
    ['account pages', read('steamcommunity.com', '/account/')],
    ['editing a vanity profile', write('/id/{vanity:id}/edit')],
    ['editing a profile', write('/profiles/{steamId:int}/edit')],
    ['selling on the market', write('/market/sellitem/')],
    ['removing a market listing', write('/market/removelisting/{id:int}')],
    ['the market on another method', write('/market/search')],
    ['another app inventory', read('steamcommunity.com', '/inventory/{steamId:int}/570/2')],
    ['a store host', read('store.steampowered.com', '/IEconService/GetTradeOffers/v1/')],
    ['a help host', read('help.steampowered.com', '/en/')],
    ['a checkout host', read('checkout.steampowered.com', '/checkout/')],
    ['a login host', read('login.steampowered.com', '/jwt/finalizelogin')],
    ['a subdomain of steamcommunity.com', read('www.steamcommunity.com', '/my/')],
    ['a CDN host', read('community.akamai.steamstatic.com', '/economy/image/x')],
    ['the Web API on steamcommunity.com', read('steamcommunity.com', '/IEconService/GetTradeOffers/v1/')],
    ['another Web API method', read('api.steampowered.com', '/IEconService/CancelTradeOffer/v1/')],
    ['a query key outside the rule', read('steamcommunity.com', '/inventory/{steamId:int}/730/2', { query: ['l', 'trading'] })],
    ['a query on a rule without query keys', read('steamcommunity.com', '/my/', { query: ['l'] })],
    ['another Web API query key', read('api.steampowered.com', '/IEconService/GetTradeOffer/v1/', { query: ['tradeofferid', 'steamid'] })],
    ['a header outside the rule', write('/tradeoffer/{id:int}/accept', { headers: ['content-type', 'x-requested-with'] })],
    ['a header on a rule without headers', read('steamcommunity.com', '/market/priceoverview/', { headers: ['accept'] })],
    ['credentials the rule does not pin', read('steamcommunity.com', '/market/priceoverview/', { credentials: 'omit' })],
  ])('refuses %s', (_name, operation) => {
    expect(isAllowedSteamSignedOperation(operation)).toBe(false);
    expect(documentRefusal(operation)).toBe('steam_operation');
  });

  it.each([
    ['a dot-dot segment', '/tradeoffer/{id:int}/accept/../decline'],
    ['a dot segment', '/tradeoffer/./new/send'],
    ['an encoded dot-dot', '/tradeoffer/%2e%2e/new/send'],
    ['an encoded slash', '/tradeoffer/new%2fsend'],
    ['a relative path', 'tradeoffer/new/send'],
    ['a query in the pattern', '/tradeoffer/new/send?x=1'],
  ])('refuses %s before the allowlist (the pattern itself is invalid)', (_name, path) => {
    expect(documentRefusal(write(path))).toBe('shape');
  });

  it.each(['SteamCommunity.com', 'steamcommunity.com.', '[::1]'])('refuses the host form %s', (host) => {
    expect(documentRefusal(read(host, '/my/'))).toBe('forbidden_host');
  });

  it('path containment: literal and parameter segments', () => {
    expect(isPathPatternWithin('/a/{x:int}/b', '/a/{y:id}/b')).toBe(true);
    expect(isPathPatternWithin('/a/{x:id}/b', '/a/{y:int}/b')).toBe(false);
    expect(isPathPatternWithin('/a/12/b', '/a/{y:int}/b')).toBe(true);
    expect(isPathPatternWithin('/a//b', '/a/{y:int}/b')).toBe(false);
    expect(isPathPatternWithin('/a/{x:int}/b', '/a/12/b')).toBe(false);
    expect(isPathPatternWithin('/a/b', '/a/b/')).toBe(false);
  });
});
