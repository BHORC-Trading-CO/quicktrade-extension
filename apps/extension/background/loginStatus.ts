// apps/extension/background/loginStatus.ts
import type { LoginCheck, LoginStatus, PlatformCatalogEntry, PlatformStatusIssue } from '@qts/contracts';
import { isConnectablePlatform, parseRetryAfter, PLATFORM_CONNECTIONS } from '@qts/contracts';

import { proxyRequest, type ProxyResult } from './proxy';

/** Read a nested value by dot-path (e.g. 'user.steam_id'). Returns undefined if any segment is missing. */
export function getJsonPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * What one login check observed (QUICK-202). Status only: built field by field, it never carries the response body,
 * a header, a cookie value or an account id.
 */
export interface LoginObservation {
  login: LoginStatus;
  evidence?: 'cookie' | 'request';
  issue?: PlatformStatusIssue;
  httpStatus?: number;
  retryAt?: number;
}

type RequestCheck = Extract<LoginCheck, { kind: 'request' }>;
type CheckAnswer = Pick<ProxyResult, 'status' | 'data' | 'headers' | 'error'>;

function unknown(issue: PlatformStatusIssue, httpStatus?: number): LoginObservation {
  return httpStatus === undefined ? { login: 'unknown', issue } : { login: 'unknown', issue, httpStatus };
}

/** A recognised challenge: Cloudflare marks one with `cf-mitigated: challenge`; cs.money answers 403 with error 4030. */
function isChallenge(answer: CheckAnswer): boolean {
  if (answer.headers?.['cf-mitigated']?.toLowerCase() === 'challenge') return true;
  const code = (answer.data as { errors?: Array<{ code?: unknown }> } | null | undefined)?.errors?.[0]?.code;
  return answer.status === 403 && code === 4030;
}

/**
 * Where a dot-path ends in a body: a truthy value, an explicit empty value on the way (null, false, 0, ''), or a key the
 * body does not have (another shape).
 */
function readPath(body: object, path: string): 'truthy' | 'empty' | 'missing' {
  let value: unknown = body;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || !(key in value)) return 'missing';
    value = (value as Record<string, unknown>)[key];
    if (!value) return 'empty';
  }
  return 'truthy';
}

