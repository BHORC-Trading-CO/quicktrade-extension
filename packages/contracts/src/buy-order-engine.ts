/**
 * The buy-order engine (QUICK-233, epic QUICK-216 R-F3–R-F5, R-F7, R-F8): the extension matches every new listing of the
 * live feed against the account's QTS buy orders and buys through the one buy executor (QUICK-226), within money guards
 * the server enforces as well. Pure and browser-API free: the extension, the web and (as types) the server share it.
 *
 * Who does what:
 *  - The server grants one browser of the account a lease with a heartbeat (`/api/buy-orders/engine/lease`), counts the
 *    day's buy-order spend from the buy-attempt journal, and opens each automatic attempt only after checking the lease,
 *    the switches and the budgets including that attempt (`/api/buy-orders/engine/attempts`).
 *  - The web page renews the lease (the extension has no account session) and hands the server's answer to the
 *    extension (`set_buy_orders_lease`); it relays the engine's journal, estimate and pause requests to the server.
 *  - The extension's engine matches, checks the guards on its side first, and asks the executor to buy with origin
 *    `buy_order`. Without a current lease of this browser for the rules' account it buys nothing.
 *
 * All money is integer USD cents. Times are epoch ms; a time named "server" is on the QTS server's clock, the others on
 * this computer's (the page and the extension share one clock).
 */
import { type BuyOrderListing, type BuyOrderMismatch, matchBuyOrderRule } from './buy-order-match';
import type { BuyOrderRule, BuyOrderRuleFields } from './buy-orders';
import { type MarketBuyOutcome, type MarketBuyResult, isMarketBuyOutcome, isMarketBuyPriceCents } from './market-buy';
import type { MarketFeedConfig, MarketFeedListing } from './market-feed';
import { MARKET_PHASES, MARKET_SOURCES, type MarketPhase, type MarketSource } from './market-views';

// ─── Timing (R-F7, R-F8) ─────────────────────────────────────────────────────────────────────────

/**
 * How long a granted lease lasts without a renewal (server clock). Three renewals fit in it, so one slow or lost renewal
 * never stops the engine, while a closed tab, a sign-out or a lapsed plan stops it within a minute at worst.
 */
export const BUY_ORDER_LEASE_TTL_MS = 60_000;
/** The page renews the lease this often; the extension asks for a renewal when one is this old (a hidden tab's timers are slowed). */
export const BUY_ORDER_LEASE_RENEW_MS = 20_000;
/** No buy starts in the lease's last seconds: an attempt takes a few seconds and must start inside the lease. */
export const BUY_ORDER_LEASE_MARGIN_MS = 5_000;
/**
 * R-F7: from the feed answer that brought a listing to its buy request, QTS's own part (matching, the guards, a QTS
 * estimate, the journal) takes at most this. The marketplace's answers (the listing's re-read) are not counted: the
 * journal is opened while the re-read runs, and an attempt whose own part would take longer is not sent.
 */
export const BUY_ORDER_OWN_TIME_MS = 1_000;
/** A rule pauses itself after this many failed buys in a row (R-F3). */
export const BUY_ORDER_FAILURE_LIMIT = 3;
/** A confirmed marketplace account (logged in as the linked Steam account) is trusted this long without a new read. */
export const BUY_ORDER_ACCOUNT_TTL_MS = 60_000;
/** The engine reads a confirmation again once it is this old, before it runs out (one request per marketplace). */
export const BUY_ORDER_ACCOUNT_REFRESH_MS = 45_000;
/** The engine keeps a QTS estimate this long (the server keeps a priced name 6 h); a name without one 10 min. */
export const BUY_ORDER_ESTIMATE_HIT_TTL_MS = 30 * 60_000;
export const BUY_ORDER_ESTIMATE_MISS_TTL_MS = 10 * 60_000;
/** Activity entries the engine keeps (newest first). */
export const BUY_ORDER_ACTIVITY_MAX = 200;
export const BUY_ORDER_DEVICE_LABEL_MAX = 60;

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────────

/** The 409 codes of `/api/buy-orders/engine/*` (the server repeats them). */
export const BUY_ORDER_ENGINE_ERRORS = {
  /** The server's switch for every account is off. */
  switchedOff: 'buy_orders_engine_off',
  /** The account pressed Stop all. */
  stopped: 'buy_orders_stopped',
  /** This browser does not hold the account's lease (expired, another device took it, or never granted). */
  leaseLost: 'buy_orders_lease_lost',
  /** No Steam account linked: QTS cannot check which marketplace account would pay. */
  steamLinkRequired: 'buy_orders_steam_link_required',
  /** The rule is gone, switched off, in Test mode, or the listing is not on its platforms. */
  ruleInactive: 'buy_orders_rule_inactive',
  /** The price is above the rule's max price. */
  priceAboveLimit: 'buy_orders_price_above_limit',
  /** The account's daily budget is not set. */
  budgetUnset: 'buy_orders_budget_unset',
  /** With this buy the account's daily budget would be exceeded. */
  accountBudget: 'buy_orders_account_budget',
  /** With this buy the rule's daily budget would be exceeded. */
  ruleBudget: 'buy_orders_rule_budget',
  /** The rule bought its items for today. */
  items: 'buy_orders_items',
  /** QTS already tried this listing (any attempt, manual or automatic). */
  listingTried: 'buy_orders_listing_tried',
  /** The listing does not meet the rule as the server keeps it (item, category, float, wear, seed, phase, sticker, price). */
  ruleMismatch: 'buy_orders_rule_mismatch',
  /** The rule needs the QTS estimate and the server has none for this listing now (fail closed). */
  estimateUnavailable: 'buy_orders_estimate_unavailable',
  /** The rule failed `BUY_ORDER_FAILURE_LIMIT` sent buys in a row since it was last changed (counted from the journal). */
  rulePaused: 'buy_orders_rule_paused',
  busy: 'buy_orders_busy',
} as const;

