import type { CookieReadError } from '@qts/contracts';

// Only JS-readable CSRF cookies the web's marketplace-sale flows echo as a header. Session tokens are
// deliberately absent: HaloSkins' stay in haloskins-service.ts, and the white.market `access-token`,
// aim.market `__user-store` and DMarket `dm-trade-token` are read by the background, which adds the auth
// header of an allowlisted operation itself (QUICK-171, OperationAuth in @qts/contracts).
const PAGE_COOKIES: Readonly<Record<string, readonly string[]>> = {
  'https://shadowpay.com': ['XSRF-TOKEN'],
  'https://buff.market': ['csrf_token'],
  'https://buff.163.com': ['csrf_token'],
};

export function cookieReadError(url: unknown, name: unknown, partitionKey: unknown): CookieReadError | null {
  if (typeof url !== 'string' || typeof name !== 'string') return 'cookie_not_allowed';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !PAGE_COOKIES[parsed.origin]?.includes(name)) return 'cookie_not_allowed';
    // No current page-readable cookie needs CHIPS. Do not accept caller-selected partitions.
    return partitionKey === undefined ? null : 'cookie_partition_not_allowed';
  } catch {
    return 'cookie_not_allowed';
  }
}
