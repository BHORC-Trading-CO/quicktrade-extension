// apps/web/src/lib/platforms/csfloat.ts
import type { DnrRule } from '@qts/contracts';

import { floatBoundsAtDecimals } from '../floatBounds';
import type { PlatformClient, PlatformRequest, PlatformUserData, StickerLookupHint } from './types';

interface CsfloatUser {
  steam_id?: string;
  email?: string;
  balance?: number;

  know_your_customer?: string | null;
  stripe_connect?: { payouts_enabled?: boolean | null } | null;
}

interface CsfloatMeResponse {
  user?: CsfloatUser;
}

function isCsfloatMeResponse(value: unknown): value is CsfloatMeResponse {
  return typeof value === 'object' && value !== null;
}

// ─── GET /api/v1/me/inventory response ─────────────────────────────────────────
// CSFloat returns a bare array of inventory items. Skins carry the paint/float
// fields; agents and charms omit them. All monetary values are integer USD cents.
// Derived from a 946-item live response (temp/responce1.json) — `presence/total`
// counts in the comments mark which fields can be absent.

/** Best (highest) standing buy order for an item — the instant-sell payout. */
export interface CsfloatBuyOrder {
  /** Highest bid across all standing buy orders, in cents. */
  max_price: number;
  /** Quantity demanded at/above `max_price`. */
  quantity: number;
}

/** Aggregate market reference for an item. Prices in cents. */
export interface CsfloatReference {
  base_price: number;
  predicted_price: number;
  quantity: number;
  last_updated: string;
  /** Float-driven price multiplier (basis points). Absent on non-skin items. (940/946) */
  float_factor?: number;
  /** Reference price of the attached charm. Present only when one is attached. (6/946) */
  keychain_price?: number;
  /** Highest active buy order. Absent when the item has no buy orders. (857/946) */
  buy_order?: CsfloatBuyOrder;
}

/** Per-sticker / per-charm market reference. Prices in cents. */
export interface CsfloatStickerReference {
  price: number;
  quantity: number;
  updated_at: string;
}

export interface CsfloatSticker {
  stickerId: number;
  slot: number;
  icon_url: string;
  name: string;
  /** Applied-position metadata — present only on items with positioned (scraped) stickers. */
  offset_x?: number;
  offset_y?: number;
  rotation?: number;
  /** Sticker wear, 0–1 (0 = pristine). Present only when scraped. */
  wear?: number;
  reference?: CsfloatStickerReference;
}

export interface CsfloatKeychain {
  stickerId: number;
  slot: number;
  icon_url: string;
  name: string;
  pattern: number;
  offset_x?: number;
  offset_y?: number;
  offset_z?: number;
  reference?: CsfloatStickerReference;
}

/** Case-hardened blue-gem percentages. Present only on eligible skins. */
export interface CsfloatBlueGem {
  backside_blue: number;
  playside_blue: number;
}

/** Fade percentage info. Present only on fade skins. */
export interface CsfloatFade {
  seed: number;
  percentage: number;
  rank: number;
  type: string;
}