export type BuyOrderEngineErrorCode = (typeof BUY_ORDER_ENGINE_ERRORS)[keyof typeof BUY_ORDER_ENGINE_ERRORS];

const ENGINE_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(BUY_ORDER_ENGINE_ERRORS));

export function isBuyOrderEngineErrorCode(value: unknown): value is BuyOrderEngineErrorCode {
  return typeof value === 'string' && ENGINE_ERROR_CODES.has(value);
}

// ─── Spend (R-F3, R-F8) ──────────────────────────────────────────────────────────────────────────

/**
 * The journal states that count as spent: a pending attempt may still buy, and one whose result is unknown counts as
 * bought (epic §4). Manual purchases never count: only rows with origin `buy_order`.
 */
export const BUY_ORDER_SPENT_STATES = ['pending', 'bought', 'unknown'] as const;

export interface BuyOrderRuleSpend {
  cents: number;
  items: number;
}

/** What the account's buy orders spent on one UTC day, from the server's journal. */
export interface BuyOrdersSpend {
  /** `YYYY-MM-DD`, UTC, on the server's clock. */
  day: string;
  /** When that day ends (server clock). */
  dayEndsAt: number;
  accountCents: number;
  accountItems: number;
  /** Per rule id; a rule that spent nothing today is absent. */
  rules: Record<string, BuyOrderRuleSpend>;
}

const DAY_MS = 86_400_000;

export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function utcDayOf(ms: number): string {
  return new Date(utcDayStart(ms)).toISOString().slice(0, 10);
}

/** A rule's spend today (zero when absent). */
export function ruleSpendOf(spend: BuyOrdersSpend, ruleId: string): BuyOrderRuleSpend {
  return spend.rules[ruleId] ?? { cents: 0, items: 0 };
}

/** `spend` plus one attempt of `priceCents` for `ruleId`. */
export function addToSpend(spend: BuyOrdersSpend, ruleId: string, priceCents: number): BuyOrdersSpend {
  const rule = ruleSpendOf(spend, ruleId);
  return {
    ...spend,
    accountCents: spend.accountCents + priceCents,
    accountItems: spend.accountItems + 1,
    rules: { ...spend.rules, [ruleId]: { cents: rule.cents + priceCents, items: rule.items + 1 } },
  };
}

// ─── The server's answers ────────────────────────────────────────────────────────────────────────

export interface BuyOrdersEngineLease {
  leaseId: string;
  deviceId: string;
  /** What the holder's page called its browser ("Chrome · macOS"); null when it said nothing. */
  deviceLabel: string | null;
  /** Server clock. */
  renewedAt: number;
  expiresAt: number;
}

/**
 * `GET /api/buy-orders/engine` and every lease answer: the account's engine as the server sees it. `lease` is the live
 * lease, whoever holds it (null when none is live); a browser holds it when `lease.deviceId` is its own id.
 */
export interface BuyOrdersEngineStatus {
  /** The account the status is for (the caller's Clerk user). */
  clerkId: string;
  /** The server's clock when it answered. */
  serverNow: number;
  /** The server's switch for every account (`BUY_ORDERS_ENGINE_ENABLED`). */
  switchedOn: boolean;
  /** When the account pressed Stop all (server clock); null while buy orders may run. */
  stoppedAt: number | null;
  /** The Steam account linked to QTS; the engine buys nothing without one. */
  steamId: string | null;
  lease: BuyOrdersEngineLease | null;
  spend: BuyOrdersSpend;
  /**
   * Per rule id: its sent buys that failed in a row since the rule was last changed, from the journal (a rule absent
   * has none). At `BUY_ORDER_FAILURE_LIMIT` the server refuses its attempts; the engine pauses it.
   */
  failures: Record<string, number>;
}

/** `POST /api/buy-orders/engine/lease`: take or renew the lease for this browser; `takeover` takes it from another one. */
export interface BuyOrdersLeaseRequest {
  /** The extension's id for this browser profile (a UUID it keeps). */
  deviceId: string;
  deviceLabel?: string;
  takeover?: boolean;
}

/** `POST /api/buy-orders/engine/release`: this browser stops running buy orders (another one may take over at once). */
export interface BuyOrdersLeaseRelease {
  deviceId: string;
}

/**
 * `POST /api/buy-orders/engine/attempts`: the journal row of one automatic attempt, opened only when the lease, the
 * switches, the rule and every budget (including this attempt) allow it. The row counts as spent from now on.
 */
