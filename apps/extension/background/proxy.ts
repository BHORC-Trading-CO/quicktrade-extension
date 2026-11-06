// apps/extension/background/proxy.ts
import type { CookieResponsePayload, OperationAuth, OperationPurpose, OperationRefusal, OperationTable, PlatformOperation } from '@qts/contracts';
import { findPlatformOperation, followsOperationRedirects, isAllowedOperationRedirect, matchPlatformOperation, operationRefusedError } from '@qts/contracts';

import { cookieReadError } from './cookie-policy';
import { primeHaloSkinsForRequest } from './haloskins-service';
import { logOperationRefusal, resolveOperation } from './operation-policy';
import { getEffectiveOperationTable } from './operation-table-store';

export interface ProxyOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Cookie behaviour for the fetch. Defaults to `'include'`; `'omit'` for header-only APIs that 504/401 on the session cookie (DMarket). */
  credentials?: 'omit' | 'include';
  /** Platform whose operations (effective table: bundled or verified signed) the request must match (QUICK-171). */
  platform: string;
  /** Who asks: the page, a login probe or the scheduler; decides which operations may match. */
  purpose: OperationPurpose;
}

export interface ProxyResult {
  ok: boolean;
  status: number;
  data: unknown;
  /**
   * Raw response headers, forwarded verbatim to the web app. The extension does
   * not interpret these — the web side decides what (if anything) to read from
   * them (e.g. `x-ratelimit-reset` for rate-limit countdowns).
   */
  headers?: Record<string, string>;
  error?: string;
}

/** Origin-permission pattern for a URL, e.g. 'https://aim.market/v1/x' -> 'https://aim.market/*'. Null if unparseable. */
function originPattern(url: string): string | null {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

/** Page-facing cookie read: exact allowlist, granted origin and runtime HttpOnly defence. */
export async function getCookie(url: string, name: string, partitionKey?: unknown): Promise<Omit<CookieResponsePayload, 'requestId'>> {
  const error = cookieReadError(url, name, partitionKey);
  if (error) return { value: null, error };
  try {
    const permitted = await browser.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
    if (!permitted) return { value: null, error: 'cookie_permission_denied' };
    const cookie = await browser.cookies.get({ url, name });
    // Fail closed if a browser/mock omits the flag as well as when it is true.
    if (cookie && cookie.httpOnly !== false) return { value: null, error: 'cookie_http_only' };
    return { value: cookie?.value ?? null };
  } catch {
    return { value: null, error: 'cookie_read_failed' };
  }
}

/** A refused request: `status` 403 when nothing was sent, 0 when a redirect answer was withheld. */
function refused(refusal: OperationRefusal, status: number): ProxyResult {
  return { ok: false, status, data: null, error: operationRefusedError(refusal) };
}

/** `proxy_response.error` of a write answered by a 3xx (QUICK-292): it reached the marketplace, its effect is unknown. */
const REDIRECT_RESULT_UNKNOWN = 'redirect_result_unknown';

/**
 * A 3xx that `redirect: 'manual'` stopped (QUICK-292): its target was never contacted. A write's effect is unknown, like
 * a timeout's: status 0, never success, and never `operation_refused`, which callers read as "nothing was sent". A
 * read's answer is withheld, as a followed redirect's outside the allowlist is.
 */
function unfollowedRedirect(platform: string, operation: PlatformOperation, url: string, method: string | undefined, purpose: OperationPurpose): ProxyResult {
  const refusal: OperationRefusal = { reason: 'redirect', detail: operation.id };
  logOperationRefusal(platform, purpose, refusal, { url, method });
  return operation.mutates ? { ok: false, status: 0, data: null, error: REDIRECT_RESULT_UNKNOWN } : refused(refusal, 0);
}

// ─── Auth headers from marketplace cookies (QUICK-171) ─────────────────────────────────────────────

/** Tokens minted by an operation's `auth.refresh`, per cookie; kept in worker memory only. */
const mintedTokens = new Map<string, string>();
const minting = new Map<string, Promise<MintOutcome>>();

/** What a refresh produced: the token or none; `deniedOrigin` when its origin is not granted (nothing was sent). */
interface MintOutcome {
  token: string | null;
  deniedOrigin?: string;
}

type InitialToken = { token: string; minted: boolean } | { deniedOrigin: string } | null;

function authKey(platform: string, auth: OperationAuth): string {
  return `${platform}|${auth.cookieUrl}|${auth.cookie}`;
}

/** The token held in the auth cookie (a field of URL-encoded JSON for `jsonField`), or null. */
async function cookieToken(auth: OperationAuth): Promise<string | null> {
  try {
    if (!(await browser.permissions.contains({ origins: [`${new URL(auth.cookieUrl).origin}/*`] }))) return null;
    const value = (await browser.cookies.get({ url: auth.cookieUrl, name: auth.cookie }))?.value?.trim();
    if (!value) return null;
    if (!auth.jsonField) return value;
    const store: unknown = JSON.parse(decodeURIComponent(value));
    const token = typeof store === 'object' && store !== null ? (store as Record<string, unknown>)[auth.jsonField] : undefined;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

function readPath(data: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), data);
}

/**
 * Runs the internal refresh operation and caches the token it returns; the answer never leaves the background. Its
 * origin needs the user's grant like any proxied request (a signed table may point the refresh at another host of
 * the platform): a credentialed fetch never reaches an origin the user did not grant.
 */
async function mintToken(platform: string, auth: OperationAuth, table: OperationTable): Promise<MintOutcome> {
  const refresh = auth.refresh;
  const operation = refresh ? findPlatformOperation(platform, refresh.operation, table) : undefined;
  if (!refresh || !operation?.internal) return { token: null };
  const key = authKey(platform, auth);
  const pending = minting.get(key);
  if (pending) return pending;
  const run = (async (): Promise<MintOutcome> => {
    const request = { url: `https://${operation.host}${operation.path}`, method: operation.method, headers: { ...refresh.headers }, body: refresh.body };
    if (!matchPlatformOperation(platform, request, { purpose: 'internal', table }).ok) return { token: null };
    try {
      const pattern = originPattern(request.url);
      if (!pattern || !(await browser.permissions.contains({ origins: [pattern] }))) return { token: null, deniedOrigin: pattern ?? request.url };
      const res = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, credentials: 'include', redirect: 'error' });
      const token = res.ok ? readPath(await res.json(), refresh.tokenPath) : undefined;
      if (typeof token !== 'string' || !token) {
        mintedTokens.delete(key);
        return { token: null };
      }
      mintedTokens.set(key, token);
      return { token };
    } catch {
      mintedTokens.delete(key);
      return { token: null };
    }
  })().finally(() => minting.delete(key));
  minting.set(key, run);
  return run;
}

