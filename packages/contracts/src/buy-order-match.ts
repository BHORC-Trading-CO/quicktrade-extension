/**
 * Does a feed listing match a QTS buy order? (QUICK-232, R-F1/R-F6.) One pure, deterministic function shared by the
 * editor's preview (web) and the buy-order engine (extension, T11): the same rule and listing always give the same
 * answer and the same reasons, in the same order. Missing data never matches: a condition that needs a value the
 * listing (or the context) does not have fails with its own `*_unknown` reason.
 *
 * It judges one listing against one rule only. The money guards that need state (daily budgets spent, items bought
 * today, the platform balance, one try per listing, R-F3) are the engine's.
 */
import type { BuyOrderRuleFields } from './buy-orders';
import { MARKET_PHASES } from './market-views';
import type { MarketPhase, MarketSource, MarketWear } from './market-views';


export interface BuyOrderListingSticker {
  name: string;
  priceCents: number | null;
}

/**
 * One listing of the live feed, as the matcher reads it. The feed buffer (T9) keeps entries that map onto this shape;
 * nothing else of a marketplace row is read.
 */
export interface BuyOrderListing {
  source: MarketSource;
  /** CSFloat's listing id, cs.money's sell-order id (market) or item id (bots). */
  listingId: string;
  /** Steam's market_hash_name as the marketplace spells it (cs.money puts a Doppler phase in it, CSFloat does not). */
  marketHashName: string;
  /** The asked price, integer USD cents, as the marketplace shows it to a buyer. */
  priceCents: number;
  /** Null when the item has no float or the marketplace did not say. */
  floatValue: number | null;
  paintSeed: number | null;
  /** The Doppler / Gamma Doppler phase when the marketplace tells it apart from the name (CSFloat's paint index). */
  phase: MarketPhase | null;
  stickers: readonly BuyOrderListingSticker[];
  /** CSFloat's own estimate of this copy (its predicted price), cents: the clean price for the sticker premium without a QTS estimate. */
  referencePriceCents: number | null;
  /** When the feed first saw it, epoch ms (the preview's hour, the engine's latency). */
  seenAt: number;
}

/** What the caller knows about the listing beyond the marketplace row. */
export interface BuyOrderMatchContext {
  /** The QTS estimate of this listing, integer USD cents; null when there is none or it was not looked up. */
  estimateCents: number | null;
}

/** Why a listing does not match, one entry per failed condition, in the order the conditions are listed here. */
export type BuyOrderMismatch =
  | { code: 'source' }
  | { code: 'item' }
  | { code: 'category' }
  | { code: 'float_unknown' }
  | { code: 'float_range'; floatValue: number }
  | { code: 'wear_unknown' }
  | { code: 'wear'; wear: MarketWear }
  | { code: 'seed_unknown' }
  | { code: 'seed'; paintSeed: number }
  | { code: 'phase_unknown' }
  | { code: 'phase'; phase: MarketPhase }
  | { code: 'sticker' }
  | { code: 'price_invalid' }
  | { code: 'price_above_limit'; priceCents: number; limitCents: number }
  | { code: 'estimate_unknown' }
  /** `discountPct`: how far below the estimate the price is (negative: above it), rounded down to a tenth. */
  | { code: 'discount_too_small'; discountPct: number; wantPct: number }
  | { code: 'sticker_premium_unknown' }
  | { code: 'sticker_premium'; premiumPct: number; limitPct: number };

export type BuyOrderMismatchCode = BuyOrderMismatch['code'];

export interface BuyOrderMatch {
  match: boolean;
  /** Empty exactly when `match` is true. */
  reasons: BuyOrderMismatch[];
}

// ─── Item names ───────────────────────────────────────────────────────────────

const WEAR_BY_NAME: Readonly<Record<string, MarketWear>> = {
  'Factory New': 'FN',
  'Minimal Wear': 'MW',
  'Field-Tested': 'FT',
  'Well-Worn': 'WW',
  'Battle-Scarred': 'BS',
};

/** Float bounds per wear, the upper bound exclusive (Battle-Scarred includes 1). */
const WEAR_FLOATS: Readonly<Record<MarketWear, readonly [number, number]>> = {
  FN: [0, 0.07],
  MW: [0.07, 0.15],
  FT: [0.15, 0.38],
  WW: [0.38, 0.45],
  BS: [0.45, 1],
};

/** Phases longest first, so `Black Pearl` is read as a whole. */
const PHASES_LONGEST_FIRST = [...MARKET_PHASES].sort((a, b) => b.length - a.length);

