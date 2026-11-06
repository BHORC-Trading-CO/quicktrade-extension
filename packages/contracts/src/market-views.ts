/**
 * The Market page's filters as the account keeps them (QUICK-216 / QUICK-224, R-A3): the filters of the last search
 * and the user's named views, stored with the account's settings (`/api/auth/me/settings`, field `marketViews`). The
 * server imports this module as types only and repeats the value lists and bounds; a typed copy fails on drift.
 */

/** Where Market searches: CSFloat buy-now listings, cs.money's user market and cs.money's bot inventory. */
export const MARKET_SOURCES = ['csfloat', 'csmoney-market', 'csmoney-bots'] as const;
export type MarketSource = (typeof MARKET_SOURCES)[number];

/** Any item, or only Normal / StatTrak™ / Souvenir copies. */
export const MARKET_CATEGORIES = ['any', 'normal', 'stattrak', 'souvenir'] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

/** Newest first, the biggest discount to the QTS estimate first, price up or down, the lowest float first. */
export const MARKET_SORTS = ['newest', 'discount', 'price-asc', 'price-desc', 'float-asc'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

export const MARKET_WEARS = ['FN', 'MW', 'FT', 'WW', 'BS'] as const;
export type MarketWear = (typeof MARKET_WEARS)[number];

/** Doppler and Gamma Doppler phases, spelled as the item names spell them. */
export const MARKET_PHASES = [
  'Phase 1',
  'Phase 2',
  'Phase 3',
  'Phase 4',
  'Ruby',
  'Sapphire',
  'Black Pearl',
  'Emerald',
] as const;
export type MarketPhase = (typeof MARKET_PHASES)[number];

/** What the server accepts; the web clamps or drops a value outside them before saving. */
export const MARKET_VIEWS_BOUNDS = {
  /** Named views per account. */
  saved: 20,
  nameLength: 40,
  /** The item and sticker text fields. */
  textLength: 128,
  /** Paint seeds per search (CSFloat takes at most 40 in one request). */
  seeds: 40,
  seedMax: 1000,
  /** USD. */
  priceMax: 1_000_000,
  belowEstimatePct: { min: 1, max: 95 },
  stickerPremiumPct: { min: 0, max: 1000 },
} as const;

/** One set of Market filters. Prices are USD, floats 0–1, percentages whole or decimal numbers. */
export interface MarketFilters {
  sources: readonly MarketSource[];
  /** A skin without wear (`AK-47 | Redline`), an exact item name, or empty for any item. */
  item: string;
  category: MarketCategory;
  minFloat: number | null;
  maxFloat: number | null;
  /** Selected wear buttons; empty for every wear. */
  wears: readonly MarketWear[];
  seeds: readonly number[];
  phase: MarketPhase | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** Only listings at least this many percent below the QTS estimate (a listing without one is left out). */
  belowEstimatePct: number | null;
  /** A sticker the item carries (any part of its name). */
  sticker: string;
  /** Sticker premium (what the listing asks over the clean item, as a share of the stickers' value) at most this. */
  maxStickerPremiumPct: number | null;
  rarePatternsOnly: boolean;
  hideUnaffordable: boolean;
  sort: MarketSort;
}

export interface MarketView {
  name: string;
  filters: MarketFilters;
}

/** `AccountSettings.marketViews`: the filters of the last search (null before the first) and the named views. */
export interface MarketViews {
  current: MarketFilters | null;
  saved: readonly MarketView[];
}

export const MARKET_FILTERS_DEFAULTS = {
  sources: ['csfloat', 'csmoney-market', 'csmoney-bots'],
  item: '',
  category: 'any',
  minFloat: null,
  maxFloat: null,
  wears: [],
  seeds: [],
  phase: null,
  minPrice: null,
  maxPrice: null,
  belowEstimatePct: null,
  sticker: '',
  maxStickerPremiumPct: null,
  rarePatternsOnly: false,
  hideUnaffordable: false,
  sort: 'newest',
} as const satisfies MarketFilters;

export const MARKET_VIEWS_DEFAULTS = { current: null, saved: [] } as const satisfies MarketViews;
