
import { MARKET_CATEGORIES, MARKET_PHASES, MARKET_SOURCES, MARKET_WEARS } from './market-views';
import type { MarketCategory, MarketPhase, MarketSource, MarketWear } from './market-views';

/** `auto`: buys when a listing matches (within every guard). `test`: logs what it would buy and buys nothing. */
export const BUY_ORDER_MODES = ['auto', 'test'] as const;
export type BuyOrderMode = (typeof BUY_ORDER_MODES)[number];

/** What the server accepts. Money in USD cents. */
export const BUY_ORDER_BOUNDS = {
  /** Rules per account, switched on or off. */
  rules: 50,
  /** Rules switched on at once (Test mode counts: it reads the feed as well). */
  active: 10,
  nameLength: 40,
  /** The item and sticker text fields. */
  textLength: 128,
  seeds: 40,
  seedMax: 1000,
  /** A rule's price limit: $100,000. */
  priceCentsMax: 10_000_000,
  /** A rule's and the account's daily budget: $100,000. */
  budgetCentsMax: 10_000_000,
  /** The account's daily budget: at least $1. */
  accountBudgetCentsMin: 100,
  itemsPerDayMax: 100,
  /** "Below the QTS estimate by at least X %": X with at most one decimal. */
  belowEstimatePct: { min: 1, max: 95 },
  /** Sticker premium at most X %: X with at most two decimals. */
  stickerPremiumPct: { min: 0, max: 1000 },
} as const;

/** What a rule buys and at what limits: the fields the editor edits. Every field is always present. */
export interface BuyOrderRuleFields {
  name: string;
  /**
   * Empty: any item. A name without a wear (`AK-47 | Redline`, `★ Karambit | Doppler`, `Kilowatt Case`): every copy of
   * it, the category field narrowing StatTrak™ / Souvenir. A full market_hash_name with a wear
   * (`StatTrak™ M4A1-S | Printstream (Minimal Wear)`): exactly that name.
   */
  item: string;
  category: MarketCategory;
  /** 0–1, both ends included; null = no bound. */
  minFloat: number | null;
  maxFloat: number | null;
  /** Empty: every wear. */
  wears: readonly MarketWear[];
  /** Empty: every seed. */
  seeds: readonly number[];
  phase: MarketPhase | null;
  /** A sticker the item carries (any part of its name); empty: no sticker condition. */
  sticker: string;
  /** What the listing asks over the clean item, as a share of its stickers' value, at most this (percent). */
  maxStickerPremiumPct: number | null;
  /** Where the rule buys; at least one. */
  sources: readonly MarketSource[];
  /** The highest price the rule pays, cents. With `belowEstimatePct` both must hold; at least one of the two is set. */
  maxPriceCents: number | null;
  /** Only listings at least this many percent below the QTS estimate (a listing without one is skipped). */
  belowEstimatePct: number | null;
  /** Items the rule buys per UTC day. */
  maxItemsPerDay: number;
  /** What the rule spends per UTC day, cents (the account's daily budget applies on top). */
  dailyBudgetCents: number;
}

export interface BuyOrderRule extends BuyOrderRuleFields {
  /** Server-made, stable. */
  id: string;
  /** Switched on: it reads the feed (in `mode`). */
  enabled: boolean;
  mode: BuyOrderMode;
  /** ISO times on the server's clock. */
  createdAt: string;
  updatedAt: string;
}

/** `POST /api/buy-orders/rules`: a new rule always starts in Test mode (R-F1), so it has no `mode`. */
export interface BuyOrderRuleCreate extends BuyOrderRuleFields {
  enabled: boolean;
}

/** `PUT /api/buy-orders/rules/:id`: the rule as a whole. */
export interface BuyOrderRuleUpdate extends BuyOrderRuleFields {
  enabled: boolean;
  mode: BuyOrderMode;
}

/** `PATCH /api/buy-orders/rules/:id`: switch it on or off, or change its mode; at least one. */
export interface BuyOrderRuleToggle {
  enabled?: boolean;
  mode?: BuyOrderMode;
}

/** `PUT /api/buy-orders/budget`. It has no default and, once set, can be changed but not removed. */
export interface BuyOrdersBudgetUpdate {
  dailyBudgetCents: number;
}

