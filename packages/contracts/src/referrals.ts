/**
 * Referrals (QUICK-264, step 1): every account has an invite code; the link is the landing page with `?ref=<code>`.
 * A new account that joins with a code (through the link or typed in Settings) gets extra trial days on its Steam
 * trial; the code's owner gets paid days when that account first pays. Rewards are days of access, never money.
 * Defaults taken 06.11.2026 without the owner's answer (Plane QUICK-264); the numbers are these constants.
 * Behind the server's `REFERRALS_ENABLED` (admins always see it). Dates are ISO strings on the wire.
 */

/** Days added to the invited account's Steam trial (7 → 14 days in all). */
export const REFERRAL_INVITEE_TRIAL_DAYS = 7;
/** Paid days the code's owner gets when the invited account first pays. */
export const REFERRAL_INVITER_PAID_DAYS = 30;
/** An account can attach a code during this many days after it was created, and only before its first payment. */
export const REFERRAL_CLAIM_WINDOW_DAYS = 14;
/** Codes are this many characters from `REFERRAL_CODE_ALPHABET`. */
export const REFERRAL_CODE_LENGTH = 8;
/** Crockford-like: digits and capitals without 0 1 I L O U, so a code read aloud or retyped stays the same. */
export const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The query parameter that carries a code: `https://quicktrade.skin/?ref=<code>`, forwarded to the app's sign-up. */
export const REFERRAL_QUERY_PARAM = 'ref';

/** How the code reached the account: opened from an invite link, or typed in Settings. */
export type ReferralClaimVia = 'link' | 'code';

/**
 * What happened to the invited account's trial bonus: `applied` (added to the Steam trial), `pending_steam_link`
 * (added when the account links Steam and its trial starts), `not_eligible` (the Steam account's trial was started
 * by another QTS account, the bonus of this Steam account was already given, or the account already has billing).
 */
export type ReferralTrialBonusStatus = 'applied' | 'pending_steam_link' | 'not_eligible';

export interface ReferralReferredBy<TDate = string> {
  at: TDate;
  via: ReferralClaimVia;
  trialBonus: ReferralTrialBonusStatus;
}

/** `GET /api/referrals/me` for an account that has referrals. */
export interface ReferralSummary<TDate = string> {
  enabled: true;
  /** This account's own code (created on the first read). */
  code: string;
  inviteeTrialDays: number;
  inviterPaidDays: number;
  /** Accounts that joined with this code, and how many of them paid (each paid one gave `inviterPaidDays`). */
  invited: { signedUp: number; paid: number };
  /** Paid days this account earned from invites (revoked rewards excluded). */
  earnedDays: number;
  /** Set when this account joined with someone's code; null otherwise. */
  referredBy: ReferralReferredBy<TDate> | null;
  /** True while this account may still attach a code (no code yet, inside the window, no payment). */
  canClaim: boolean;
  /** The last moment a code can be attached; null when `canClaim` is false. */
  claimDeadline: TDate | null;
}

/** `GET /api/referrals/me`: `{ enabled: false }` when referrals are off for this account (the web hides them). */
export type ReferralMeResponse<TDate = string> = { enabled: false } | ReferralSummary<TDate>;

/** `POST /api/referrals/claim`. */
export interface ReferralClaimRequest {
  code: string;
  via: ReferralClaimVia;
}

/** `POST /api/referrals/claim` 200: the code is attached (a repeat with the same code answers the same). */
export interface ReferralClaimResponse<TDate = string> {
  referredBy: ReferralReferredBy<TDate>;
}

/**
 * `POST /api/referrals/claim` refusals, as the error `message`: 404 `referrals_disabled`, 400 `referral_code_invalid`
 * (not a code's shape), 404 `referral_code_not_found`, 409 `referral_own_code`, 409 `referral_already_set` (another
 * code is attached), 409 `referral_window_closed` (the account is older than the window), 409 `referral_account_paid`
 * (the account already has a payment).
 */
export type ReferralClaimErrorCode =
  | 'referrals_disabled'
  | 'referral_code_invalid'
  | 'referral_code_not_found'
  | 'referral_own_code'
  | 'referral_already_set'
  | 'referral_window_closed'
  | 'referral_account_paid';

const CODE_CHARS = new Set(REFERRAL_CODE_ALPHABET);

/**
 * The one spelling of a code: trimmed, upper-case, spaces and dashes removed. Null when the result is not
 * `REFERRAL_CODE_LENGTH` characters of `REFERRAL_CODE_ALPHABET`.
 */
export function normalizeReferralCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== REFERRAL_CODE_LENGTH) return null;
  for (const char of code) if (!CODE_CHARS.has(char)) return null;
  return code;
}