export interface BuyOrderAttemptOpenRequest {
  attemptId: string;
  source: MarketSource;
  listingId: string;
  marketHashName: string;
  floatValue?: number;
  /** The listing's price as the feed read it: what the buy request will carry. */
  priceCents: number;
  ruleId: string;
  /** The rest of what the rule judges, as the feed read it: the server matches the rule it keeps against these. */
  paintSeed?: number | null;
  phase?: MarketPhase | null;
  stickers?: Array<{ name: string; priceCents: number | null }>;
  deviceId: string;
  leaseId: string;
  /** When the feed first saw the listing, and when this request left (browser clock). */
  seenAt: number;
  sentAt: number;
}

export interface BuyOrderAttemptOpenResponse {
  attemptId: string;
  state: 'pending';
  serverNow: number;
  /** The day's spend with this attempt in it. */
  spend: BuyOrdersSpend;
}

// ─── Page → extension ────────────────────────────────────────────────────────────────────────────

/**
 * `set_buy_orders_lease` (capability `buy_orders_engine`): the server's last answer about the engine, for the account
 * signed in on the page. `status: null` takes the lease away from this browser at once (signed out, the plan lapsed,
 * the server refused): the engine stops without waiting for the lease to run out.
 */
export interface BuyOrdersLeasePush {
  clerkId: string;
  status: BuyOrdersEngineStatus | null;
  /** This computer's clock right before the lease request left and when its answer arrived. */
  requestedAt: number;
  receivedAt: number;
  /** What the live feed must read for the rules (the web builds the requests); null when no rule is on. */
  feed: MarketFeedConfig | null;
}

// ─── Extension → page ────────────────────────────────────────────────────────────────────────────

/**
 *  - `idle`: no lease news or no rules from the page yet;
 *  - `no_rules`: no buy order is switched on;
 *  - `waiting`: this browser asked for the lease and has no live answer;
 *  - `other_device`: another browser of the account runs them (`holder`);
 *  - `stopped`: Stop all (on the server, or pressed in this browser: `stoppedHere`);
 *  - `switched_off`: the server's switch;
 *  - `running`: this browser runs them (buys only with a linked Steam account: `canBuy`).
 */
export const BUY_ORDER_ENGINE_STATES = [
  'idle',
  'no_rules',
  'waiting',
  'other_device',
  'stopped',
  'switched_off',
  'running',
] as const;
export type BuyOrdersEngineState = (typeof BUY_ORDER_ENGINE_STATES)[number];

/**
 *  - `bought`, `unknown` (counted as spent, never retried), `missed` (sold first or its price moved), `failed` (another
 *    result: nothing bought);
 *  - `would_buy`, `would_skip`: a rule in Test mode;
 *  - `skipped`: a guard or a condition kept the engine from buying (`reason`);
 *  - `paused`: a rule paused itself after failures in a row; `stopped` / `lease_lost` / `started`: the engine.
 */
export const BUY_ORDER_ACTIVITY_KINDS = [
  'bought',
  'unknown',
  'missed',
  'failed',
  'would_buy',
  'would_skip',
  'skipped',
  'paused',
  'stopped',
  'lease_lost',
  'started',
] as const;
export type BuyOrderActivityKind = (typeof BUY_ORDER_ACTIVITY_KINDS)[number];

export interface BuyOrderActivityListing {
  source: MarketSource;
  listingId: string;
  marketHashName: string;
  priceCents: number;
  floatValue: number | null;
  paintSeed: number | null;
}

/** Numbers a reason is told with (cents, counts, percents). */
export interface BuyOrderActivityValues {
  limitCents?: number;
  spentCents?: number;
  budgetCents?: number;
  shortCents?: number;
  items?: number;
  maxItems?: number;
  discountPct?: number;
  wantPct?: number;
  newPriceCents?: number;
  failures?: number;
}

export interface BuyOrderActivity {
  id: string;
  /** This computer's clock. */
  at: number;
  kind: BuyOrderActivityKind;
  ruleId: string | null;
  /** The rule's name when it happened (it may be renamed or deleted later). */
  ruleName: string | null;
  listing: BuyOrderActivityListing | null;
  /** A machine code: a guard (`account_budget`), a condition (`discount_too_small`), an executor reason (`code_220`). */
  reason: string | null;
  values?: BuyOrderActivityValues;
  outcome?: MarketBuyOutcome;
  /** From the feed answer that brought the listing to the buy request (ms). */
  latencyMs?: number;
  attemptId?: string;
}

/** A rule as the engine runs it right now. */
export interface BuyOrderRuleRuntime {
  /** Failed buys in a row since the rule was last changed. */
  failures: number;
  /** It paused itself (`BUY_ORDER_FAILURE_LIMIT` failures in a row); it runs again once the rule is changed or switched on again. */
  pausedAt: number | null;
  /** Test mode: what it would have bought today. */
  testItems: number;
  testCents: number;
}