/** `PUT /api/buy-orders/order`: every rule id once, in the new order. */
export interface BuyOrdersReorder {
  ids: string[];
}

/** Every answer of `/api/buy-orders`: the account's rules and limits after the call. */
export interface BuyOrdersState {
  /** Raised by every change; 0 before the first. The extension keeps only a newer state. */
  revision: number;
  /** The account's daily limit for all buy orders together; null until the user sets it (no default, R-F1). */
  dailyBudgetCents: number | null;
  /**
   * In priority order: when several rules match one listing, the first one buys it (R-F4). A rule in `auto` mode needs
   * the account's daily budget; at most {@link BUY_ORDER_BOUNDS}.active are enabled.
   */
  rules: BuyOrderRule[];
  /** ISO; null before the first change. */
  updatedAt: string | null;
}

/** Page → extension `set_buy_orders`: the server's state for this Clerk user. */
export interface BuyOrdersSnapshot extends BuyOrdersState {
  clerkId: string;
}

/** Extension → page `buy_orders_set`: whether the snapshot replaced the stored one. */
export type BuyOrdersSetResult = { stored: boolean; revision: number } | { error: string };

/** The 409/400 codes of `/api/buy-orders` beyond plain validation. */
export const BUY_ORDER_ERRORS = {
  /** A rule in `auto` mode, switched on, needs the account's daily budget first. */
  budgetRequired: 'buy_orders_budget_required',
  /** Switching this rule on would make more than 10 active. */
  activeLimit: 'buy_orders_active_limit',
  /** The account has 50 rules. */
  rulesLimit: 'buy_orders_rules_limit',
  /** Neither a price limit nor an estimate discount. */
  priceLimitRequired: 'buy_orders_price_limit_required',
  /** Min float above max float. */
  floatRange: 'buy_orders_float_range',
  ruleNotFound: 'buy_orders_rule_not_found',
  /** `order` does not name every rule exactly once. */
  orderMismatch: 'buy_orders_order_mismatch',
  /** Too many concurrent writes; try again. */
  busy: 'buy_orders_busy',
} as const;

// ─── Parsing (web: the server's answer; extension: a pushed snapshot) ─────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const B = BUY_ORDER_BOUNDS;

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function nullableRange(value: unknown, min: number, max: number): boolean {
  return value === null || inRange(value, min, max);
}

function cents(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && inRange(value, min, max);
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function subset<T extends string>(value: unknown, allowed: readonly T[], { nonEmpty = false } = {}): value is T[] {
  return (
    Array.isArray(value) &&
    value.length <= allowed.length &&
    (!nonEmpty || value.length > 0) &&
    new Set(value).size === value.length &&
    value.every((entry) => (allowed as readonly unknown[]).includes(entry))
  );
}

/** At most one decimal: 8, 7.5; not 7.55 (the estimate discount). */
export function isTenthPercent(value: number): boolean {
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
}

/** At most two decimals (the sticker premium limit). */
export function isHundredthPercent(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}

function seedsOk(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= B.seeds &&
    new Set(value).size === value.length &&
    value.every((seed: unknown) => typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= B.seedMax)
  );
}

