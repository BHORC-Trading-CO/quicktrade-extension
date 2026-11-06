import type { Access, AccessReason, AccessTier, Trial } from './auth';
import type { BillingPaymentSource } from './billing';

/**
 * The admin panel (QUICK-165): `/api/admin/*` on the server, `/admin` in the web. Admins are a server-side allowlist of
 * Clerk user ids (`ADMIN_CLERK_IDS`). Every admin route but `GET /api/admin/me` answers 403 `admin_required` to anyone
 * else. Dates are ISO strings on the wire.
 */

/** 403 message of every admin route for a signed-in user who is not an admin. */
export const ADMIN_REQUIRED = 'admin_required';
/** ADMIN_BASE_URL is set and the verified Clerk azp is not that origin; /api/admin/me is exempt. */
export const ADMIN_ORIGIN_REQUIRED = 'admin_origin_required';
/** 403 for banned accounts outside `GET /api/auth/me` and the user Support routes. */
export const ACCOUNT_BANNED = 'account_banned';

/** A reason is required for admin actions and stored in the audit (a ban's reason is shown to the user).
 * MFA lifecycle/security events take none. Support is the exception too: views, replies, internal notes, assignment,
 * status and read markers take no reason. The conversation supplies the context; audit stores only ticket
 * id/number/status, never message text.
 */
export const ADMIN_REASON_MIN_LENGTH = 3;
export const ADMIN_REASON_MAX_LENGTH = 500;
/** A trial is extended by 1..30 days at a time. */
export const ADMIN_TRIAL_EXTENSION_MAX_DAYS = 30;
/** Users and audit entries per page, newest first. */
export const ADMIN_PAGE_SIZE = 50;
/** The largest per-user sale-history limits an admin may set (trial only; paid uses inventory-only access). */
export const SALE_HISTORY_LIMIT_MAX_ITEMS_PER_DAY = 3000;
export const SALE_HISTORY_LIMIT_MAX_REQUESTS_PER_DAY = 20000;

/** `GET /api/admin/me`: answered to every signed-in user, so the web can hide the admin entry. */
export interface AdminMeResponse {
  admin: boolean;
}

/** `users.ban` as admins see it. `by` is the admin's Clerk id. */
export interface AccountBan<TDate = string> {
  at: TDate;
  by: string;
  reason: string;
}

/** Per-user daily sale-history limits that replace the plan's while the plan includes sale history. */
export interface SaleHistoryLimits {
  itemsPerDay: number;
  requestsPerDay: number;
}

/** An anomaly flag (written by QUICK-164 detection); admins clear it, it is never deleted. */
export interface UserFlag<TDate = string> {
  id: string;
  /**
   * Defined by the detector; the sale-history usage detector (QUICK-164) raises `sale_history_tempo`,
   * `sale_history_unique_items`, `sale_history_empty_answers`, `sale_history_name_order`, `sale_history_float_bands`,
   * `sale_history_seeds` and `sale_history_sticker_sets`, at most one open flag per kind.
   */
  kind: string;
  reason: string;
  at: TDate;
  /** Who raised it, e.g. `detector`. */
  source: string;
  clearedAt: TDate | null;
  /** The admin's Clerk id. */
  clearedBy: string | null;
}

/** One row of `GET /api/admin/users`. */
export interface AdminUserListItem<TDate = string> {
  clerkId: string;
  email: string;
  steamId: string | null;
  /** Registration (the account's first sign-in). */
  createdAt: TDate | null;
  /** The plan as `getAccess` evaluates the stored account (never `unavailable` here). */
  tier: AccessTier | null;
  reason: AccessReason;
  accessEndsAt: TDate | null;
  /** Today's (UTC) sale-history usage. */
  saleHistoryToday: { items: number; requests: number };
  /** Flags not cleared yet. */
  activeFlags: number;
  banned: boolean;
  limitsOverridden: boolean;
}