/** `get_buy_orders_engine` / `set_buy_orders_lease` / `set_buy_orders_stopped` answer (`buy_orders_engine`). */
export interface BuyOrdersEngineView {
  requestId?: string;
  /** This browser's id (the page renews the lease with it). */
  deviceId: string;
  state: BuyOrdersEngineState;
  /** The account the engine works for. */
  clerkId: string | null;
  /** Stop all was pressed in this browser: it stays stopped until this browser starts it again. */
  stoppedHere: boolean;
  /** Running and able to buy: a linked Steam account (else only Test mode rules run). */
  canBuy: boolean;
  /** Another browser that holds the lease. */
  holder: { deviceLabel: string | null; renewedAt: number } | null;
  /** When this browser's lease ends (this computer's clock). */
  leaseUntil: number | null;
  /** When a feed answer last reached the engine. */
  lastFeedAt: number | null;
  /** Today's spend as the engine counts it (the server's figure plus attempts it opened since). */
  spend: BuyOrdersSpend | null;
  rules: Record<string, BuyOrderRuleRuntime>;
  /** Newest first. */
  activity: BuyOrderActivity[];
  now: number;
}

/** What the engine asks the page to do with the server (the extension has no account session). */
export type BuyOrdersEngineRequest =
  | { requestId: string; kind: 'open'; open: BuyOrderAttemptOpenRequest }
  | { requestId: string; kind: 'settle'; attemptId: string; seenAt: number; result: MarketBuyResult }
  | { requestId: string; kind: 'estimates'; listings: BuyOrderListing[] }
  | { requestId: string; kind: 'pause_rule'; ruleId: string }
  | { requestId: string; kind: 'renew' };

export type BuyOrdersEngineRequestKind = BuyOrdersEngineRequest['kind'];

/** The page's answer to one request (`buy_orders_engine_answer`). */
export type BuyOrdersEngineAnswer =
  | { requestId: string; kind: 'open'; outcome: 'opened'; response: BuyOrderAttemptOpenResponse }
  /** The server refused with one of `BUY_ORDER_ENGINE_ERRORS` (or `buy_attempt_in_progress`): nothing was opened. */
  | { requestId: string; kind: 'open'; outcome: 'refused'; code: string }
  /** No answer from the server: a row may exist (the engine settles it `not_sent`). */
  | { requestId: string; kind: 'open'; outcome: 'failed' }
  | { requestId: string; kind: 'settle'; ok: boolean }
  /** Per listing (`<source>:<listing id>`): the QTS estimate in cents, or null when the server has none. Null: no answer. */
  | { requestId: string; kind: 'estimates'; estimates: Record<string, number | null> | null }
  | { requestId: string; kind: 'pause_rule'; ok: boolean }
  | { requestId: string; kind: 'renew'; ok: boolean };

/** The background's push to a page: a request for the server, or an activity worth a notification. */
export type BuyOrdersEnginePush = { request: BuyOrdersEngineRequest } | { event: BuyOrderActivity };

// ─── The listing as the matcher reads it ─────────────────────────────────────────────────────────

/**
 * CSFloat names a Doppler without its phase; its paint index tells it (cs.money spells it in the name). The web's
 * `PHASE_BY_PAINT_INDEX` (`apps/web/src/lib/phases.ts`), which a web test compares with this copy.
 */
export const BUY_ORDER_PHASE_BY_PAINT_INDEX: Readonly<Record<number, MarketPhase>> = {
  415: 'Ruby',
  416: 'Sapphire',
  417: 'Black Pearl',
  418: 'Phase 1',
  419: 'Phase 2',
  420: 'Phase 3',
  421: 'Phase 4',
  568: 'Emerald',
  569: 'Phase 1',
  570: 'Phase 2',
  571: 'Phase 3',
  572: 'Phase 4',
};

/**
 * A feed listing in the matcher's shape: the engine and the editor's preview read the feed through this one function,
 * so the preview cannot say "would buy" where the engine would not.
 */
export function buyOrderListingFromFeedEntry(entry: MarketFeedListing): BuyOrderListing {
  const phase =
    entry.marketHashName.includes('Doppler') && entry.paintIndex !== null
      ? (BUY_ORDER_PHASE_BY_PAINT_INDEX[entry.paintIndex] ?? null)
      : null;
  return {
    source: entry.source,
    listingId: entry.listingId,
    marketHashName: entry.marketHashName,
    priceCents: entry.priceCents,
    floatValue: entry.float,
    paintSeed: entry.paintSeed,
    phase: phase !== null && (MARKET_PHASES as readonly string[]).includes(phase) ? phase : null,
    stickers: entry.stickers.map((sticker) => ({ name: sticker.name, priceCents: sticker.priceCents ?? null })),
    // The buffer keeps no CSFloat estimate of the copy: a sticker premium needs the QTS estimate.
    referencePriceCents: null,
    seenAt: entry.firstSeenAt,
  };
}

/** `<source>:<listing id>`, the key the feed, the executor's registry and the estimate answers use. */
export function buyOrderListingKey(listing: Pick<BuyOrderListing, 'source' | 'listingId'>): string {
  return `${listing.source}:${listing.listingId}`;
}

/** The conditions only the QTS estimate can decide. */
export const BUY_ORDER_ESTIMATE_REASONS: ReadonlySet<BuyOrderMismatch['code']> = new Set<BuyOrderMismatch['code']>([
  'estimate_unknown',
  'discount_too_small',
  'sticker_premium_unknown',
  'sticker_premium',
]);

/** The rule needs the QTS estimate of this listing (a discount condition, or a sticker premium limit on a stickered one). */
export function buyOrderNeedsEstimate(rule: BuyOrderRuleFields, listing: BuyOrderListing): boolean {
  return rule.belowEstimatePct !== null || (rule.maxStickerPremiumPct !== null && listing.stickers.length > 0);
}

