// apps/web/src/lib/platforms/types.ts
import type { DnrRule, Platform } from '@qts/contracts';

/**
 * Re-export the canonical platform-id union from the bridge contract.
 * Kept as `PlatformId` here for clarity in lib/platforms call-sites.
 */
export type PlatformId = Platform;

/**
 * Normalised user shape returned by every PlatformClient.parseUserData().
 * `isAuthorized` is required so callers can branch without optional-chaining.
 */
export type PlatformUserData = {
  isAuthorized: boolean;
  steamId?: string;
  balance?: number;
  /**
   * CSFloat only: the account sells under the $2,000 balance cap (not both KYC `approved` and Stripe payouts on).
   * Undefined when unknown. See lib/sell/csfloat-cap.ts.
   */
  balanceCapped?: boolean;
  username?: string;
  avatar?: string;
  email?: string;
  /** Steam only: the profile's canonical URL, `/id/<vanity>/` when it has a custom one. */
  profileUrl?: string;
};

/** A fully-specified HTTP request that the extension proxy can execute. */
export interface PlatformRequest {
  url: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
  /**
   * Cookie behaviour for the proxied fetch. Defaults to `'include'`; set `'omit'` for header-only
   * APIs that reject the session cookie (DMarket's api.dmarket.com 504s when `dm-trade-token` rides
   * along, so all DMarket requests omit cookies and authenticate via the `Authorization` header).
   */
  credentials?: 'omit' | 'include';
}

/** Raw response from the extension proxy. */
export interface ProxyResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  /** Raw response headers forwarded by the extension (lower-cased keys), e.g. `x-ratelimit-reset`. */
  headers?: Record<string, string>;
  error?: string;
  /**
   * Set by the competitor chokepoint on a rate-limited answer (a 429, or a request it skipped during a known limit):
   * epoch ms from when the marketplace may be asked again (QUICK-301).
   */
  retryAt?: number;
}

/** Sticker descriptor used by competitor lookups. */
export interface StickerLookupHint {
  name: string;
  /** Unknown for Steam HTML that names stickers without their in-game positions. */
  position?: number;
  /** Numeric CSFloat sticker definition ID. When present, enables `stickers=[{"i":id}]` search on CSFloat. */
  stickerDefIndex?: number;
}

/** Sticker descriptor used by screenshot generation requests. */
export interface ScreenshotStickerHint {
  overprice: number;
  name: string;
  position: number | undefined;
  price: number;
  wear: number;
  img: string;
}

/** Input for screenshot generation requests. */
export interface ScreenshotRequest {
  id: number;
  price: number;
  stickers: ScreenshotStickerHint[];
}

/** A listing identified by item/asset id, with its target price. Used by batch list/reprice. */
export interface ListingPriceInput {
  id: number | string;
  price: number;
}

/** A listing identified by item/asset id only. Used by batch remove. */
export interface ListingRefInput {
  id: number | string;
}

/**
 * Every supported platform exposes this interface.
 * Methods return PlatformRequest objects — they do NOT execute fetch themselves.
 * The proxy in the extension executes them via `credentials: 'include'`.
 *
 * parseUserData() converts the raw HTTP response body into a normalised
 * PlatformUserData shape. It receives whatever data the proxy returns
 * (JSON object for most APIs, raw HTML string for CS.Money).
 */
