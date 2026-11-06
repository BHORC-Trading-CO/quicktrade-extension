/**
 * The account's auto-reprice ramps (QUICK-304), kept on the server so that every browser's extension learns them. The
 * extension still does every write (marketplace sessions never leave the browser): the server keeps what to do, the
 * web of any browser registers what its extension lacks and cancels what the account cancelled.
 *
 * Only the user's own ramps on CSFloat and the cs.money market travel this way: one-shot listings and price followers
 * stay in the extension that holds them, and the market sync's continued ramps (`origin: 'auto_sync'`) are planned by
 * any open tab from the account's settings already (QUICK-296). A rule is described, not its request: each browser
 * rebuilds the request template from the platform, the item and the CSFloat listing id.
 */

/** Markets whose ramps are kept on the account: the two the extension reprices day by day. */
export type AccountRepriceRulePlatform = 'csfloat.com' | 'cs.money';

/**
 * `active`: the ramp runs (or waits for a safety-aware extension to activate it). `paused`: an extension paused it; no
 * browser takes it up. `retired`: it ended without a pause (sold, delisted, last step done). `cancelled`: the user
 * cancelled it, or a one-shot listing of the pair replaced it; every browser's extension drops it.
 */
export type AccountRepriceRuleState = 'active' | 'paused' | 'retired' | 'cancelled';

export interface AccountRepriceRule {
  /** `<itemId>:<platform>`, the extension's reprice rule id. */
  ruleId: string;
  platform: AccountRepriceRulePlatform;
  /** The Steam asset id the ramp reprices. */
  itemId: string;
  marketHashName: string;
  /** CSFloat's listing id, which the write URL carries; absent on cs.money. */
  listingId?: string;
  /** Platform-native units, as the extension stores them. */
  firstPrice: number;
  secondPrice: number;
  /** ms epoch. */
  startAt: number;
  days: number;
  /** The last step an extension reported applied; a browser taking the ramp up continues from it. */
  lastAppliedDay: number;
  schedule?: Array<{ at: number; price: number }>;
  /** ms epoch the ramp was created: a newer ramp of the pair replaces an older one. */
  createdAt: number;
  state: AccountRepriceRuleState;
  /** The extension's pause or retire reason, a code. */
  reason?: string;
  /** ms epoch the server last changed it; answers only. */
  updatedAt?: number;
}

/** `GET /api/reprice-rules`. */
export interface AccountRepriceRulesResponse {
  rules: AccountRepriceRule[];
}

/** `PUT /api/reprice-rules`: ramps as one extension holds them now. */
export interface AccountRepriceRulesWrite {
  rules: AccountRepriceRule[];
}

/** `POST /api/reprice-rules/cancel`: ramps the user cancelled; `createdAt` names the one, else the stored one goes. */
export interface AccountRepriceRulesCancel {
  rules: Array<{ ruleId: string; createdAt?: number }>;
}

export const ACCOUNT_REPRICE_RULE_LIMITS = {
  /** Rules per write or cancel. */
  perRequest: 200,
  /** Rules an account keeps, ended ones included until they expire. */
  perAccount: 2_000,
  /** How long a ramp is kept after it ends (or after its last day). */
  retentionMs: 30 * 24 * 60 * 60 * 1000,
} as const;