/** The listing passes every condition of the rule that needs no estimate: its estimate decides it. */
export function isBuyOrderEstimateCandidate(rule: BuyOrderRuleFields, listing: BuyOrderListing): boolean {
  if (!buyOrderNeedsEstimate(rule, listing)) return false;
  const { reasons } = matchBuyOrderRule(rule, listing, { estimateCents: null });
  return reasons.every((reason) => BUY_ORDER_ESTIMATE_REASONS.has(reason.code));
}

// ─── Guards (R-F3) ───────────────────────────────────────────────────────────────────────────────

/**
 * Why the engine does not buy a listing a rule matches, checked in this order. The server checks the lease, the
 * switches, the price limit, the budgets and the items again when it opens the attempt (and refuses on its own figures);
 * the executor then checks the account, the balance and the listing again.
 */
export type BuyOrderGuardRefusal =
  | { code: 'rule_paused'; failures: number }
  /** Failures so far plus attempts of the rule still running would reach the limit: wait for their results. */
  | { code: 'failures_pending'; failures: number }
  | { code: 'steam_link_required' }
  | { code: 'source_disabled' }
  | { code: 'price_invalid' }
  | { code: 'price_above_limit'; priceCents: number; limitCents: number }
  | { code: 'listing_tried' }
  | { code: 'account_budget_unset' }
  | { code: 'spend_unknown' }
  | { code: 'account_budget'; priceCents: number; spentCents: number; budgetCents: number }
  | { code: 'rule_budget'; priceCents: number; spentCents: number; budgetCents: number }
  | { code: 'items'; items: number; maxItems: number }
  | { code: 'balance'; priceCents: number; balanceCents: number; shortCents: number };

export type BuyOrderGuardCode = BuyOrderGuardRefusal['code'];

export interface BuyOrderGuardInput {
  rule: Pick<BuyOrderRule, 'id' | 'maxPriceCents' | 'dailyBudgetCents' | 'maxItemsPerDay'>;
  /** The account's daily budget for all buy orders; null = not set. */
  accountBudgetCents: number | null;
  /** The listing's price: exactly what the buy request would carry. */
  priceCents: number;
  /** Today's spend, the attempt not in it; null = no figure for today yet. */
  spend: BuyOrdersSpend | null;
  /** What is left of the marketplace balance (a recent confirmation, minus buys since); null = not known. */
  balanceCents: number | null;
  /** Failed buys in a row; `BUY_ORDER_FAILURE_LIMIT` or more pauses the rule. */
  failures: number;
  /** The rule's attempts still running: with `failures` they may not reach the limit (no overshoot). */
  running?: number;
  listingTried: boolean;
  steamLinked: boolean;
  sourceEnabled: boolean;
}

/**
 * Every guard the engine checks before an automatic buy, the budgets and the item count including this buy. Null:
 * nothing stops it here. Integer cents throughout; a price QTS could not send (`isMarketBuyPriceCents`) never passes.
 */
export function checkBuyOrderGuards(input: BuyOrderGuardInput): BuyOrderGuardRefusal | null {
  const { rule, priceCents } = input;
  if (input.failures >= BUY_ORDER_FAILURE_LIMIT) return { code: 'rule_paused', failures: input.failures };
  if (input.failures > 0 && input.failures + (input.running ?? 0) >= BUY_ORDER_FAILURE_LIMIT)
    return { code: 'failures_pending', failures: input.failures };
  if (!input.steamLinked) return { code: 'steam_link_required' };
  if (!input.sourceEnabled) return { code: 'source_disabled' };
  if (!isMarketBuyPriceCents(priceCents)) return { code: 'price_invalid' };
  if (rule.maxPriceCents !== null && priceCents > rule.maxPriceCents)
    return { code: 'price_above_limit', priceCents, limitCents: rule.maxPriceCents };
  if (input.listingTried) return { code: 'listing_tried' };
  if (input.accountBudgetCents === null) return { code: 'account_budget_unset' };
  if (!input.spend) return { code: 'spend_unknown' };
  if (input.spend.accountCents + priceCents > input.accountBudgetCents)
    return {
      code: 'account_budget',
      priceCents,
      spentCents: input.spend.accountCents,
      budgetCents: input.accountBudgetCents,
    };
  const ruleSpend = ruleSpendOf(input.spend, rule.id);
  if (ruleSpend.cents + priceCents > rule.dailyBudgetCents)
    return { code: 'rule_budget', priceCents, spentCents: ruleSpend.cents, budgetCents: rule.dailyBudgetCents };
  if (ruleSpend.items + 1 > rule.maxItemsPerDay)
    return { code: 'items', items: ruleSpend.items, maxItems: rule.maxItemsPerDay };
  if (input.balanceCents !== null && input.balanceCents < priceCents)
    return {
      code: 'balance',
      priceCents,
      balanceCents: input.balanceCents,
      shortCents: priceCents - input.balanceCents,
    };
  return null;
}