/** A JSON object body, also when the proxy handed JSON back as text (SkinOut sends JSON as text/html); else null. */
function jsonObject(data: unknown): object | null {
  let body = data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

/**
 * Pure classification of a `request`-kind check answer, separated from IO so it is unit-testable. Only a verified
 * signal says logged out: a listed `loggedOutStatus`, HTTP 401, an ok answer whose `truthyPath` holds an explicit empty
 * value, or one that matches the documented `loggedOutMatch`. Server errors, 403, 429, network failures and answers of
 * another shape (one that lacks the path: `{}`, an error object) leave the login unknown and name the issue instead.
 */
export function classifyRequestResult(check: RequestCheck, answer: CheckAnswer, now: number): LoginObservation {
  const error = answer.error ?? '';
  if (error.startsWith('permission_denied')) return unknown('not_granted');
  // A redirect outside the allowlist was withheld (status 0): an answer the check cannot read.
  if (error === 'operation_refused:redirect') return unknown('unexpected');
  if (error.startsWith('operation_refused:')) return unknown('check_refused');
  // Status 0: the request never completed (offline, DNS, TLS, blocked); it proves nothing about the session.
  if (answer.status === 0) return unknown('network');
  if (isChallenge(answer)) return unknown('captcha', answer.status);
  if (check.loggedOutStatus?.includes(answer.status)) return { login: 'logged-out', evidence: 'request' };
  if ((check.okStatus ?? [200]).includes(answer.status)) {
    if (!check.truthyPath) return { login: 'logged-in', evidence: 'request' };
    const body = jsonObject(answer.data);
    if (!body) return unknown('unexpected', answer.status);
    const found = readPath(body, check.truthyPath);
    if (found === 'truthy') return { login: 'logged-in', evidence: 'request' };
    const match = check.loggedOutMatch;
    if (found === 'empty' || (match && getJsonPath(body, match.path) === match.equals)) return { login: 'logged-out', evidence: 'request' };
    return unknown('unexpected', answer.status);
  }
  if (answer.status === 401) return { login: 'logged-out', evidence: 'request' };
  if (answer.status === 429) {
    const delay = parseRetryAfter(answer.headers, now);
    return delay === null ? unknown('rate_limited', 429) : { ...unknown('rate_limited', 429), retryAt: now + delay };
  }
  if (answer.status >= 500) return unknown('server_error', answer.status);
  if (answer.status === 403) return unknown('blocked', 403);
  return unknown('unexpected', answer.status);
}

/** A cookie check may name only the bundled login cookie of its platform; the page-published catalog cannot widen it. */
function isBundledLoginCookie(platform: string, check: Extract<LoginCheck, { kind: 'cookie' }>): boolean {
  if (!isConnectablePlatform(platform)) return false;
  const bundled = PLATFORM_CONNECTIONS[platform].loginCookie;
  return bundled !== undefined && bundled.url === check.url && bundled.name === check.name;
}

/**
 * Run a single platform's login check. Gated by host permission (no permission → unknown, never red).
 * Never throws: a failure of the browser APIs resolves to unknown.
 */
export async function observeLogin(entry: PlatformCatalogEntry): Promise<LoginObservation> {
  const check = entry.loginCheck;
  if (!check) return unknown('no_check');
  if (check.kind === 'cookie' && !isBundledLoginCookie(entry.id, check)) return unknown('check_refused');
  try {
    const permitted = await browser.permissions.contains({ origins: entry.origins });
    if (!permitted) return unknown('not_granted');

    if (check.kind === 'cookie') {
      // Presence only: the value never leaves this function.
      const cookie = await browser.cookies.get({ url: check.url, name: check.name });
      return { login: cookie?.value ? 'logged-in' : 'logged-out', evidence: 'cookie' };
    }

    // Cross-origin probes rely on the DNR Origin/Referer rewrites the web app registers (set_dnr_rules); the status
    // service waits for queued installs first. The probe comes from the page-published catalog, so it must be a
    // non-mutating operation of this platform (QUICK-171); a refused probe is `check_refused`.
    const res = await proxyRequest(check.url, { method: check.method ?? 'GET', headers: check.headers, body: check.body, platform: entry.id, purpose: 'login' });
    return classifyRequestResult(check, res, Date.now());
  } catch {
    return unknown('unexpected');
  }
}

/** The tri-state login of one platform, for the bridge's legacy `login_statuses` answer and the popup. */
export async function checkLogin(entry: PlatformCatalogEntry): Promise<LoginStatus> {
  return (await observeLogin(entry)).login;
}

/**
 * Optional progress hooks so a caller (the popup) can show a per-site loader. `onStart` fires only
 * for entries that actually run a check (those with a `loginCheck`); `onResult` fires for every entry.
 */
export interface LoginCheckHooks {
  onStart?: (id: string) => void;
  onResult?: (id: string, status: LoginStatus) => void;
}

/**
 * Run every platform's check concurrently. Each platform is hit at most once, so there is no
 * per-platform rate-limit concern — the previous sequential 500 ms spacing only added latency.
 * `onStart` fires up-front for every checkable entry; `onResult` fires as each check resolves.
 */
export async function checkAllLogins(catalog: PlatformCatalogEntry[], hooks?: LoginCheckHooks): Promise<Record<string, LoginStatus>> {
  for (const entry of catalog) {
    if (entry.loginCheck) hooks?.onStart?.(entry.id);
  }
  const pairs = await Promise.all(
    catalog.map(async (entry) => {
      const status = await checkLogin(entry);
      hooks?.onResult?.(entry.id, status);
      return [entry.id, status] as const;
    })
  );
  return Object.fromEntries(pairs);
}
