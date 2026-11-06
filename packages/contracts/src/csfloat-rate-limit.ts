// CSFloat's `x-ratelimit-*` model (QUICK-204), shared since QUICK-231: the web's sale form, Competitors and Market
// search read it per page, and the extension's live feed reads the same `/listings` bucket from every answer it relays.

export interface CsfloatRateLimit {
  limit: number;
  remaining: number;
  resetAt: number;
}

type Headers = Record<string, string> | undefined;

function headerInteger(headers: Headers, key: string): number | null {
  const value = headers?.[key]?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** `x-ratelimit-reset` as epoch seconds, not relative seconds or epoch milliseconds; null otherwise. */
function resetSeconds(headers: Headers): number | null {
  const reset = headerInteger(headers, 'x-ratelimit-reset');
  return reset === null || reset < 1_000_000_000 || reset >= 10_000_000_000 ? null : reset;
}

/** CSFloat forwards lower-case headers; x-ratelimit-reset is UNIX seconds (see parseResetAt).
 * A small delta is not that contract: reject it rather than inventing a reset deadline.
 */
export function parseCsfloatRateLimit(headers: Headers): CsfloatRateLimit | null {
  const limit = headerInteger(headers, 'x-ratelimit-limit');
  const remaining = headerInteger(headers, 'x-ratelimit-remaining');
  const reset = resetSeconds(headers);
  if (limit === null || limit <= 0 || remaining === null || remaining > limit || reset === null) return null;
  return { limit, remaining, resetAt: reset * 1000 };
}

export function isLowCsfloatBudget(budget: CsfloatRateLimit | null, now: number): boolean {
  return budget !== null && budget.resetAt > now && budget.remaining <= Math.max(3, budget.limit * 0.1);
}

/**
 * When a CSFloat 429 received at `now` ends, on this computer's clock; null when the answer names no reset.
 * Reads `x-ratelimit-reset` (UNIX seconds) and `retry-after` (seconds or an HTTP date) and takes the later one.
 * An absolute time is measured against the answer's `date` (CSFloat's own clock), so a computer clock that runs
 * fast or slow still waits until CSFloat's reset. The result may lie in the past; the caller decides what that means.
 */
export function csfloatRateLimitResetAt(headers: Headers, now: number): number | null {
  const serverNow = Date.parse(headers?.['date'] ?? '');
  const onOurClock = (serverTime: number) => (Number.isFinite(serverNow) ? now + serverTime - serverNow : serverTime);
  const candidates: number[] = [];
  const reset = resetSeconds(headers);
  if (reset !== null) candidates.push(onOurClock(reset * 1000));
  const retryAfter = headers?.['retry-after']?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) candidates.push(now + Number(retryAfter) * 1000);
  else if (retryAfter && isHttpDate(retryAfter)) candidates.push(onOurClock(Date.parse(retryAfter)));
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/** An HTTP date names its day and month (`Sun, 06 Nov 1994 08:49:37 GMT`); Date.parse alone also takes `-5` as a year. */
function isHttpDate(value: string): boolean {
  return /[a-z]/i.test(value) && Number.isFinite(Date.parse(value));
}