/** The numbers a guard refusal is told with in the activity log. */
export function guardActivityValues(refusal: BuyOrderGuardRefusal): BuyOrderActivityValues {
  switch (refusal.code) {
    case 'rule_paused':
    case 'failures_pending':
      return { failures: refusal.failures };
    case 'price_above_limit':
      return { limitCents: refusal.limitCents };
    case 'account_budget':
    case 'rule_budget':
      return { spentCents: refusal.spentCents, budgetCents: refusal.budgetCents };
    case 'items':
      return { items: refusal.items, maxItems: refusal.maxItems };
    case 'balance':
      return { shortCents: refusal.shortCents };
    default:
      return {};
  }
}

/** Results of a sent buy request that count as a failed buy (R-F3). */
export const BUY_ORDER_FAILURE_OUTCOMES: ReadonlySet<MarketBuyOutcome> = new Set<MarketBuyOutcome>([
  'unknown',
  'refused',
  'insufficient_balance',
  'cannot_trade',
  'signed_out',
  'two_factor_required',
]);

/**
 * How a result moves a rule's run of failures (R-F3): a purchase ends it. Only a buy request that was sent and then
 * refused (or whose result is unknown) is a failure. A listing sold first, a moved price or a busy listing is the race
 * lost; a captcha or a rate limit is the marketplace's outage; nothing sent (a re-read that failed, QTS's own refusal)
 * says nothing about the rule. The server counts the journal the same way.
 */
export function buyOrderFailureEffect(outcome: MarketBuyOutcome, sent: boolean): 'success' | 'neutral' | 'failure' {
  if (outcome === 'bought') return 'success';
  return sent && BUY_ORDER_FAILURE_OUTCOMES.has(outcome) ? 'failure' : 'neutral';
}

/** The activity kind of an executor result. */
export function buyOrderActivityKindOf(outcome: MarketBuyOutcome): BuyOrderActivityKind {
  if (outcome === 'bought') return 'bought';
  if (outcome === 'unknown') return 'unknown';
  if (outcome === 'sold' || outcome === 'price_changed') return 'missed';
  return 'failed';
}

// ─── The lease on this computer's clock ──────────────────────────────────────────────────────────

/**
 * When the lease ends on this computer's clock, counted from the request's departure (the server answered after it,
 * so the end comes no later than this): the conservative reading of `expiresAt − serverNow`.
 */
export function localLeaseUntil(
  status: Pick<BuyOrdersEngineStatus, 'serverNow'> & { lease: Pick<BuyOrdersEngineLease, 'expiresAt'> | null },
  requestedAt: number
): number | null {
  if (!status.lease) return null;
  return requestedAt + Math.max(0, status.lease.expiresAt - status.serverNow);
}

/** The server's clock minus this computer's, measured by one request (its middle). */
export function serverClockOffset(serverNow: number, requestedAt: number, receivedAt: number): number {
  return serverNow - Math.round((requestedAt + receivedAt) / 2);
}

// ─── Parsing (the extension reads what the page sends; the web reads the server's and the extension's answers) ──

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RULE_ID = /^[\w-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STEAM_ID = /^7656119\d{10}$/;
const CLERK_ID = /^user_[A-Za-z0-9]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function isBuyOrderDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value);
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function wholeCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A device label as the server keeps it: one line, at most `BUY_ORDER_DEVICE_LABEL_MAX` characters; else null. */
export function cleanDeviceLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (!label || label.length > BUY_ORDER_DEVICE_LABEL_MAX || CONTROL.test(label)) return null;
  return label;
}

export function parseBuyOrdersSpend(value: unknown): BuyOrdersSpend | null {
  if (!isRecord(value)) return null;
  const { day, dayEndsAt, accountCents, accountItems, rules } = value;
  if (typeof day !== 'string' || !DAY.test(day) || !time(dayEndsAt)) return null;
  if (!wholeCents(accountCents) || !wholeCents(accountItems) || !isRecord(rules)) return null;
  const parsed: Record<string, BuyOrderRuleSpend> = {};
  for (const [id, entry] of Object.entries(rules)) {
    if (!RULE_ID.test(id) || !isRecord(entry) || !wholeCents(entry['cents']) || !wholeCents(entry['items']))
      return null;
    parsed[id] = { cents: entry['cents'], items: entry['items'] };
  }
  return { day, dayEndsAt, accountCents, accountItems, rules: parsed };
}

function parseLease(value: unknown): BuyOrdersEngineLease | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { leaseId, deviceId, deviceLabel, renewedAt, expiresAt } = value;
  if (typeof leaseId !== 'string' || !LEASE_ID.test(leaseId) || !isBuyOrderDeviceId(deviceId)) return undefined;
  if (!time(renewedAt) || !time(expiresAt)) return undefined;
  if (deviceLabel !== null && cleanDeviceLabel(deviceLabel) === null) return undefined;
  return { leaseId, deviceId: deviceId.toLowerCase(), deviceLabel: deviceLabel as string | null, renewedAt, expiresAt };
}

