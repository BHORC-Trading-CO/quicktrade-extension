/**
 * The Steam floor of a signed operation table (owner decision, signed-operation-table review).
 *
 * A signed table may carry operations on Steam hosts, but only within this bundled allowlist: one rule per host,
 * method and path pattern. It ships with the extension and no signature can widen it. Everything else on
 * `steamcommunity.com`, `*.steampowered.com` or `*.steamstatic.com` is refused for signed tables (login, account,
 * profile edit, API key, market listing, trade-offer decline/cancel, and the `store.`, `help.`, `checkout.`, `login.`
 * hosts). Bundled `PLATFORM_OPERATIONS` are not subject to it (they ship with a release), but every bundled Steam
 * operation must stay representable here, so signing the bundled table as is always passes (extension test).
 *
 * A signed Steam operation fits a rule when the host and method are equal, its path pattern is contained in the
 * rule's (segment by segment: equal literals, a literal the rule's parameter type accepts, or a parameter of the same
 * or a narrower type: `int` within `id`), its body kind is one the rule lists, `mutates` equals the rule's, its query
 * keys and header names are subsets of the rule's, `credentials` equals the rule's (absent: the browser session), every
 * `redirects` pattern is contained in one of the rule's, and it has no `auth`, `internal`, `graphql` or `schedule`
 * (Steam cookies stay with the browser's own session; the scheduler never writes to Steam). Pure, no browser APIs.
 *
 * To allow another Steam endpoint: add a rule here (an extension release), never in a signed table.
 */
import { matchOperationPath } from './operation-policy';
import type { PlatformOperation } from './operation-types';

/** Hosts (exact or any subdomain) whose signed operations must fit `STEAM_SIGNED_OPERATION_ALLOWLIST`. */
export const STEAM_HOSTS: readonly string[] = ['steamcommunity.com', 'steampowered.com', 'steamstatic.com'];

export interface SteamSignedOperationRule {
  /** Exact host (no subdomain matching). */
  host: string;
  method: PlatformOperation['method'];
  /** Path pattern in the matcher's syntax; a signed operation's path must be contained in it. */
  path: string;
  body: readonly PlatformOperation['body'][];
  mutates: boolean;
  /** Query keys a signed operation may allow (its `query` a subset); none when absent. */
  query?: readonly string[];
  /** Header names (lower case) a signed operation may allow (its `headers` a subset); none when absent. */
  headers?: readonly string[];
  /** The operation's `credentials`, pinned: a signed operation must declare exactly this (absent: none). */
  credentials?: PlatformOperation['credentials'];
  /** Redirect patterns a signed operation may declare (each contained in one of these); none when absent. */
  redirects?: readonly string[];
}

const LOGIN_REDIRECT = '/login/home/';

/** Redirects of the profile-scoped history pages: Steam sends `/profiles/<id>/x/` to `/id/<vanity>/x` (no slash). */
function profileRedirects(page: string): readonly string[] {
  return [`/id/{vanity:id}/${page}`, `/id/{vanity:id}/${page}/`, LOGIN_REDIRECT];
}

