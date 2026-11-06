// apps/web/src/lib/platformIssue.ts
//
// Pure detection of platform-side problems in a competitor proxy response.
// Kept framework-free (no React) so it can be unit-tested in isolation and
// imported by the ExtensionProvider client component.

import type { ProxyResponse } from './platforms/types';

export type PlatformIssueKind = 'captcha' | 'rate-limited' | 'error';

export interface PlatformIssue {
  kind: PlatformIssueKind;
  /** Epoch ms when the issue was last observed. */
  at: number;
  /** Epoch ms when a rate limit is expected to clear (from `x-ratelimit-reset`/`retry-after`), if known. */
  resetAt?: number;
}

/**
 * cs.money answers some queries with HTTP 200 and a bare `{ "error": N }` body.
 * `error: 2` means "no listings match the filter" — a legitimate empty result
 * (e.g. a float range with no items), NOT a failure. Any other code is a real
 * platform-side error that must surface and must not poison the request cache.
 */
export const CSMONEY_EMPTY_RESULT_CODE = 2;

/**
 * Fallback rate-limit cooldown when a 429 carries no `x-ratelimit-reset`/`retry-after`
 * header (CSFloat sometimes omits it). Lets `isActiveRateLimit` gate further requests for
 * a sensible window so we stop hammering a limited platform instead of re-firing forever.
 */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

/** Reads cs.money's numeric `{ error: N }` body code, or null when the body is not that shape. */
export function csMoneyErrorCode(res: ProxyResponse): number | null {
  const error = (res?.data as { error?: unknown } | null | undefined)?.error;
  return typeof error === 'number' ? error : null;
}

/**
 * True when the response is HTTP 200 but logically a failure that must not be
 * cached (cs.money `{ error: N }` with N other than the benign empty-result code).
 */
export function isMaskedFailure(res: ProxyResponse): boolean {
  const code = csMoneyErrorCode(res);
  return code !== null && code !== CSMONEY_EMPTY_RESULT_CODE;
}

/**
 * Parse a rate-limit reset time (epoch ms) from forwarded response headers.
 * Prefers CSFloat's absolute `x-ratelimit-reset` (UNIX seconds); falls back to
 * the relative `retry-after` (seconds from now). Returns undefined if unknown.
 */
export function parseResetAt(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const reset = headers['x-ratelimit-reset'];
  if (reset) {
    const ms = Number(reset) * 1000;
    if (Number.isFinite(ms) && ms > Date.now()) return ms;
  }
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec) && sec > 0) return Date.now() + sec * 1000;
  }
  return undefined;
}

/**
 * True when a platform currently has a rate limit whose reset time is known and
 * still in the future. Callers use this to skip firing a request that would only
 * hit the limit again. Captcha/error blocks are intentionally excluded: they clear
 * only when the platform responds OK, so they must not gate the retry that clears them.
 */
export function isActiveRateLimit(issue: PlatformIssue | undefined, now: number): boolean {
  return issue?.kind === 'rate-limited' && issue.resetAt !== undefined && issue.resetAt > now;
}

/**
 * Detect a platform-side block in a proxy response:
 *  - cs.money Cloudflare captcha → HTTP 403 with `{ errors: [{ code: 4030 }] }`
 *  - generic rate limit → HTTP 429 (with reset time from headers, when present)
 *  - cs.money masked failure → HTTP 200 with `{ error: N }`, N other than the
 *    benign empty-result code (2)
 * Returns null for healthy responses, empty results, and unrelated errors
 * (e.g. 403 "domain not allowed").
 */
export function detectPlatformIssue(res: ProxyResponse): Omit<PlatformIssue, 'at'> | null {
  const code = (res?.data as { errors?: Array<{ code?: number }> } | null | undefined)?.errors?.[0]?.code;
  if (res.status === 403 && code === 4030) return { kind: 'captcha' };
  if (res.status === 429) return { kind: 'rate-limited', resetAt: parseResetAt(res.headers) };
  if (isMaskedFailure(res)) return { kind: 'error' };
  return null;
}