/** An item name taken apart: the base name compares case-insensitively; prefixes, wear and phase are read separately. */
export interface ParsedItemName {
  /** Without `★`, `StatTrak™` / `Souvenir`, the wear and a Doppler phase, as written (`AK-47 | Redline`). */
  name: string;
  /** `name` in lower case: what names compare by. */
  base: string;
  statTrak: boolean;
  souvenir: boolean;
  wear: MarketWear | null;
  /** A phase spelled in the name (`… | Doppler Ruby (Factory New)`, cs.money). */
  phase: MarketPhase | null;
}

export function parseItemName(name: string): ParsedItemName {
  let rest = name.trim();
  let statTrak = false;
  let souvenir = false;
  // `★ StatTrak™ Karambit | …`: the star first, then the category prefix.
  for (;;) {
    if (rest.startsWith('★')) rest = rest.slice(1).trimStart();
    else if (rest.startsWith('StatTrak™')) {
      statTrak = true;
      rest = rest.slice('StatTrak™'.length).trimStart();
    } else if (rest.startsWith('Souvenir ')) {
      souvenir = true;
      rest = rest.slice('Souvenir '.length).trimStart();
    } else break;
  }
  let wear: MarketWear | null = null;
  const wearMatch = /\s*\(([^()]+)\)$/.exec(rest);
  const wearName = wearMatch?.[1];
  if (wearMatch && wearName !== undefined && WEAR_BY_NAME[wearName]) {
    wear = WEAR_BY_NAME[wearName] ?? null;
    rest = rest.slice(0, wearMatch.index).trimEnd();
  }
  let phase: MarketPhase | null = null;
  if (/Doppler/.test(rest)) {
    for (const candidate of PHASES_LONGEST_FIRST) {
      if (rest.endsWith(` ${candidate}`)) {
        phase = candidate;
        rest = rest.slice(0, -(candidate.length + 1)).trimEnd();
        break;
      }
    }
  }
  return { name: rest, base: rest.toLowerCase(), statTrak, souvenir, wear, phase };
}

/**
 * The rule's item against a listing name. Empty: any item. A name with a wear is one market_hash_name: the same base,
 * wear and category prefix. A name without a wear: the same base; a prefix or a phase written in it must be there too.
 */
export function itemMatches(ruleItem: string, listingName: string): boolean {
  if (ruleItem.trim() === '') return true;
  const rule = parseItemName(ruleItem);
  const listed = parseItemName(listingName);
  if (rule.base !== listed.base) return false;
  if (rule.wear !== null) {
    if (listed.wear !== rule.wear || listed.statTrak !== rule.statTrak || listed.souvenir !== rule.souvenir)
      return false;
  } else {
    if (rule.statTrak && !listed.statTrak) return false;
    if (rule.souvenir && !listed.souvenir) return false;
  }
  return rule.phase === null || listed.phase === rule.phase;
}

/** The wear of a float by the standard bounds; null outside 0–1 or for no float. */
export function wearOfFloatValue(floatValue: number): MarketWear | null {
  if (!Number.isFinite(floatValue) || floatValue < 0 || floatValue > 1) return null;
  for (const [wear, [min, max]] of Object.entries(WEAR_FLOATS) as Array<[MarketWear, readonly [number, number]]>) {
    if (floatValue >= min && (floatValue < max || (wear === 'BS' && floatValue <= max))) return wear;
  }
  return null;
}

function stickerKey(name: string): string {
  return name
    .trim()
    .replace(/^Sticker \|\s*/i, '')
    .toLowerCase();
}

/** Rounded toward zero to a tenth, for a reason a person reads (the comparison itself is exact). */
function tenthDown(value: number): number {
  return Math.trunc(value * 10) / 10;
}

// ─── The matcher ─────────────────────────────────────────────────────────────

/**
 * Every condition the rule sets, checked on the listing; all must hold (R-F1). The result lists every condition that
 * failed, so the preview and the activity log can say why. Integer cents throughout: the estimate discount is compared
 * as `price × 1000 ≤ estimate × (1000 − tenths of a percent)`.
 */
