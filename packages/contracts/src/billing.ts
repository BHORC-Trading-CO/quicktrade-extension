import type { AccessReason, AccessTier } from './auth';

/**
 * Prepaid billing (QUICK-134): a payment adds days of paid access, nothing renews automatically. Payments are
 * recorded by an operator command, or detected on chain: the user pays an invoice with a unique amount in USDT or
 * USDC to one static address, and the server grants the period when it sees the transfer (part 2).
 * Amounts are decimal strings (e.g. "9.99"): crypto currencies differ in precision, and a string keeps the
 * exact amount without floating-point rounding. Dates are ISO strings on the wire.
 */

/**
 * Who recorded the payment: an operator by hand, an on-chain transfer matched to an invoice, a payment
 * processor (not integrated), or a referral reward (QUICK-264: days, amount "0", when an invited account first pays).
 */
export type BillingPaymentSource = 'manual' | 'onchain' | 'processor' | 'referral';

/** EVM networks that on-chain payments can use (low-fee networks only: no Ethereum mainnet, no TRON). */
export type BillingNetwork = 'bsc' | 'polygon' | 'arbitrum' | 'base';

/** Stablecoins accepted at par with the plan's price. */
export type BillingToken = 'USDT' | 'USDC';

/** One accepted network/token pair (the server's BILLING_PAYMENT_OPTIONS). */
export interface BillingPaymentOption {
  network: BillingNetwork;
  token: BillingToken;
}

/** `open` until it is paid or `expiresAt` passes; a payment that arrives later (within a grace window) still counts. */
export type BillingInvoiceStatus = 'open' | 'paid' | 'expired';

/** The transfer that paid an invoice. */
export interface BillingInvoicePayment<TDate = string> {
  network: BillingNetwork;
  token: BillingToken;
  /** The amount received, as a decimal string. */
  amount: string;
  /** The transaction hash, shortened to a prefix…suffix. */
  txHash: string;
  at: TDate;
}

/** An invoice as its owner sees it (`POST /api/billing/invoices`, `GET /api/billing/invoices/:id`). */
export interface BillingInvoiceView<TDate = string> {
  id: string;
  /** The exact amount to send, e.g. "29.9917": the price plus a tail unique among open and recent invoices. */
  amount: string;
  status: BillingInvoiceStatus;
  createdAt: TDate;
  expiresAt: TDate;
  /** A payment detected or claimed until then still counts (expiresAt plus the grace window). */
  acceptedUntil: TDate;
  /** The plan it pays for, and the days of paid access it buys. */
  plan: string;
  days: number;
  /** The transfer that paid it; null while it is not paid. */
  payment: BillingInvoicePayment<TDate> | null;
}

/** On-chain payments in `GET /api/billing`. */
export interface BillingPaymentInfo<TDate = string> {
  /** false: billing is off, the price is not set, no wallet address or no accepted pair (the page keeps the support block). */
  enabled: boolean;
  /** The receiving address (0x…, checksummed); null when payments are off. */
  address: string | null;
  /** Accepted network/token pairs; empty when payments are off. */
  options: BillingPaymentOption[];
  /** The account's open invoice, or its latest one while a late payment can still count; null otherwise. */
  invoice: BillingInvoiceView<TDate> | null;
}

/**
 * `POST /api/billing/invoices`: the account's open invoice for this plan, or a new one (an open invoice for the
 * other plan is replaced; a payment for it still counts within the grace window).
 */
export interface BillingInvoiceRequest {
  plan: string;
}

/** `POST /api/billing/invoices/:id/claim`: "paid but not detected?". */
export interface BillingClaimRequest {
  network: BillingNetwork;
  /** 0x followed by 64 hex characters. */
  txHash: string;
}

/** A claim the server accepted: paid, or the transaction needs more confirmations first. */
export type BillingClaimResponse<TDate = string> =
  | { outcome: 'paid'; invoice: BillingInvoiceView<TDate> }
  | {
      outcome: 'pending';
      confirmations: number;
      requiredConfirmations: number;
      /** When to try again. */
      retryAfterSeconds: number;
      invoice: BillingInvoiceView<TDate>;
    };

/**
 * The `error` code of a refused invoice or claim request (HTTP 4xx/503, with a `message` in plain words):
 * - payments_off (503): billing, the plans, the address or every pair is off;
 * - unknown_plan (400): no plan with this id;
 * - account_not_ready (409): the account is not provisioned yet (sign in again);
 * - busy (503): no unique amount is free right now;
 * - invoice_paid / invoice_closed (409): the invoice is already paid, or the transfer was mined after its grace end;
 * - tx_not_found (409): no such transaction on that network (yet);
 * - no_transfer (409): the transaction sent no accepted token to our address on that network;
 * - token_not_accepted (409): a token or network that is not accepted;
 * - amount_mismatch (409): the amount is not exactly the invoice's;
 * - tx_before_invoice (409): the transaction is older than the invoice;
 * - tx_already_used (409): the transaction already paid something else;
 * - tx_revoked (409): support revoked this payment; the transaction cannot grant access again;
 * - network_unavailable (503): the network could not be checked right now.
 */