/** The server's engine status, rebuilt from its known fields; null when anything is outside the contract. */
export function parseBuyOrdersEngineStatus(value: unknown): BuyOrdersEngineStatus | null {
  if (!isRecord(value)) return null;
  const { clerkId, serverNow, switchedOn, stoppedAt, steamId } = value;
  if (typeof clerkId !== 'string' || !CLERK_ID.test(clerkId) || !time(serverNow) || typeof switchedOn !== 'boolean')
    return null;
  if (stoppedAt !== null && !time(stoppedAt)) return null;
  if (steamId !== null && (typeof steamId !== 'string' || !STEAM_ID.test(steamId))) return null;
  const lease = parseLease(value['lease']);
  const spend = parseBuyOrdersSpend(value['spend']);
  if (lease === undefined || !spend) return null;
  // A server before the count answers none (the engine counts its own); a malformed one is refused.
  const counted = value['failures'] ?? {};
  if (!isRecord(counted)) return null;
  const failures: Record<string, number> = {};
  for (const [id, count] of Object.entries(counted)) {
    if (!RULE_ID.test(id) || !wholeCents(count)) return null;
    failures[id] = count;
  }
  return { clerkId, serverNow, switchedOn, stoppedAt, steamId, lease, spend, failures };
}

function parseFeedConfig(value: unknown): MarketFeedConfig | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !Array.isArray(value['sources']) || value['sources'].length > MARKET_SOURCES.length)
    return undefined;
  const sources: MarketFeedConfig['sources'] = [];
  for (const entry of value['sources']) {
    if (!isRecord(entry) || !(MARKET_SOURCES as readonly unknown[]).includes(entry['source'])) return undefined;
    const request = entry['request'];
    if (!isRecord(request) || request['method'] !== 'GET' || typeof request['url'] !== 'string') return undefined;
    sources.push({ source: entry['source'] as MarketSource, request: { url: request['url'], method: 'GET' } });
  }
  return { sources };
}

/** The page's `set_buy_orders_lease`; null when it is not one (the engine then keeps what it had). */
export function parseBuyOrdersLeasePush(value: unknown): BuyOrdersLeasePush | null {
  if (!isRecord(value)) return null;
  const { clerkId, requestedAt, receivedAt } = value;
  if (typeof clerkId !== 'string' || !CLERK_ID.test(clerkId) || !time(requestedAt) || !time(receivedAt)) return null;
  if (receivedAt < requestedAt) return null;
  const status = value['status'] === null ? null : parseBuyOrdersEngineStatus(value['status']);
  if (value['status'] !== null && !status) return null;
  if (status && status.clerkId !== clerkId) return null;
  const feed = parseFeedConfig(value['feed']);
  if (feed === undefined) return null;
  return { clerkId, status, requestedAt, receivedAt, feed };
}

/** The server's answer to an attempt's open (`POST /api/buy-orders/engine/attempts`); null when it is not one. */
export function parseBuyOrderAttemptOpenResponse(value: unknown): BuyOrderAttemptOpenResponse | null {
  if (!isRecord(value) || value['state'] !== 'pending' || typeof value['attemptId'] !== 'string') return null;
  const spend = parseBuyOrdersSpend(value['spend']);
  if (!spend || !time(value['serverNow'])) return null;
  return { attemptId: value['attemptId'], state: 'pending', serverNow: value['serverNow'], spend };
}

const ANSWER_CODE = /^[a-z0-9_]{1,64}$/;

/** The page's answer to an engine request; null when it is not one. */
export function parseBuyOrdersEngineAnswer(value: unknown): BuyOrdersEngineAnswer | null {
  if (!isRecord(value) || typeof value['requestId'] !== 'string' || value['requestId'].length > 64) return null;
  const requestId = value['requestId'];
  switch (value['kind']) {
    case 'open': {
      if (value['outcome'] === 'failed') return { requestId, kind: 'open', outcome: 'failed' };
      if (value['outcome'] === 'refused')
        return typeof value['code'] === 'string' && ANSWER_CODE.test(value['code'])
          ? { requestId, kind: 'open', outcome: 'refused', code: value['code'] }
          : null;
      const response = value['outcome'] === 'opened' ? parseBuyOrderAttemptOpenResponse(value['response']) : null;
      return response ? { requestId, kind: 'open', outcome: 'opened', response } : null;
    }
    case 'estimates': {
      const estimates = value['estimates'];
      if (estimates === null) return { requestId, kind: 'estimates', estimates: null };
      if (!isRecord(estimates)) return null;
      const parsed: Record<string, number | null> = {};
      for (const [key, cents] of Object.entries(estimates)) {
        if (key.length > 100) return null;
        if (cents !== null && !(wholeCents(cents) && cents > 0)) return null;
        parsed[key] = cents;
      }
      return { requestId, kind: 'estimates', estimates: parsed };
    }
    case 'settle':
    case 'pause_rule':
    case 'renew':
      return typeof value['ok'] === 'boolean' ? { requestId, kind: value['kind'], ok: value['ok'] } : null;
    default:
      return null;
  }
}

function parseActivityListing(value: unknown): BuyOrderActivityListing | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !(MARKET_SOURCES as readonly unknown[]).includes(value['source'])) return undefined;
  const { listingId, marketHashName, priceCents, floatValue, paintSeed } = value;
  if (typeof listingId !== 'string' || typeof marketHashName !== 'string' || !wholeCents(priceCents)) return undefined;
  if (floatValue !== null && typeof floatValue !== 'number') return undefined;
  if (paintSeed !== null && typeof paintSeed !== 'number') return undefined;
  return {
    source: value['source'] as MarketSource,
    listingId,
    marketHashName,
    priceCents,
    floatValue: floatValue as number | null,
    paintSeed: paintSeed as number | null,
  };
}