export function matchBuyOrderRule(
  rule: BuyOrderRuleFields,
  listing: BuyOrderListing,
  ctx: BuyOrderMatchContext
): BuyOrderMatch {
  const reasons: BuyOrderMismatch[] = [];
  const parsed = parseItemName(listing.marketHashName);

  if (!rule.sources.includes(listing.source)) reasons.push({ code: 'source' });
  if (!itemMatches(rule.item, listing.marketHashName)) reasons.push({ code: 'item' });

  if (
    (rule.category === 'normal' && (parsed.statTrak || parsed.souvenir)) ||
    (rule.category === 'stattrak' && !parsed.statTrak) ||
    (rule.category === 'souvenir' && !parsed.souvenir)
  ) {
    reasons.push({ code: 'category' });
  }

  const floatValue =
    listing.floatValue !== null && Number.isFinite(listing.floatValue) && listing.floatValue > 0
      ? listing.floatValue
      : null;
  if (rule.minFloat !== null || rule.maxFloat !== null) {
    if (floatValue === null) reasons.push({ code: 'float_unknown' });
    else if (
      (rule.minFloat !== null && floatValue < rule.minFloat) ||
      (rule.maxFloat !== null && floatValue > rule.maxFloat)
    ) {
      reasons.push({ code: 'float_range', floatValue });
    }
  }

  if (rule.wears.length > 0) {
    const wear = (floatValue === null ? null : wearOfFloatValue(floatValue)) ?? parsed.wear;
    if (wear === null) reasons.push({ code: 'wear_unknown' });
    else if (!rule.wears.includes(wear)) reasons.push({ code: 'wear', wear });
  }

  if (rule.seeds.length > 0) {
    const seed = listing.paintSeed;
    if (seed === null || !Number.isInteger(seed)) reasons.push({ code: 'seed_unknown' });
    else if (!rule.seeds.includes(seed)) reasons.push({ code: 'seed', paintSeed: seed });
  }

  if (rule.phase !== null) {
    const phase = listing.phase ?? parsed.phase;
    if (phase === null) reasons.push({ code: 'phase_unknown' });
    else if (phase !== rule.phase) reasons.push({ code: 'phase', phase });
  }

  const sticker = stickerKey(rule.sticker);
  if (sticker !== '' && !listing.stickers.some((s) => stickerKey(s.name).includes(sticker)))
    reasons.push({ code: 'sticker' });

  const price = listing.priceCents;
  const priceValid = Number.isSafeInteger(price) && price > 0;
  if (!priceValid) reasons.push({ code: 'price_invalid' });
  if (priceValid && rule.maxPriceCents !== null && price > rule.maxPriceCents) {
    reasons.push({ code: 'price_above_limit', priceCents: price, limitCents: rule.maxPriceCents });
  }

  const estimate =
    ctx.estimateCents !== null && Number.isSafeInteger(ctx.estimateCents) && ctx.estimateCents > 0
      ? ctx.estimateCents
      : null;
  if (rule.belowEstimatePct !== null) {
    if (estimate === null) reasons.push({ code: 'estimate_unknown' });
    else if (priceValid) {
      const tenths = Math.round(rule.belowEstimatePct * 10);
      if (price * 1000 > estimate * (1000 - tenths)) {
        reasons.push({
          code: 'discount_too_small',
          discountPct: tenthDown(((estimate - price) / estimate) * 100),
          wantPct: rule.belowEstimatePct,
        });
      }
    }
  }

  if (rule.maxStickerPremiumPct !== null && listing.stickers.length > 0) {
    // Only the priced stickers count: a smaller value makes the premium higher, never lower, so the limit stays safe.
    const valueCents = listing.stickers.reduce(
      (sum, s) => sum + (s.priceCents !== null && s.priceCents > 0 ? s.priceCents : 0),
      0
    );
    const reference =
      listing.referencePriceCents !== null &&
      Number.isSafeInteger(listing.referencePriceCents) &&
      listing.referencePriceCents > 0
        ? listing.referencePriceCents
        : null;
    const clean = estimate ?? reference;
    if (valueCents <= 0 || clean === null || !priceValid) reasons.push({ code: 'sticker_premium_unknown' });
    else {
      // Premium ≤ limit ⇔ max(0, price − clean) × 100 ≤ limit × value; the limit has at most two decimals.
      const over = Math.max(0, price - clean);
      const limitHundredths = Math.round(rule.maxStickerPremiumPct * 100);
      if (over * 10_000 > limitHundredths * valueCents) {
        reasons.push({
          code: 'sticker_premium',
          premiumPct: tenthDown((over / valueCents) * 100),
          limitPct: rule.maxStickerPremiumPct,
        });
      }
    }
  }

  return { match: reasons.length === 0, reasons };
}

/** The conditions that say "not this item at all" (rather than "this item, but not at this price or copy"). */
export const BUY_ORDER_IDENTITY_MISMATCHES: ReadonlySet<BuyOrderMismatchCode> = new Set<BuyOrderMismatchCode>([
  'source',
  'item',
  'category',
]);

/** The listing is the rule's item on one of its platforms, whatever else failed: a near miss worth showing. */
export function isNearMiss(result: BuyOrderMatch): boolean {
  return !result.match && result.reasons.every((reason) => !BUY_ORDER_IDENTITY_MISMATCHES.has(reason.code));
}