/** The rule fields as the server keeps them, or null when one is outside the contract. */
export function parseBuyOrderRuleFields(value: unknown): BuyOrderRuleFields | null {
  if (!isRecord(value)) return null;
  const v = value;
  const name = v['name'];
  if (!text(name, B.nameLength) || name.trim() === '') return null;
  if (!text(v['item'], B.textLength) || !text(v['sticker'], B.textLength)) return null;
  if (!(MARKET_CATEGORIES as readonly unknown[]).includes(v['category'])) return null;
  if (!nullableRange(v['minFloat'], 0, 1) || !nullableRange(v['maxFloat'], 0, 1)) return null;
  const minFloat = v['minFloat'] as number | null;
  const maxFloat = v['maxFloat'] as number | null;
  if (minFloat !== null && maxFloat !== null && minFloat > maxFloat) return null;
  if (!subset(v['wears'], MARKET_WEARS) || !seedsOk(v['seeds'])) return null;
  if (v['phase'] !== null && !(MARKET_PHASES as readonly unknown[]).includes(v['phase'])) return null;
  const premium = v['maxStickerPremiumPct'];
  if (!nullableRange(premium, B.stickerPremiumPct.min, B.stickerPremiumPct.max)) return null;
  if (premium !== null && !isHundredthPercent(premium as number)) return null;
  if (!subset(v['sources'], MARKET_SOURCES, { nonEmpty: true })) return null;
  const maxPriceCents = v['maxPriceCents'];
  if (maxPriceCents !== null && !cents(maxPriceCents, 1, B.priceCentsMax)) return null;
  const below = v['belowEstimatePct'];
  if (below !== null && !(inRange(below, B.belowEstimatePct.min, B.belowEstimatePct.max) && isTenthPercent(below)))
    return null;
  if (maxPriceCents === null && below === null) return null;
  if (!Number.isSafeInteger(v['maxItemsPerDay']) || !inRange(v['maxItemsPerDay'], 1, B.itemsPerDayMax)) return null;
  if (!cents(v['dailyBudgetCents'], 1, B.budgetCentsMax)) return null;
  return {
    name,
    item: v['item'],
    category: v['category'] as MarketCategory,
    minFloat,
    maxFloat,
    wears: [...(v['wears'] as MarketWear[])],
    seeds: [...(v['seeds'] as number[])],
    phase: v['phase'] as MarketPhase | null,
    sticker: v['sticker'],
    maxStickerPremiumPct: premium as number | null,
    sources: [...(v['sources'] as MarketSource[])],
    maxPriceCents: maxPriceCents as number | null,
    belowEstimatePct: below as number | null,
    maxItemsPerDay: v['maxItemsPerDay'] as number,
    dailyBudgetCents: v['dailyBudgetCents'] as number,
  };
}

function isoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export function parseBuyOrderRule(value: unknown): BuyOrderRule | null {
  if (!isRecord(value)) return null;
  const fields = parseBuyOrderRuleFields(value);
  const { id, enabled, mode, createdAt, updatedAt } = value;
  if (!fields || typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || typeof enabled !== 'boolean') return null;
  if (!(BUY_ORDER_MODES as readonly unknown[]).includes(mode) || !isoTime(createdAt) || !isoTime(updatedAt))
    return null;
  return { ...fields, id, enabled, mode: mode as BuyOrderMode, createdAt, updatedAt };
}

/**
 * The account's buy orders as the server answers them, or null when anything is outside the contract (one bad rule
 * refuses the whole state: a rule set that buys must never be read partly). The account invariants are checked too.
 */
export function parseBuyOrdersState(value: unknown): BuyOrdersState | null {
  if (!isRecord(value) || !Array.isArray(value['rules'])) return null;
  const { revision, dailyBudgetCents, updatedAt } = value;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return null;
  if (dailyBudgetCents !== null && !cents(dailyBudgetCents, B.accountBudgetCentsMin, B.budgetCentsMax)) return null;
  if (updatedAt !== null && !isoTime(updatedAt)) return null;
  if (value['rules'].length > B.rules) return null;
  const rules: BuyOrderRule[] = [];
  for (const raw of value['rules']) {
    const rule = parseBuyOrderRule(raw);
    if (!rule || rules.some((other) => other.id === rule.id)) return null;
    rules.push(rule);
  }
  if (rules.filter((rule) => rule.enabled).length > B.active) return null;
  if (dailyBudgetCents === null && rules.some((rule) => rule.enabled && rule.mode === 'auto')) return null;
  return {
    revision: revision as number,
    dailyBudgetCents: dailyBudgetCents as number | null,
    rules,
    updatedAt: updatedAt as string | null,
  };
}

/** A pushed snapshot (`set_buy_orders`): a Clerk user id and a valid state. */
export function parseBuyOrdersSnapshot(value: unknown): BuyOrdersSnapshot | null {
  if (!isRecord(value)) return null;
  const clerkId = value['clerkId'];
  if (typeof clerkId !== 'string' || !/^user_[A-Za-z0-9]{1,64}$/.test(clerkId)) return null;
  const state = parseBuyOrdersState(value);
  return state ? { ...state, clerkId } : null;
}
