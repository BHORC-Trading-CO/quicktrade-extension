// apps/extension/background/market-buy/account-cache.ts
//
// QUICK-233 (R-F7): which marketplace account the executor last confirmed. A manual buy reads the account every time
// (QUICK-226); an automatic one may use a confirmation at most BUY_ORDER_ACCOUNT_TTL_MS old, so the listing's re-read is
// the only marketplace request before its buy request. A confirmation exists only after a read showed the session
// belongs to the linked Steam account (the check never fails open: a read that could not tell, or told another account,
// leaves none), and is dropped by any account error, a balance shortfall, another Steam account, or a change of the
// marketplace's session cookies (a sign-in, a sign-out, another account: `accountPlatformOfCookie`). A buy that may have
// spent lowers the balance it remembers, so the balance guard never trusts money that is gone.
import { BUY_ORDER_ACCOUNT_TTL_MS } from '@qts/contracts';

export type AccountPlatform = 'csfloat.com' | 'cs.money';

export interface AccountConfirmation {
  /** The balance left (USD cents) as the read said, minus buys since; null when the read named none. */
  balanceCents: number | null;
  /** When the read that confirmed it answered. */
  at: number;
}

interface Entry extends AccountConfirmation {
  steamId: string;
}

export class MarketAccountCache {
  private readonly entries = new Map<AccountPlatform, Entry>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number = BUY_ORDER_ACCOUNT_TTL_MS
  ) {}

  /** A confirmation of this Steam account younger than the TTL; null otherwise. */
  get(platform: AccountPlatform, steamId: string): AccountConfirmation | null {
    const entry = this.entries.get(platform);
    if (!entry || entry.steamId !== steamId) return null;
    const age = this.now() - entry.at;
    if (age < 0 || age >= this.ttlMs) {
      this.entries.delete(platform);
      return null;
    }
    return { balanceCents: entry.balanceCents, at: entry.at };
  }

  /** How old the confirmation of this Steam account is (ms); null without one. */
  age(platform: AccountPlatform, steamId: string): number | null {
    const entry = this.get(platform, steamId);
    return entry ? this.now() - entry.at : null;
  }

  put(platform: AccountPlatform, steamId: string, balanceCents: number | null): void {
    this.entries.set(platform, { steamId, balanceCents, at: this.now() });
  }

  /** A buy request that may have spent `cents` (bought, or its result unknown). */
  spend(platform: AccountPlatform, cents: number): void {
    const entry = this.entries.get(platform);
    if (!entry || entry.balanceCents === null) return;
    entry.balanceCents = Math.max(0, entry.balanceCents - cents);
  }

  invalidate(platform: AccountPlatform): void {
    this.entries.delete(platform);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Cookies of a marketplace session: any change of one may mean another account (or none) is signed in. Analytics and
 * Cloudflare cookies, which change all the time, are not among them; anything session-like is (dropping a confirmation
 * too often costs one account read, keeping a stale one could buy on the wrong account).
 */
const SESSION_COOKIE_NAME = /ses|steam|auth|token|login|user|sid|jwt|refresh|access|account/i;

/** The marketplace whose session this changed cookie belongs to (`cookies.onChanged`); null for any other cookie. */
export function accountPlatformOfCookie(cookie: { domain?: string; name?: string } | undefined): AccountPlatform | null {
  if (!cookie) return null;
  const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
  const platform: AccountPlatform | null = domain === 'csfloat.com' || domain.endsWith('.csfloat.com') ? 'csfloat.com' : domain === 'cs.money' || domain.endsWith('.cs.money') ? 'cs.money' : null;
  return platform && SESSION_COOKIE_NAME.test(cookie.name ?? '') ? platform : null;
}