export type BillingPaymentErrorCode =
  | 'payments_off'
  | 'unknown_plan'
  | 'account_not_ready'
  | 'busy'
  | 'invoice_paid'
  | 'invoice_closed'
  | 'tx_not_found'
  | 'no_transfer'
  | 'token_not_accepted'
  | 'amount_mismatch'
  | 'tx_before_invoice'
  | 'tx_already_used'
  | 'tx_revoked'
  | 'network_unavailable';

/**
 * Each network's name as the server writes it, in its chain registry and in billing refusals' `details.network`
 * (QUICK-189). The server's registry is typed against these, and the web accepts no other name in `details`.
 */
export const BILLING_NETWORK_NAMES = {
  bsc: 'BNB Smart Chain (BEP20)',
  polygon: 'Polygon PoS',
  arbitrum: 'Arbitrum One',
  base: 'Base',
} as const satisfies Record<BillingNetwork, string>;

const BILLING_NETWORKS = Object.keys(BILLING_NETWORK_NAMES) as BillingNetwork[];

/** Every BillingToken, in the order the web lists them. */
export const BILLING_TOKENS: readonly BillingToken[] = ['USDT', 'USDC'];

/** One of the networks in BillingNetwork (QUICK-250: shared by the web and the admin app). */
export function isBillingNetwork(value: unknown): value is BillingNetwork {
  return typeof value === 'string' && (BILLING_NETWORKS as string[]).includes(value);
}

/** One of the stablecoins in BillingToken. */
export function isBillingToken(value: unknown): value is BillingToken {
  return typeof value === 'string' && (BILLING_TOKENS as string[]).includes(value);
}

/**
 * Facts behind a claim refusal, sent next to its code as `details` (QUICK-189), so the web words the refusal in the
 * interface language without reading `message`. Only what the sentence needs is present:
 * - network: the network's name as the server writes it, one of BILLING_NETWORK_NAMES (tx_not_found, no_transfer, token_not_accepted,
 *   amount_mismatch, network_unavailable on a claim);
 * - token: the transfer's token that this network does not accept (token_not_accepted for a token; absent when the
 *   network itself is not accepted for the invoice);
 * - sent: what the transaction sent, "29.99 USDC" (several transfers joined by ", "; amount_mismatch).
 */
export type BillingPaymentErrorDetails = {
  network?: string;
  token?: BillingToken;
  sent?: string;
};

/**
 * One paid plan from the server's BILLING_PLANS (owner decision 05.10: monthly = 30 days for 29.99, yearly =
 * 365 days for 299.90, in USD paid 1:1 in USDT or USDC).
 */
export interface BillingPlan {
  /** e.g. monthly, yearly. */
  id: string;
  /** Days of paid access one payment adds. */
  days: number;
  /** Price as a decimal string, e.g. "29.99". */
  price: string;
  /** e.g. USD. */
  currency: string;
}

/** The account's access as `/auth/me` evaluates it, plus the billing dates the web cannot derive from it. */
export interface BillingStatus<TDate = string> {
  /** null only when reason is unavailable. */
  tier: AccessTier | null;
  /** When full access ends (trial or paid period end); null when already limited. */
  accessEndsAt: TDate | null;
  /** The end of the account's paid access, past or future; null when it never had any. In the past: the paid period ended. */
  paidUntil: TDate | null;
  /** The trial end from the trial ledger; null before a Steam account is linked. */
  trialEndsAt: TDate | null;
  reason: AccessReason;
}

/** One recorded payment as the account owner sees it (no operator notes, labels or revocation reasons). */
export interface BillingPaymentView<TDate = string> {
  /** When the payment was recorded. */
  date: TDate;
  /** Days of paid access it added. */
  days: number;
  /**
   * Where the paid access it bought ends: moved back when an earlier payment was revoked; for a revoked payment,
   * the end of the part already used.
   */
  periodEnd: TDate;
  /** Decimal string, e.g. "9.99". */
  amount: string;
  currency: string;
  /** e.g. TRC20, or BSC / POLYGON / ARBITRUM / BASE for on-chain payments; null when not recorded. */
  network: string | null;
  source: BillingPaymentSource;
  /** The transaction hash or processor invoice id, shortened to a prefix…suffix. */
  externalId: string;
  /** When support revoked this payment (its remaining days were removed); null when it stands. */
  revokedAt: TDate | null;
}

/** `GET /api/billing` (Clerk, no plan feature, no-store). */
export interface BillingResponse<TDate = string> {
  /** Billing UI is shown only when the server's BILLING_ENABLED is "true". */
  enabled: boolean;
  /** The plans in BILLING_PLANS order; empty when BILLING_PLANS is invalid ("Price to be announced"). */
  plans: BillingPlan[];
  status: BillingStatus<TDate>;
  /** The last 20 payments, newest first. */
  payments: BillingPaymentView<TDate>[];
  /** On-chain payments (QUICK-134 part 2). */
  payment: BillingPaymentInfo<TDate>;
  /**
   * QUICK-216: the Market features (`marketBuy`, `marketBuyOrders`) are open to every plan (`MARKET_ENABLED`). False while
   * they roll out to the admins only: the plan card then leaves them out, so nobody pays for what the plan does not give.
   */
  marketOpen: boolean;
}