/** One item from `GET /api/v1/me/inventory`. */
export interface CsfloatInventoryItem {
  asset_id: string;
  def_index: number;
  icon_url: string;
  market_hash_name: string;
  item_name: string;
  type: 'skin' | 'agent' | 'charm';
  type_name: string;
  rarity: number;
  rarity_name: string;
  is_commodity: boolean;
  /** Steam tradability flag (1 = tradable). */
  tradable: number;
  reference: CsfloatReference;
  /**
   * Steam inspect link (`steam://rungame/730/...`). Passed as the `url` query param
   * to `GET /api/v1/buy-orders/item` to fetch buy orders for an unlisted item.
   */
  serialized_inspect: string;
  /**
   * Per-item signature. Passed as the `sig` query param to `GET /api/v1/buy-orders/item`.
   * Only available from this endpoint (own inventory) — this is why buy orders for an
   * unlisted item can be fetched only for the user's own items.
   */
  gs_sig: string;
  // ─ Skin-only fields (absent on agents/charms) ─
  paint_index?: number; // 940/946
  paint_seed?: number; // 940/946
  float_value?: number; // 940/946
  wear_name?: string; // 940/946
  quality?: number; // 940/946
  collection?: string; // 940/946
  description?: string; // 940/946
  is_stattrak?: boolean; // 940/946
  is_souvenir?: boolean; // 940/946
  stickers?: CsfloatSticker[]; // 932/946
  keychains?: CsfloatKeychain[]; // 6/946
  keychain_index?: number; // 1/946
  keychain_pattern?: number; // 1/946
  /** Rare-trait badges, e.g. `"rare_sticker"`. (7/946) */
  badges?: string[];
  blue_gem?: CsfloatBlueGem; // 1/946
  fade?: CsfloatFade; // 2/946
  /** Global lowest-float rank (1 = lowest float in the world). (22/946) */
  low_rank?: number;
  /** Global highest-float rank (1 = highest float in the world). (25/946) */
  high_rank?: number;
}

/** `GET /api/v1/me/inventory` returns a bare array of inventory items. */
export type CsfloatInventoryResponse = CsfloatInventoryItem[];

/** Page size known to work with cookie auth; whether larger limits are honoured there is unverified. */
export const CSFLOAT_STALL_PAGE_SIZE = 40;


export function csfloatStallPageRequest(steamId: string, cursor?: string): PlatformRequest {
  const params = new URLSearchParams({ limit: String(CSFLOAT_STALL_PAGE_SIZE) });
  if (cursor) params.set('cursor', cursor);
  return { url: `https://csfloat.com/api/v1/users/${encodeURIComponent(steamId)}/stall?${params}`, method: 'GET' };
}

/** One listing, also once it is no longer live (`state`: listed · sold · delisted · refunded, vault `csfloat-api`). */
export function csfloatListingRequest(listingId: string): PlatformRequest {
  return { url: `https://csfloat.com/api/v1/listings/${encodeURIComponent(listingId)}`, method: 'GET' };
}

