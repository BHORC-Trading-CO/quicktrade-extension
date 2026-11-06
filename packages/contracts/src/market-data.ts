/**
 * Market card data (QUICK-228): what the QTS server tells the Market page about the external price layers.
 * Display only: nothing here is ever a buying or selling price.
 */

/** `GET /api/market/config`: which optional data layers the server lets the page use. */
export interface MarketConfigResponse {
  /** BetterFloat's Buff163 / YouPin / Steam price files (server switch BF_PRICES_ENABLED, off unless "true"). */
  betterFloatPrices: boolean;
}

/** CS2 paint seeds run 0..1000: the highest seed any lookup (blue gem, pattern premium, name estimate) accepts. */
export const PAINT_SEED_MAX = 1000;
/** At most this many past sales per answer, newest first. */
export const BLUE_GEM_MAX_SALES = 50;

/** How much of one side of a Case Hardened / Heat Treated seed is blue, purple and gold, in percent (BetterFloat). */
export interface BlueGemColours {
  bluePct: number;
  purplePct?: number;
  goldPct?: number;
}

/** One past sale of the same skin and seed that BetterFloat collected. */
export interface BlueGemSale {
  /** Where it sold: `csfloat`, `buff`, `skinport`, … as BetterFloat names it. */
  source: string;
  /** USD cents. */
  priceCents: number;
  /** ISO date of the sale. */
  soldAt: string;
  floatValue: number | null;
  statTrak: boolean;
  /** A screenshot of the sold item, https only. */
  screenshotUrl: string | null;
}

/**
 * `GET /api/market/blue-gem?name=&seed=`: BetterFloat's blue gem data for one Case Hardened / Heat Treated skin and
 * seed. `covered: false` for any other skin (gloves included): nothing was asked.
 */
export interface BlueGemResponse {
  covered: boolean;
  /** Null when BetterFloat has no colour data for that skin and seed. */
  playside: BlueGemColours | null;
  backside: BlueGemColours | null;
  sales: BlueGemSale[];
}