function authHeaderValue(auth: OperationAuth, token: string): string {
  return auth.format === 'bearer' ? `Bearer ${token}` : token;
}

/** A newer minted token wins over the (possibly expired) cookie; without either, mint one when the operation can. */
async function initialToken(platform: string, auth: OperationAuth, table: OperationTable): Promise<InitialToken> {
  const cached = auth.refresh ? mintedTokens.get(authKey(platform, auth)) : undefined;
  if (cached) return { token: cached, minted: false };
  const fromCookie = await cookieToken(auth);
  if (fromCookie) return { token: fromCookie, minted: false };
  const fresh = await mintToken(platform, auth, table);
  if (fresh.deniedOrigin) return { deniedOrigin: fresh.deniedOrigin };
  return fresh.token ? { token: fresh.token, minted: true } : null;
}

/** The refusal for an origin the user has not granted (nothing was sent there). */
function permissionDenied(pattern: string): ProxyResult {
  return { ok: false, status: 403, data: null, error: `permission_denied: ${pattern}` };
}

async function readResult(res: Response): Promise<ProxyResult> {
  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
  const data: unknown = isJson ? await res.json() : await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { ok: res.ok, status: res.status, data, headers };
}

async function execute(platform: string, operation: PlatformOperation, table: OperationTable, url: string, options: ProxyOptions): Promise<ProxyResult> {
  const headers: Record<string, string> = { ...options.headers };
  const auth = operation.auth;
  let token: { token: string; minted: boolean } | null = null;
  if (auth) {
    const initial = await initialToken(platform, auth, table);
    if (initial && 'deniedOrigin' in initial) return permissionDenied(initial.deniedOrigin);
    token = initial;
    if (!token) return { ok: false, status: 401, data: null, error: operationRefusedError({ reason: 'auth_unavailable' }) };
    headers[auth.header] = authHeaderValue(auth, token.token);
  }
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    // A GraphQL body goes out exactly as it was checked: re-serialized, so a duplicate key cannot mean one
    // document to the matcher (JSON.parse keeps the last) and another to the server.
    body: operation.graphql && options.body !== undefined ? JSON.stringify(JSON.parse(options.body)) : options.body,
    credentials: operation.credentials ?? options.credentials ?? 'include',
    // QUICK-292: only a declared read redirect is followed (and its answer re-checked below). Anything else stops at
    // its own 3xx, so no hop carries a write's body, the background's auth header or the page's headers anywhere.
    redirect: followsOperationRedirects(operation) ? 'follow' : 'manual',
  };
  let res = await fetch(url, init);
  // A rejected token is refreshed once (white.market's access token lives minutes).
  if (res.status === 401 && auth?.refresh && token && !token.minted) {
    mintedTokens.delete(authKey(platform, auth));
    const fresh = await mintToken(platform, auth, table);
    if (fresh.token) {
      headers[auth.header] = authHeaderValue(auth, fresh.token);
      res = await fetch(url, init);
    }
  }
  if (res.type === 'opaqueredirect') return unfollowedRedirect(platform, operation, url, init.method, options.purpose);
  // A declared read redirect was followed by the browser; an answer from outside the allowlist is withheld.
  if (res.redirected && !isAllowedOperationRedirect(platform, operation, res.url, table)) {
    const refusal: OperationRefusal = { reason: 'redirect', detail: operation.id };
    logOperationRefusal(platform, options.purpose, refusal, { url: res.url, method: init.method });
    return refused(refusal, 0);
  }
  return readResult(res);
}

/**
 * Executes an outbound request for the web app, the login probe or the scheduler — but only when it is an
 * instance of an operation of `options.platform` in the effective table (QUICK-171) and the user has granted the origin
 * (checked at runtime via `browser.permissions.contains`). Auth headers that come from marketplace cookies
 * are added here; a page-supplied one is refused by the matcher.
 */
export async function proxyRequest(url: string, options: ProxyOptions): Promise<ProxyResult> {
  // One table for the whole request: the match, the auth refresh and the redirect re-check.
  const table = await getEffectiveOperationTable();
  const match = await resolveOperation(options.platform, { url, method: options.method ?? 'GET', headers: options.headers, body: options.body }, options.purpose, table);
  if (!match.ok) return refused(match.refusal, 403);
  const pattern = originPattern(url);
  const permitted = pattern ? await browser.permissions.contains({ origins: [pattern] }) : false;
  if (!permitted) return permissionDenied(pattern ?? url);
  try {
    // Fresh HaloSkins cookies must reach rule 1014 before the request leaves.
    await primeHaloSkinsForRequest(url);
    return await execute(options.platform, match.operation, table, url, options);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
