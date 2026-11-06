// apps/extension/background/active-browser-model.ts
//
// QUICK-305: what this browser holds of the account's working-browser lease, pure. The IO is active-browser.ts.
import type { ActiveBrowserPush, ActiveBrowserRenewResult, ScheduledRule } from '@qts/contracts';

/** What storage.local keeps (`qts:active_browser`). */
export interface ActiveBrowserState {
  /** The account a page of this browser claimed for. */
  clerkId: string;
  /** The device token for that account; null until a page handed one over (or after the server forgot it). */
  token: string | null;
  holds: boolean;
  leaseId: string | null;
  /** On the server's clock. */
  expiresAt: number | null;
  /** The server's clock minus this computer's, from the last answer. */
  offsetMs: number;
  /** This computer's time of the last answer about the lease (a page's or a renew's). */
  answeredAt: number;
  /**
   * The last renew could not reach the server (no answer, a 5xx, a 429) while this browser held the lease: it keeps
   * working past `expiresAt` until the server answers. Nobody else can get the lease meanwhile, as every claim and
   * renew goes through that server.
   */
  unreachable?: boolean;
}

/** The server's clock minus this computer's, taking the answer as given halfway through the request. */
function offsetOf(serverNow: number, requestedAt: number, receivedAt: number): number {
  return serverNow - Math.round((requestedAt + receivedAt) / 2);
}

/**
 * Whether this extension runs scheduled rules at `now` (this computer's clock): always before a page told it about the
 * account's lease (an older web app, or none signed in yet: it works as before QUICK-305), else only while it holds a
 * live lease.
 */
export function isWorking(state: ActiveBrowserState | null, now: number): boolean {
  if (!state) return true;
  if (!state.holds || state.expiresAt === null) return false;
  return state.unreachable === true || now + state.offsetMs < state.expiresAt;
}

/** Markets whose own ramps the account keeps (QUICK-304): every browser of the account holds them. */
const ACCOUNT_RAMP_PLATFORMS: ReadonlySet<string> = new Set(['csfloat.com', 'cs.money']);

/**
 * A rule every browser of the account may hold: the user's own CSFloat / cs.money ramps (kept on the account, QUICK-304)
 * and what the market sync plans in any open tab (`origin: 'auto_sync'`: one-shots, continued ramps, price followers).
 * Only the working browser runs these. Anything else (a one-shot listing from the sale form, a ramp on another market,
 * a rule registered before rules carried an owner) lives in this browser alone and runs here whoever works.
 */
export function isAccountWideRule(rule: Pick<ScheduledRule, 'kind' | 'origin' | 'owner' | 'platform'>): boolean {
  if (rule.origin === 'auto_sync') return true;
  return (rule.kind === undefined || rule.kind === 'reprice') && !!rule.owner && ACCOUNT_RAMP_PLATFORMS.has(rule.platform);
}

/**
 * Whether this extension sends the rule's requests at `now`: a rule of this browser alone always; an account-wide one
 * only while this browser works, and only for the account it works for (a profile two accounts used keeps the other's
 * rules, which that account's working browser runs).
 */
export function mayRunRule(state: ActiveBrowserState | null, rule: Pick<ScheduledRule, 'kind' | 'origin' | 'owner' | 'platform'>, now: number): boolean {
  if (!state || !isAccountWideRule(rule)) return true;
  return isWorking(state, now) && (!rule.owner || rule.owner === state.clerkId);
}

/** The state after a page's claim answer. Another account's claim starts over (its token is not this account's). */
export function stateAfterPush(current: ActiveBrowserState | null, push: ActiveBrowserPush): ActiveBrowserState {
  const sameAccount = current?.clerkId === push.clerkId;
  // An answer to a claim sent before the newest answer this extension has (a slower tab, a renew in between) says
  // nothing new about the lease; only its token is taken.
  if (current && sameAccount && push.requestedAt < current.answeredAt) return push.token ? { ...current, token: push.token } : current;
  return {
    clerkId: push.clerkId,
    token: push.token ?? (sameAccount ? current.token : null),
    holds: push.holds,
    leaseId: push.leaseId,
    expiresAt: push.expiresAt,
    offsetMs: offsetOf(push.serverNow, push.requestedAt, push.receivedAt),
    answeredAt: push.receivedAt,
  };
}

/** The state after the extension's own renew. */
export function stateAfterRenew(current: ActiveBrowserState, result: ActiveBrowserRenewResult, requestedAt: number, receivedAt: number): ActiveBrowserState {
  return {
    ...current,
    holds: result.holds,
    leaseId: result.leaseId,
    expiresAt: result.expiresAt,
    offsetMs: offsetOf(result.serverNow, requestedAt, receivedAt),
    answeredAt: receivedAt,
    unreachable: false,
  };
}

/** A renew that got no usable answer: a holder keeps working until the server answers (see `unreachable`). */
export function stateUnreachable(current: ActiveBrowserState): ActiveBrowserState {
  return current.holds ? { ...current, unreachable: true } : current;
}

/** A renew the server answered 401: it does not know the token any more; the lease runs out as it would. */
export function stateWithoutToken(current: ActiveBrowserState): ActiveBrowserState {
  return { ...current, token: null };
}

/** Whether the extension should ask the server now: renewing a lease it works under, or checking on standby. */
export function isRenewDue(state: ActiveBrowserState | null, now: number, intervalMs: number): boolean {
  return !!state?.token && now - state.answeredAt >= intervalMs;
}

/** The stored value, or null when it is not one this build wrote. */
export function parseActiveBrowserState(value: unknown): ActiveBrowserState | null {
  if (typeof value !== 'object' || value === null) return null;
  const state = value as Partial<ActiveBrowserState>;
  if (typeof state.clerkId !== 'string' || typeof state.holds !== 'boolean') return null;
  if (state.token !== null && typeof state.token !== 'string') return null;
  if (state.leaseId !== null && typeof state.leaseId !== 'string') return null;
  if (state.expiresAt !== null && typeof state.expiresAt !== 'number') return null;
  if (typeof state.offsetMs !== 'number' || typeof state.answeredAt !== 'number') return null;
  return {
    clerkId: state.clerkId,
    token: state.token,
    holds: state.holds,
    leaseId: state.leaseId,
    expiresAt: state.expiresAt,
    offsetMs: state.offsetMs,
    answeredAt: state.answeredAt,
    ...(state.unreachable === true ? { unreachable: true } : {}),
  } as ActiveBrowserState;
}