const VALUE_KEYS: readonly (keyof BuyOrderActivityValues)[] = [
  'limitCents',
  'spentCents',
  'budgetCents',
  'shortCents',
  'items',
  'maxItems',
  'discountPct',
  'wantPct',
  'newPriceCents',
  'failures',
];

/** One activity entry as the extension sends it; null when it is not one. */
export function parseBuyOrderActivity(value: unknown): BuyOrderActivity | null {
  if (!isRecord(value)) return null;
  const { id, at, kind, ruleId, ruleName, reason } = value;
  if (typeof id !== 'string' || !time(at) || !(BUY_ORDER_ACTIVITY_KINDS as readonly unknown[]).includes(kind))
    return null;
  if (ruleId !== null && (typeof ruleId !== 'string' || !RULE_ID.test(ruleId))) return null;
  if (ruleName !== null && typeof ruleName !== 'string') return null;
  if (reason !== null && (typeof reason !== 'string' || !/^[a-z0-9_:.-]{1,64}$/.test(reason))) return null;
  const listing = parseActivityListing(value['listing']);
  if (listing === undefined) return null;
  const values: BuyOrderActivityValues = {};
  if (value['values'] !== undefined) {
    if (!isRecord(value['values'])) return null;
    for (const key of VALUE_KEYS) {
      const entry = value['values'][key];
      if (entry === undefined) continue;
      if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
      values[key] = entry;
    }
  }
  const outcome = value['outcome'];
  if (outcome !== undefined && !isMarketBuyOutcome(outcome)) return null;
  const latencyMs = value['latencyMs'];
  if (latencyMs !== undefined && !(typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0))
    return null;
  const attemptId = value['attemptId'];
  if (attemptId !== undefined && typeof attemptId !== 'string') return null;
  return {
    id,
    at,
    kind: kind as BuyOrderActivityKind,
    ruleId: ruleId as string | null,
    ruleName: ruleName as string | null,
    listing,
    reason: reason as string | null,
    ...(Object.keys(values).length ? { values } : {}),
    ...(outcome !== undefined ? { outcome: outcome as MarketBuyOutcome } : {}),
    ...(latencyMs !== undefined ? { latencyMs: latencyMs as number } : {}),
    ...(attemptId !== undefined ? { attemptId: attemptId as string } : {}),
  };
}

function parseRuntime(value: unknown): BuyOrderRuleRuntime | null {
  if (!isRecord(value)) return null;
  const { failures, pausedAt, testItems, testCents } = value;
  if (!wholeCents(failures) || !wholeCents(testItems) || !wholeCents(testCents)) return null;
  if (pausedAt !== null && !time(pausedAt)) return null;
  return { failures, pausedAt, testItems, testCents };
}

/** The extension's engine view as the page reads it; null when it is not one. */
export function parseBuyOrdersEngineView(value: unknown): BuyOrdersEngineView | null {
  if (!isRecord(value) || !isBuyOrderDeviceId(value['deviceId'])) return null;
  const { state, clerkId, canBuy, stoppedHere, holder, leaseUntil, lastFeedAt, now } = value;
  if (!(BUY_ORDER_ENGINE_STATES as readonly unknown[]).includes(state) || typeof canBuy !== 'boolean' || !time(now))
    return null;
  if (typeof stoppedHere !== 'boolean') return null;
  if (clerkId !== null && (typeof clerkId !== 'string' || !CLERK_ID.test(clerkId))) return null;
  if (leaseUntil !== null && !time(leaseUntil)) return null;
  if (lastFeedAt !== null && !time(lastFeedAt)) return null;
  let parsedHolder: BuyOrdersEngineView['holder'] = null;
  if (holder !== null) {
    if (!isRecord(holder) || !time(holder['renewedAt'])) return null;
    const label = holder['deviceLabel'] === null ? null : cleanDeviceLabel(holder['deviceLabel']);
    parsedHolder = { deviceLabel: label, renewedAt: holder['renewedAt'] };
  }
  const spend = value['spend'] === null ? null : parseBuyOrdersSpend(value['spend']);
  if (value['spend'] !== null && !spend) return null;
  if (!isRecord(value['rules']) || !Array.isArray(value['activity'])) return null;
  const rules: Record<string, BuyOrderRuleRuntime> = {};
  for (const [id, runtime] of Object.entries(value['rules'])) {
    const parsed = parseRuntime(runtime);
    if (!RULE_ID.test(id) || !parsed) return null;
    rules[id] = parsed;
  }
  const activity = value['activity'].flatMap((entry) => {
    const parsed = parseBuyOrderActivity(entry);
    return parsed ? [parsed] : [];
  });
  return {
    ...(typeof value['requestId'] === 'string' ? { requestId: value['requestId'].slice(0, 64) } : {}),
    deviceId: (value['deviceId'] as string).toLowerCase(),
    state: state as BuyOrdersEngineState,
    clerkId: clerkId as string | null,
    stoppedHere,
    canBuy,
    holder: parsedHolder,
    leaseUntil: leaseUntil as number | null,
    lastFeedAt: lastFeedAt as number | null,
    spend,
    rules,
    activity: activity.slice(0, BUY_ORDER_ACTIVITY_MAX),
    now: now as number,
  };
}