export interface PlatformClient {
  /** Request to fetch the logged-in user's profile. */
  getUserData: () => PlatformRequest;
  /**
   * Request to load the user's inventory (items not on sale). `offset` paginates
   * platforms that cap the page size (cs.money serves 60/page); omit for a single page.
   */
  getInventory: (steamId: string, offset?: number) => PlatformRequest;
  /** Page size returned by `getInventory`, when the platform paginates. Drives the fetch loop. */
  inventoryPageSize?: number;
  /** Request to load the user's active listings (items on sale). Optional — not all platforms expose a stall. */
  getStall?: (steamId: string) => PlatformRequest;
  /** Request for one page of transaction history. */
  getTransactions: (page: number) => PlatformRequest;
  /** Request to list an item at a given price. */
  setPrice: (itemId: number | string, price: number) => PlatformRequest;
  /**
   * Edit the price of an ALREADY-listed item by listing id. Defined only for platforms
   * where creating a listing and editing its price are different requests (CSFloat:
   * POST /listings to create, PATCH /listings/:id to edit). Platforms whose create and
   * edit share one endpoint (cs.money) omit this — callers fall back to setPrice/setPrices.
   */
  editPrice?: (listingId: string | number, price: number) => PlatformRequest;
  /** Batch list/reprice in one request. Defined only for platforms whose API accepts many items per call (cs.money). */
  setPrices?: (items: ListingPriceInput[]) => PlatformRequest;
  /** Batch remove in one request. Defined only for platforms whose API accepts many items per call (cs.money). */
  removeListings?: (items: ListingRefInput[]) => PlatformRequest;
  /** Request to remove an item from sale. */
  removeFromSale: (itemId: number | string) => PlatformRequest;
  /**
   * Request to fetch competitor listings. Returns null if no usable signal.
   * `sourceName` is the FULL market-hash name of the selected source item (with wear). The sticker
   * cascade's broad query passes an empty `name` (cross-skin); platforms that can only search WITHIN a
   * skin (buff.market — needs a goods_id from the name) use `sourceName` to fetch the same-skin pool and
   * let the scorer filter by sticker overlap. Cross-skin platforms ignore it.
   */
  getCompetitors: (
    name: string,
    stickers?: Array<StickerLookupHint | null>,
    souvenir?: boolean,
    defIndex?: number,
    paintIndex?: number,
    isStatTrak?: boolean,
    sourceName?: string,
  ) => PlatformRequest | null;
  /** Optional secondary market endpoint (e.g. CS.Money user sell-orders vs bot inventory). */
  getMarketCompetitors?: (
    name: string,
    stickers?: Array<StickerLookupHint | null>,
    souvenir?: boolean,
    isStatTrak?: boolean,
  ) => PlatformRequest | null;
  /**
   * Request to fetch competitor listings within a float range. Returns null if unsupported.
   * `defIndex`/`paintIndex` narrow phased finishes (Doppler/Gamma Doppler): CSFloat searches
   * by def_index + paint_index; cs.money augments the name with the phase label.
   */
  getCompetitorsByFloat?: (
    name: string,
    floatMin: number,
    floatMax: number,
    isStatTrak?: boolean,
    defIndex?: number,
    paintIndex?: number,
    /** Opaque platform-internal search id from a two-step resolve (skinbaron variantId). See `resolveSearchId`. */
    searchId?: string,
  ) => PlatformRequest | null;
  /**
   * Optional secondary market endpoint for float-range search (e.g. CS.Money user sell-orders
   * vs bot inventory). Returns null if the platform has no separate market source.
   */
  getMarketCompetitorsByFloat?: (
    name: string,
    floatMin: number,
    floatMax: number,
    isStatTrak?: boolean,
    defIndex?: number,
    paintIndex?: number,
  ) => PlatformRequest | null;
  /**
   * Request to fetch competitor listings by paint seed. Returns null if unsupported.
   * `searchId` is the opaque platform-internal id from a two-step resolve (haloskins itemId), threaded in
   * by competitorSearch after the resolve step — same mechanism as `getCompetitorsByFloat`. Single-request
   * platforms (cs.money/csfloat) ignore it.
   */
  getCompetitorsByPattern?: (
    name: string,
    paintSeed: number,
    defIndex?: number,
    paintIndex?: number,
    searchId?: string,
  ) => PlatformRequest | null;
  /**
   * Two-step competitor resolution. Some marketplaces (skinbaron) filter offers by an opaque internal
   * id, not the market-hash name — their free-text search is too fuzzy to isolate a skin. When defined,
   * competitorSearch runs `resolveSearchId` first, parses the id with `parseSearchId`, and threads it
   * into `getCompetitorsByFloat` as the trailing `searchId`. Single-request platforms omit both.
   */
  resolveSearchId?: (name: string) => PlatformRequest | null;
  /** Extract the platform-internal search id from a `resolveSearchId` response, or null when unresolved. */
  parseSearchId?: (data: unknown, name: string) => string | null;
  /**
   * Synchronous, request-free resolution of the market-hash name → an internal search id, backed by a
   * vendored offline map (buff.market's goods_id map). When this returns a non-null id, competitorSearch
   * uses it directly and SKIPS the network `resolveSearchId` round-trip. Returns null on a miss (or before
   * the map has loaded), so the caller falls back to the network resolve. Optional — most platforms omit it.
   */
  resolveSearchIdLocal?: (name: string) => string | null;
  /**
   * Request to fetch the user's own items matching `name`, priced for instant sell
   * (sell-to-platform / buy-order payout). Returns null if the platform has no
   * instant-sell endpoint. The response carries the per-copy instant-sell payout,
   * resolved to a single offer per platform on the web side.
   */
  getInstantSell?: (name: string, isStatTrak?: boolean, paintIndex?: number) => PlatformRequest | null;
  /**
   * Fetch buy orders for an item ALREADY listed on the platform, by listing id. Used as an
   * instant-sell price fallback with a rate limit separate from the inventory endpoint.
   * CSFloat-specific. The response is a price-desc array of `{ price (cents) }`.
   */
  getBuyOrdersByListing?: (listingId: string | number) => PlatformRequest;
  /**
   * Fetch buy orders for an UNLISTED owned item, by Steam inspect link + the per-item
   * signature (both from the inventory endpoint). Instant-sell price fallback for items not
   * on sale. CSFloat-specific. Same response shape as `getBuyOrdersByListing`.
   */
  getBuyOrdersByItem?: (name: string, inspectLink: string, sig: string) => PlatformRequest;
  /** POST request to trigger screenshot generation for a user item. CS.Money-specific. */
  getScreenshot?: (input: ScreenshotRequest) => PlatformRequest;
  /** DNR rules the extension should install when this platform's host permission is granted. */
  getDnrRules?: () => DnrRule[];
  /** GET request to fetch skin info (preview URL, inspect link, screenshot URL). CS.Money-specific. */
  getSkinInfo?: (itemId: string | number) => PlatformRequest;
  /** Normalise the raw proxy response into PlatformUserData. */
  parseUserData: (raw: unknown) => PlatformUserData;
}