export const csfloatClient: PlatformClient = {
  getUserData: (): PlatformRequest => ({
    url: 'https://csfloat.com/api/v1/me',
    method: 'GET',
  }),

  getInventory: (_steamId: string): PlatformRequest => ({
    url: 'https://csfloat.com/api/v1/me/inventory',
    method: 'GET',
  }),

  getStall: csfloatStallPageRequest,

  getTransactions: (page: number): PlatformRequest => ({
    url: `https://csfloat.com/api/v1/me/transactions?page=${page}&limit=100&order=desc`,
    method: 'GET',
  }),

  // Instant-sell offer = the highest standing buy order, which pays out immediately
  // (a buy-order holder auto-buys the item). CSFloat exposes this per item as
  // `reference.buy_order.max_price` inside the /me/inventory response, so instant-sell
  // reuses that endpoint rather than the per-item `/buy-orders/item` request (which would
  // need the item's `gs_sig`). The endpoint is not name-filterable — it returns the whole
  // inventory — so the web side matches the selected asset and reads its buy order
  // (see resolveCsFloatInstantSell). Params are ignored; resolution is asset-id based.
  getInstantSell: (): PlatformRequest => ({
    url: 'https://csfloat.com/api/v1/me/inventory',
    method: 'GET',
  }),

  // Instant-sell price fallbacks via the buy-order book (rate limit separate from
  // /me/inventory). Both return a price-desc array of { market_hash_name, qty, price (cents) };
  // the highest order is the instant-sell payout (see maxCsfloatBuyOrder).
  getBuyOrdersByListing: (listingId: string | number): PlatformRequest => ({
    url: `https://csfloat.com/api/v1/listings/${encodeURIComponent(String(listingId))}/buy-orders?limit=10`,
    method: 'GET',
  }),

  // Unlisted items: keyed by the Steam inspect link + the per-item signature, both of which
  // come from /me/inventory — so this only works for the user's own items.
  getBuyOrdersByItem: (name: string, inspectLink: string, sig: string): PlatformRequest => {
    const params = new URLSearchParams({ url: inspectLink, market_hash_name: name, sig, limit: '10' });
    return { url: `https://csfloat.com/api/v1/buy-orders/item?${params.toString()}`, method: 'GET' };
  },

  setPrice: (itemId: number | string, price: number): PlatformRequest => ({
    url: 'https://csfloat.com/api/v1/listings',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_id: String(itemId),
      type: 'buy_now',
      price: Math.round(price * 100),
    }),
  }),

  editPrice: (listingId: string | number, price: number): PlatformRequest => ({
    url: `https://csfloat.com/api/v1/listings/${encodeURIComponent(String(listingId))}`,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: Math.round(price * 100) }),
  }),

  removeFromSale: (itemId: number | string): PlatformRequest => ({
    url: `https://csfloat.com/api/v1/listings/${encodeURIComponent(String(itemId))}`,
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  }),

  // CSFloat rejects mutating requests (create/edit/remove listing) whose Origin isn't csfloat.com
  // with `{ code: 79, "invalid origin" }`. Requests proxied from the extension's background worker
  // carry the extension origin, so rewrite Origin/Referer to csfloat.com via declarativeNetRequest.
  getDnrRules: (): DnrRule[] => [
    {
      id: 2002,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://csfloat.com' },
          { header: 'Referer', operation: 'set', value: 'https://csfloat.com/' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
          { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
        ],
      },
      condition: {
        urlFilter: '|https://csfloat.com/',
        resourceTypes: ['xmlhttprequest', 'other'],
        excludedInitiatorDomains: ['csfloat.com'],
      },
    },
  ],

  getCompetitors: (
    name: string,
    stickers?: Array<StickerLookupHint | null>,
    souvenir?: boolean,
    defIndex?: number,
    paintIndex?: number,
    isStatTrak?: boolean,
  ): PlatformRequest | null => {
    const hints = (stickers ?? []).filter((s): s is StickerLookupHint => s !== null);
    // category: 1=Normal, 2=StatTrak™, 3=Souvenir
    // isStatTrak explicit param takes priority; fall back to name prefix when undefined.
    const category = souvenir ? '3' : (isStatTrak ?? name.startsWith('StatTrak')) ? '2' : '1';
    const stickerIds = hints.filter((s) => s.stickerDefIndex !== undefined).map((s) => ({ i: s.stickerDefIndex }));

    // Sticker-only ('any' scope — no item name): search by sticker across ALL skins. The sticker is
    // the value driver, so def_index/paint_index must NOT be applied here — they would narrow the
    // results to the source's exact skin (e.g. only Five-SeveN | Case Hardened carrying the sticker),
    // which is why this previously returned a single listing. Similarity ranking surfaces the same
    // skin at the top; cross-skin sticker matches rank below. CSFloat AND-matches multiple ids.
    if (!name && hints.length > 0) {
      if (stickerIds.length > 0) {
        const params = new URLSearchParams({ limit: '50', category, type: 'buy_now', stickers: JSON.stringify(stickerIds) });
        return { url: `https://csfloat.com/api/v1/listings?${params.toString()}`, method: 'GET' };
      }
      // CSFloat silently ignores `sticker_names[]`, but keep it as a best-effort when ids are absent.
      const nameHints = hints.filter((s) => s.name);
      if (!nameHints.length) return null;
      const params = new URLSearchParams({ limit: '50', category, type: 'buy_now' });
      for (const s of nameHints) params.append('sticker_names[]', s.name);
      return { url: `https://csfloat.com/api/v1/listings?${params.toString()}`, method: 'GET' };
    }

    // Structured search by def_index. With paint_index → the exact skin ('exact' scope, also narrows
    // phased finishes like Doppler to the phase); def_index alone → the whole weapon, any skin
    // ('weapon'/approximate scope). Stickers, if any, are AND-ed on.
    if (defIndex !== undefined) {
      const params = new URLSearchParams({ limit: '50', def_index: String(defIndex), category, type: 'buy_now' });
      if (paintIndex !== undefined) {
        params.set('paint_index', String(paintIndex));
      }
      if (stickerIds.length > 0) {
        params.set('stickers', JSON.stringify(stickerIds));
      }
      return { url: `https://csfloat.com/api/v1/listings?${params.toString()}`, method: 'GET' };
    }

    // Fallback: name-based search (used when the item has no CSFloat defIndex/paintIndex).
    if (!name) return null;
    const params = new URLSearchParams({ limit: '50', market_hash_name: name, category, type: 'buy_now' });
    for (const s of hints) {
      if (s.name) params.append('sticker_names[]', s.name);
    }
    return { url: `https://csfloat.com/api/v1/listings?${params.toString()}`, method: 'GET' };
  },

  // Float-range search: the window around the item's float on both sides, cheapest first (`sort_by=lowest_price`,
  // csfloat-api contract). Asking from 0 brought in lower floats and, within CSFloat's 50, the costly sticker
  // crafts, which hid what the float alone is worth.
  // When def_index + paint_index are available, search structurally — this narrows phased
  // finishes (Doppler/Gamma Doppler) to the exact phase, which the name alone cannot do.
  getCompetitorsByFloat: (
    name: string,
    floatMin: number,
    floatMax: number,
    isStatTrak?: boolean,
    defIndex?: number,
    paintIndex?: number,
  ): PlatformRequest | null => {
    const category = (isStatTrak ?? name.startsWith('StatTrak')) ? '2' : '1';
    // CSFloat takes four digits; a finer band (the Sale history precision grid) is widened outwards to them.
    const bounds = floatBoundsAtDecimals(floatMin, floatMax, 4);
    const params = new URLSearchParams({
      limit: '50',
      min_float: bounds.min.toFixed(4),
      max_float: bounds.max.toFixed(4),
      sort_by: 'lowest_price',
      category,
      type: 'buy_now',
    });
    if (defIndex !== undefined && paintIndex !== undefined) {
      params.set('def_index', String(defIndex));
      params.set('paint_index', String(paintIndex));
    } else if (name) {
      params.set('market_hash_name', name);
    } else {
      return null;
    }
    return { url: `https://csfloat.com/api/v1/listings?${params.toString()}`, method: 'GET' };
  },

  getCompetitorsByPattern: (name: string, paintSeed: number, defIndex?: number, paintIndex?: number): PlatformRequest | null => {
    const params = new URLSearchParams({ limit: '50', paint_seed: String(paintSeed) });
    if (defIndex !== undefined && paintIndex !== undefined) {
      params.set('def_index', String(defIndex));
      params.set('paint_index', String(paintIndex));
    } else if (name) {
      params.set('market_hash_name', name);
    } else {
      return null;
    }
    return { url: `https://csfloat.com/api/v1/listings?${params.toString()}`, method: 'GET' };
  },

  parseUserData: (raw: unknown): PlatformUserData => {
    if (!isCsfloatMeResponse(raw)) return { isAuthorized: false };
    const user = raw.user;
    if (!user?.steam_id) return { isAuthorized: false };
    return {
      isAuthorized: true,
      steamId: user.steam_id,
      email: user.email,
      balance: typeof user.balance === 'number' ? user.balance / 100 : undefined,
      // Source: quick-buy-skin apps/server/src/csfloat/account-reads.ts + vault csfloat-balance-cap (local 2026-08-22).
      balanceCapped: !(user.know_your_customer === 'approved' && user.stripe_connect?.payouts_enabled === true),
    };
  },
};