/** `GET /api/admin/users?query=&cursor=&flagged=true`: newest first, ADMIN_PAGE_SIZE per page. */
export interface AdminUserListResponse<TDate = string> {
  users: AdminUserListItem<TDate>[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  /** Accounts with at least one flag not cleared yet, whatever the search (QUICK-164). */
  flaggedUsers: number;
}

/** A revoked payment (admins only): when, by whom, why, and how much paid access it removed. */
export interface AdminBillingRevocation<TDate = string> {
  at: TDate;
  /** `admin:<clerkId>` or the operator's label. */
  by: string;
  reason: string;
  /** The paid access removed (ms): the part of the payment's period still ahead when it was revoked. */
  removedMs: number;
}

/** What revoking a payment now would do, as of the detail request. */
export interface AdminRevokePreview<TDate = string> {
  /** The paid access it would remove (ms); 0 when its period is used up. */
  removedMs: number;
  /** The paid-until date left; null when no payment would stand (the account's trial dates apply again). */
  paidUntil: TDate | null;
}

/** A billing ledger row with the operator fields (admins only). */
export interface AdminBillingPayment<TDate = string> {
  /** The payment's number in the account's ledger: `paymentId` of the revoke route. */
  sequence: number;
  createdAt: TDate;
  days: number;
  /** The period as recorded. */
  periodStart: TDate;
  periodEnd: TDate;
  /** Where its paid access ends today: moved back by revocations of earlier payments; for a revoked one, the end of the part kept. */
  effectivePeriodEnd: TDate;
  amount: string;
  currency: string;
  network: string | null;
  externalId: string;
  source: BillingPaymentSource;
  note: string | null;
  grantedBy: string;
  revoked: AdminBillingRevocation<TDate> | null;
  /** null for a revoked payment. */
  revokePreview: AdminRevokePreview<TDate> | null;
}

export interface SaleHistoryDayUsage {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  items: number;
  requests: number;
}

/**
 * A soft sale-history throttle started by the usage detector (QUICK-164) on a trial account: the trial plan's daily
 * counts × `factor` until `until`. Custom limits take precedence; clearing a flag does not lift it, `lift_throttle` does.
 */
export interface AdminSaleHistoryThrottle<TDate = string> {
  at: TDate;
  until: TDate;
  /** The trial plan's items and searches per day are multiplied by this while it runs (0.5). */
  factor: number;
  /** The flag kinds whose signals started it. */
  kinds: string[];
  reason: string;
  /** Not lifted and not expired. It changes the limits only on the trial plan and without custom limits. */
  active: boolean;
  liftedAt: TDate | null;
  /** The admin's Clerk id. */
  liftedBy: string | null;
}

export interface AdminSaleHistoryView<TDate = string> {
  /** Daily overrides apply only to trial. Optional for older servers. */
  policy?: 'daily' | 'inventory_only' | 'unavailable';
  /** The plan's limits; null when the plan has no sale history. */
  planLimits: SaleHistoryLimits | null;
  override: SaleHistoryLimits | null;
  /**
   * What the quota applies now: the override while the plan includes sale history, else the plan's, halved on the
   * trial plan while a throttle runs.
   */
  effectiveLimits: SaleHistoryLimits | null;
  /** The last throttle (running, lifted or expired); null when the account was never throttled. */
  throttle: AdminSaleHistoryThrottle<TDate> | null;
  today: SaleHistoryDayUsage;
  /** The last 7 UTC days, newest first; usage documents are kept 3 days, older days show zeros. */
  days: SaleHistoryDayUsage[];
}

/** `GET /api/admin/users/:clerkId`. */
export interface AdminUserDetail<TDate = string> {
  clerkId: string;
  email: string;
  displayName: string | null;
  steamId: string | null;
  steamLinkedAt: TDate | null;
  steamPersonaName: string | null;
  createdAt: TDate | null;
  lastLogin: TDate | null;
  /** As `/auth/me` evaluates it; `unavailable` when the trial ledger could not be read. */
  access: Access<TDate>;
  trial: Trial<TDate> | null;
  /** `users.subscription.status` (billing state): none, trialing, active, past_due or canceled. */
  subscriptionStatus: string;
  /** The end of paid access, past or future; null when the account never had any. */
  paidUntil: TDate | null;
  /** The billing ledger, newest first (at most 50 rows). */
  payments: AdminBillingPayment<TDate>[];
  saleHistory: AdminSaleHistoryView<TDate>;
  ban: AccountBan<TDate> | null;
  flags: UserFlag<TDate>[];
}

export type AdminAction =
  | 'ban'
  | 'unban'
  | 'set_limits'
  | 'clear_limits'
  | 'extend_trial'
  | 'grant_paid_days'
  | 'revoke_payment'
  | 'clear_flag'
  | 'lift_throttle'
  | 'handle_unmatched_transfer'
  /** A read, audited like an action: the account's diagnostics journal (QUICK-214). */
  | 'view_diagnostics'
  | 'mfa_enable'
  | 'mfa_verify_failed'
  | 'mfa_backup_code_used'
  | 'mfa_backup_codes_regenerated'
  | 'mfa_reset'
  | 'mfa_locked'
  | 'view_support_ticket'
  | 'view_support_attachment'
  | 'support_reply'
  | 'support_note'
  | 'support_assign'
  | 'support_status';

/** pending: not yet confirmed; committed: ledger saved, account sync pending; failed: no confirmed mutation. */
export type AdminAuditOutcome = 'pending' | 'committed' | 'ok' | 'failed';

export type AdminAuditDetails = Record<string, string | number | boolean | null>;

/** One `admin_audit` row: who did what to whom, when, and how it ended. */
export interface AdminAuditEntry<TDate = string> {
  id: string;
  at: TDate;
  adminClerkId: string;
  action: AdminAction;
  /** Null when the action concerns an unmatched transfer with no known account. */
  targetClerkId: string | null;
  /** The request (reason, days, limits, …). */
  details: AdminAuditDetails;
  outcome: AdminAuditOutcome;
  /** What the action changed (new dates, payment created, …); null while pending or when it failed. */
  result: AdminAuditDetails | null;
  /** Why it failed; null otherwise. */
  error: string | null;
}

/** `GET /api/admin/audit?cursor=&targetClerkId=`: newest first, ADMIN_PAGE_SIZE per page. */
export interface AdminAuditListResponse<TDate = string> {
  entries: AdminAuditEntry<TDate>[];
  nextCursor: string | null;
}

/** The reason required by moderation and billing actions; Support requests have their own contract. */
export interface AdminReasonRequest {
  reason: string;
}

/** `POST /api/admin/users/:clerkId/limits`. */
export interface AdminSetLimitsRequest extends AdminReasonRequest, SaleHistoryLimits {}

/** `POST /api/admin/users/:clerkId/trial/extend`: 1..ADMIN_TRIAL_EXTENSION_MAX_DAYS days. */
export interface AdminExtendTrialRequest extends AdminReasonRequest {
  days: number;
  /** UUID v4, generated once per dialog and retained across retries. Bound to the original action and inputs. */
  idempotencyKey: string;
}

/**
 * `POST /api/admin/users/:clerkId/paid-days`, recorded through the billing ledger (source manual). A payment needs
 * the transaction hash or invoice id (`externalId`) and a non-zero amount; a courtesy grant has neither (amount 0, the
 * server derives `admin-<idempotencyKey>`).
 */
export interface AdminGrantPaidDaysRequest extends AdminReasonRequest {
  days: number;
  courtesy: boolean;
  /** Required for courtesy grants: UUID v4, generated once per dialog and retained across retries. */
  idempotencyKey?: string;
  amount?: string;
  /** Defaults to the plan currency. */
  currency?: string;
  network?: string;
  externalId?: string;
}

/**
 * `POST /api/admin/users/:clerkId/payments/:paymentId/revoke` (`paymentId` = the payment's `sequence`): marks the
 * payment revoked in the billing ledger and removes the part of its paid access still ahead; later payments move
 * back. The payment and its id stay recorded, so the same transaction is never granted again.
 */
export interface AdminRevokePaymentRequest extends AdminReasonRequest {
  /** UUID v4, generated once per dialog and retained across retries. Bound to the original action and inputs. */
  idempotencyKey: string;
}

/** What every admin action answers. */
export interface AdminActionResponse {
  auditId: string;
  result: AdminAuditDetails;
}