export const STEAM_SIGNED_OPERATION_ALLOWLIST: readonly SteamSignedOperationRule[] = [
  // ─── steamcommunity.com: reads (every bundled Steam operation is one of these) ─────────────────────
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/my/',
    body: ['none'],
    mutates: false,
    redirects: ['/id/{vanity:id}/', '/profiles/{steamId:int}/', LOGIN_REDIRECT],
  },
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/inventory/{steamId:int}/730/{contextId:int}',
    query: ['l', 'count', 'start_assetid'],
    body: ['none'],
    mutates: false,
  },
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/profiles/{steamId:int}/inventory/json/730/{contextId:int}',
    body: ['none'],
    mutates: false,
    redirects: [LOGIN_REDIRECT],
  },
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/market/search',
    query: ['appid', 'q', 'descriptions', 'l', 'count'],
    headers: ['accept'],
    body: ['none'],
    mutates: false,
  },
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/market/priceoverview/',
    query: ['appid', 'currency', 'market_hash_name'],
    body: ['none'],
    mutates: false,
  },
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/profiles/{steamId:int}/inventoryhistory/',
    query: ['ajax', 'l', 'app[]', 'cursor[time]', 'cursor[time_frac]', 'cursor[s]'],
    headers: ['x-requested-with'],
    body: ['none'],
    mutates: false,
    redirects: profileRedirects('inventoryhistory'),
  },
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/profiles/{steamId:int}/tradehistory/',
    query: ['l', 'after_time', 'after_trade'],
    body: ['none'],
    mutates: false,
    redirects: profileRedirects('tradehistory'),
  },
  // Retired by Steam (QUICK-307: it redirects to the incoming list) and no longer bundled, but kept: the signed tables
  // up to v4 still carry it, and a rule missing here would refuse such a whole table.
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/profiles/{steamId:int}/tradeoffers/completed/',
    query: ['l'],
    body: ['none'],
    mutates: false,
    redirects: profileRedirects('tradeoffers/completed'),
  },
  // The offer history that replaced it (QUICK-307, 1.13.0). Allowed here first, signed later (see below).
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/profiles/{steamId:int}/tradeoffers/sent/',
    query: ['history', 'l'],
    body: ['none'],
    mutates: false,
    redirects: profileRedirects('tradeoffers/sent'),
  },
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/profiles/{steamId:int}/tradeoffers/',
    query: ['history', 'l'],
    body: ['none'],
    mutates: false,
    redirects: profileRedirects('tradeoffers'),
  },
  // The Community Market history and the market front page (wallet currency), both trade-history reads. `norender=1`
  // asks the history for data instead of HTML. Allowed here first, signed later: an installed copy refuses a whole signed
  // table with a Steam query key its own allowlist lacks, so the table may name it only once this release is installed.
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/market/myhistory/render/',
    query: ['query', 'start', 'count', 'l', 'norender'],
    body: ['none'],
    mutates: false,
    redirects: ['/login/home/'],
  },
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/market/',
    query: ['l'],
    body: ['none'],
    mutates: false,
    redirects: ['/login/home/'],
  },
  // The trade-offer page (its partner and items, before accepting it).
  {
    host: 'steamcommunity.com',
    method: 'GET',
    path: '/tradeoffer/{tradeOfferId:int}/',
    query: ['l'],
    body: ['none'],
    mutates: false,
    redirects: [LOGIN_REDIRECT],
  },
  // ─── steamcommunity.com: trade-offer writes (auto-accept cs.money / CSFloat offers, CSFloat seller offers) ─
  {
    host: 'steamcommunity.com',
    method: 'POST',
    path: '/tradeoffer/{tradeOfferId:int}/accept',
    headers: ['content-type'],
    body: ['form'],
    mutates: true,
  },
  {
    host: 'steamcommunity.com',
    method: 'POST',
    path: '/tradeoffer/new/send',
    headers: ['content-type'],
    body: ['form'],
    mutates: true,
  },
  // ─── api.steampowered.com: trade-offer reads ─────────────────────────────────────────────────────────
  {
    host: 'api.steampowered.com',
    method: 'GET',
    path: '/IEconService/GetTradeOffers/v1/',
    query: [
      'access_token',
      'key',
      'get_sent_offers',
      'get_received_offers',
      'get_descriptions',
      'language',
      'active_only',
      'historical_only',
      'time_historical_cutoff',
      'cursor',
    ],
    body: ['none'],
    mutates: false,
  },
  {
    host: 'api.steampowered.com',
    method: 'GET',
    path: '/IEconService/GetTradeOffer/v1/',
    query: ['access_token', 'key', 'tradeofferid', 'language', 'get_descriptions'],
    body: ['none'],
    mutates: false,
  },
];

const PARAM = /^\{[A-Za-z]+:([a-z]+)\}$/;
/** Parameter types and the types they contain (`int` values are `id` values; not the reverse). */
const PARAM_WITHIN: Readonly<Record<string, readonly string[]>> = { int: ['int', 'id'], id: ['id'] };

function withinHost(host: string, parent: string): boolean {
  return host === parent || host.endsWith(`.${parent}`);
}

/** Whether `host` is a Steam host (exact or any subdomain of `STEAM_HOSTS`). */
export function isSteamHost(host: string): boolean {
  return STEAM_HOSTS.some((steam) => withinHost(host, steam));
}

/** Whether every path `inner` matches is also matched by `outer` (both in the matcher's pattern syntax). */
export function isPathPatternWithin(inner: string, outer: string): boolean {
  const innerSegments = inner.split('/');
  const outerSegments = outer.split('/');
  if (innerSegments.length !== outerSegments.length) return false;
  return outerSegments.every((segment, index) => {
    const candidate = innerSegments[index] ?? '';
    const outerParam = PARAM.exec(segment);
    const innerParam = PARAM.exec(candidate);
    if (!outerParam) return !innerParam && candidate === segment;
    if (innerParam) return (PARAM_WITHIN[innerParam[1] ?? ''] ?? []).includes(outerParam[1] ?? '');
    // A literal segment the rule's parameter accepts, checked by the matcher itself.
    return matchOperationPath(`/${segment}`, `/${candidate}`);
  });
}

function isSubset(values: readonly string[] | undefined, allowed: readonly string[] | undefined): boolean {
  return (values ?? []).every((value) => (allowed ?? []).includes(value));
}

function fitsRule(operation: PlatformOperation, rule: SteamSignedOperationRule): boolean {
  return (
    operation.host === rule.host &&
    operation.method === rule.method &&
    isPathPatternWithin(operation.path, rule.path) &&
    rule.body.includes(operation.body) &&
    operation.mutates === rule.mutates &&
    isSubset(operation.query, rule.query) &&
    isSubset(operation.headers, rule.headers) &&
    operation.credentials === rule.credentials &&
    (operation.redirects ?? []).every((redirect) =>
      (rule.redirects ?? []).some((allowed) => isPathPatternWithin(redirect, allowed))
    )
  );
}

/** Whether a signed operation on a Steam host is allowed; any operation on another host is not judged here (true). */
export function isAllowedSteamSignedOperation(operation: PlatformOperation): boolean {
  if (!isSteamHost(operation.host)) return true;
  if (operation.auth || operation.internal || operation.graphql || operation.schedule) return false;
  return STEAM_SIGNED_OPERATION_ALLOWLIST.some((rule) => fitsRule(operation, rule));
}
