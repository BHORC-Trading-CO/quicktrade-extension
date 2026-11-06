// apps/web/src/lib/platforms/cs-money.ts
import type { DnrRule } from '@qts/contracts';

import { floatBoundsAtDecimals } from '../floatBounds';
import { withPhaseName } from '../phases';
import type {
  ListingPriceInput,
  ListingRefInput,
  PlatformClient,
  PlatformRequest,
  PlatformUserData,
  ScreenshotRequest,
  StickerLookupHint,
} from './types';

function generateTraceparent(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `00-${hex(32)}-${hex(16)}-01`;
}

/** Extract the first JSON object following `"key":` in raw HTML. */
function extractJsonObject(html: string, key: string): Record<string, unknown> | null {
  const needle = `"${key}":`;
  const idx = html.indexOf(needle);
  if (idx === -1) return null;
  let i = idx + needle.length;
  while (i < html.length && /\s/.test(html[i] ?? '')) i++;
  if (html[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j] ?? '';
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** cs.money's `minFloat` / `maxFloat` at four digits, widened outwards so a finer band never comes back empty. */
function floatBoundsParams(floatMin: number, floatMax: number): Record<'minFloat' | 'maxFloat', number> {
  const bounds = floatBoundsAtDecimals(floatMin, floatMax, 4);
  return { minFloat: bounds.min, maxFloat: bounds.max };
}

export const csMoneyClient: PlatformClient = {
  getUserData: (): PlatformRequest => ({
    url: 'https://cs.money/market/buy/',
    method: 'GET',
  }),

  // cs.money caps user-inventory at 60 items/page. Paginate (offset) so items beyond the
  // first page also get pricing + `overpay` premiums; the fetch loop stops on a short page.
  inventoryPageSize: 60,
  getInventory: (_steamId: string, offset = 0): PlatformRequest => ({
    url: `https://cs.money/1.0/market/user-inventory?filter=all&limit=60&noCache=true&offset=${offset}`,
    method: 'GET',
  }),

  getTransactions: (_page: number): PlatformRequest => ({
    url: 'https://cs.money/1.0/market/history?limit=1000&noCache=true',
    method: 'GET',
  }),

  setPrice: (itemId: number | string, price: number): PlatformRequest => ({
    url: 'https://cs.money/1.0/market/sell-orders',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: Number(itemId), price }] }),
  }),

  // DELETE accepts sell-order ids; POST above deliberately keeps Steam asset ids.
  removeFromSale: (sellOrderId: number | string): PlatformRequest => ({
    url: 'https://cs.money/1.0/market/sell-orders',
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: [Number(sellOrderId)] }),
  }),

  setPrices: (items: ListingPriceInput[]): PlatformRequest => ({
    url: 'https://cs.money/1.0/market/sell-orders',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: items.map(({ id, price }) => ({ id: Number(id), price })) }),
  }),

  // ListingRefInput.id is the sell-order id, resolved from user-inventory before calling.
  removeListings: (items: ListingRefInput[]): PlatformRequest => ({
    url: 'https://cs.money/1.0/market/sell-orders',
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: items.map(({ id }) => Number(id)) }),
  }),

  getCompetitors: (
    name: string,
    stickers?: Array<StickerLookupHint | null>,
    souvenir?: boolean,
    _defIndex?: number,
    paintIndex?: number,
    isStatTrak?: boolean,
  ): PlatformRequest | null => {
    const hints = (stickers ?? []).filter(
      (s): s is StickerLookupHint & { position: number } => s !== null && !!s.name && s.position !== undefined,
    );
    if (!name && !hints.length) return null;
    // cs.money carries the Doppler phase in the name; narrow to it when known.
    const searchName = withPhaseName(name, paintIndex);
    const params: Record<string, string | number> = { limit: 60, offset: 0, order: 'asc', sort: 'price' };
    if (searchName) params['name'] = searchName;
    if (souvenir) params['souvenir'] = 1;
    if (isStatTrak) params['isStatTrak'] = 1;
    for (const s of hints) {
      params[`stickerName${s.position + 1}`] = decodeURI(s.name);
    }
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return { url: `https://cs.money/5.0/load_bots_inventory/730?${qs}`, method: 'GET' };
  },

  getMarketCompetitors: (
    name: string,
    stickers?: Array<StickerLookupHint | null>,
    souvenir?: boolean,
    isStatTrak?: boolean,
  ): PlatformRequest | null => {
    const hints = (stickers ?? []).filter(
      (s): s is StickerLookupHint & { position: number } => s !== null && !!s.name && s.position !== undefined,
    );
    if (!name && !hints.length) return null;
    const params: Record<string, string | number> = { limit: 60, offset: 0 };
    if (name) params['name'] = name;
    if (souvenir) params['souvenir'] = 1;
    if (isStatTrak) params['isStatTrak'] = 1;
    for (const s of hints) {
      params[`stickerName${s.position + 1}`] = decodeURI(s.name);
    }
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return { url: `https://cs.money/2.0/market/sell-orders?${qs}`, method: 'GET' };
  },

  // Float-range search: upper bound is hard, lower bound is soft.
  // The window around the item's float on both sides: asking from 0 filled the 60 with lower floats priced for
  // their float, not this one. Sorted by price ascending (the key of the sticker and pattern searches): the window
  // reaches down to the wear's lower bound, so a full page sorted by float held only the best (dearest) floats and
  // dropped the cheaper asks nearest this float; sorted by price a full page is the cheapest asks in the window.
  getCompetitorsByFloat: (
    name: string,
    floatMin: number,
    floatMax: number,
    isStatTrak?: boolean,
    _defIndex?: number,
    paintIndex?: number,
  ): PlatformRequest | null => {
    if (!name) return null;
    const params: Record<string, string | number> = {
      limit: 60,
      offset: 0,
      order: 'asc',
      sort: 'price',
      name: withPhaseName(name, paintIndex),
      // Four digits, a finer band widened outwards to them.
      ...floatBoundsParams(floatMin, floatMax),
    };
    if (isStatTrak) params['isStatTrak'] = 1;
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return { url: `https://cs.money/5.0/load_bots_inventory/730?${qs}`, method: 'GET' };
  },

  // Float-range search against the user sell-orders market (separate from the bot inventory above).
  // The bot inventory is sparse on low floats; the market carries the bulk of user listings and the
  // authoritative discounted price (`pricing.computed`). The same float window and price sort as bots.
  getMarketCompetitorsByFloat: (
    name: string,
    floatMin: number,
    floatMax: number,
    isStatTrak?: boolean,
    _defIndex?: number,
    paintIndex?: number,
  ): PlatformRequest | null => {
    if (!name) return null;
    const params: Record<string, string | number> = {
      limit: 60,
      offset: 0,
      order: 'asc',
      sort: 'price',
      name: withPhaseName(name, paintIndex),
      // Four digits, a finer band widened outwards to them.
      ...floatBoundsParams(floatMin, floatMax),
    };
    if (isStatTrak) params['isStatTrak'] = 1;
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return { url: `https://cs.money/2.0/market/sell-orders?${qs}`, method: 'GET' };
  },

  // Instant-sell offers: the user's own inventory priced for instant sell
  // (`sort=instantSell`, which orders by `buyOrder.maxPrice` desc). The web side picks
  // the copy matching the selected asset and surfaces a single offer per platform, using
  // the highest buy order (`buyOrder.maxPrice`) as the payout — not the flat `price`
  // field, which is the trade-bot deposit value.
  getInstantSell: (name: string, isStatTrak?: boolean, paintIndex?: number): PlatformRequest | null => {
    if (!name) return null;
    const params: Record<string, string | number> = {
      filter: 'all',
      limit: 60,
      noCache: 'true',
      offset: 0,
      order: 'desc',
      sort: 'instantSell',
      name: withPhaseName(name, paintIndex),
    };
    if (isStatTrak) params['isStatTrak'] = 1;
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return { url: `https://cs.money/1.0/market/user-inventory?${qs}`, method: 'GET' };
  },

  getScreenshot: (input: ScreenshotRequest): PlatformRequest => ({
    url: 'https://cs.money/screenshots',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-app': 'app',
      traceparent: generateTraceparent(),
    },
    body: JSON.stringify({
      item: {
        id: input.id,
        price: input.price,
        stickers: input.stickers,
      },
      isBot: false,
      botInventory: false,
      source: 'tradeuser',
      isInGame: false,
    }),
  }),

  getSkinInfo: (itemId: string | number): PlatformRequest => ({
    url: `https://cs.money/skin_info?appId=730&id=${itemId}&isBot=false&botInventory=false`,
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'content-language': 'en',
      referer: 'https://cs.money/csgo/trade/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="130", "Google Chrome";v="130"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'x-client-app': 'web',
      traceparent: generateTraceparent(),
    },
  }),

  getDnrRules: (): DnrRule[] => [
    {
      id: 2001,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://cs.money/csgo/trade/' },
          { header: 'Origin', operation: 'remove' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
          { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
          { header: 'Sec-Fetch-Dest', operation: 'set', value: 'empty' },
          { header: 'Sec-CH-UA', operation: 'set', value: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"' },
          { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?0' },
          { header: 'Sec-CH-UA-Platform', operation: 'set', value: '"Windows"' },
          { header: 'Accept-Language', operation: 'set', value: 'en-US,en;q=0.9,uk;q=0.8,ru;q=0.7' },
          { header: 'Content-Language', operation: 'set', value: 'en' },
          { header: 'X-Client-App', operation: 'set', value: 'web' },
        ],
      },
      condition: {
        urlFilter: '|https://cs.money/',
        resourceTypes: ['xmlhttprequest', 'other'],
        excludedInitiatorDomains: ['cs.money'],
      },
    },
  ],

  getCompetitorsByPattern: (name: string, paintSeed: number, _defIndex?: number, paintIndex?: number): PlatformRequest | null => {
    if (!name) return null;
    const params: Record<string, string | number> = {
      limit: 60,
      offset: 0,
      order: 'asc',
      sort: 'price',
      name: withPhaseName(name, paintIndex),
      paintSeed,
    };
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return { url: `https://cs.money/5.0/load_bots_inventory/730?${qs}`, method: 'GET' };
  },

  parseUserData: (raw: unknown): PlatformUserData => {
    if (typeof raw !== 'string') return { isAuthorized: false };
    const userInfo = extractJsonObject(raw, 'userInfo');
    const marketBalance = extractJsonObject(raw, 'marketBalance');
    if (!userInfo) return { isAuthorized: false };
    const steamId =
      (typeof userInfo['steamId64'] === 'string' && userInfo['steamId64']) ||
      (typeof userInfo['steamId'] === 'string' && userInfo['steamId']) ||
      (typeof userInfo['steam_id'] === 'string' && userInfo['steam_id']) ||
      (typeof userInfo['id'] === 'string' && userInfo['id']) ||
      undefined;
    if (!steamId) {
      return { isAuthorized: false };
    }
    return {
      isAuthorized: true,
      steamId,
      username: typeof userInfo['username'] === 'string' ? userInfo['username'] : undefined,
      avatar: typeof userInfo['avatar'] === 'string' ? userInfo['avatar'] : undefined,
      balance: marketBalance && typeof marketBalance['balance'] === 'number' ? (marketBalance['balance'] as number) / 100 : undefined,
    };
  },
};

/** One item sold into cs.money's buy order: what `buy-sell-orders` takes per item. */
export interface CsMoneyInstantSellItem {
  /** The Steam asset id (never the row's `id`, which is the sell-order id of a listed item). */
  assetId: string;
  /** `buyOrder.id` of the item's `user-inventory` row. */
  buyOrderId: number;
  /** `buyOrder.maxPrice`, USD. */
  price: number;
}

/**
 * One asset's fresh `user-inventory` row, with its current buy order (vault `csmoney-instant-sell-deal`, measured
 * 2026-10-24: `assetIds=` answers exactly that row, the query cs.money's own sell page refreshes items with).
 */
export function csMoneyInventoryAssetRequest(assetId: string): PlatformRequest {
  const qs = new URLSearchParams({ assetIds: assetId, limit: '1', offset: '0' });
  return { url: `https://cs.money/api/public/v2/market/user-inventory?${qs.toString()}`, method: 'GET' };
}

/**
 * Sells items into cs.money's top buy orders (vault `csmoney-instant-sell-deal`, `## Контракт`, verified 2026-10-24):
 * `{ items: [{ id: <asset id>, buyOrder, price }], requestId }`. `requestId` is cs.money's idempotency key: the same
 * attempt is resent with the same one. Answered with `{ instantSellId }`, the deal `csMoneyInstantSellDealRequest` reads.
 */
export function csMoneyInstantSellCreateRequest(items: readonly CsMoneyInstantSellItem[], requestId: string): PlatformRequest {
  return {
    url: 'https://cs.money/1.0/market/buy-sell-orders',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: items.map(({ assetId, buyOrderId, price }) => ({ id: Number(assetId), buyOrder: buyOrderId, price })),
      requestId,
    }),
  };
}

/** The state of one instant-sell deal (`trade_created` with the Steam offer, `trade_protected`/`success`, `failed`). */
export function csMoneyInstantSellDealRequest(instantSellId: string): PlatformRequest {
  return { url: `https://cs.money/api/public/v1/instantsell/deals/${encodeURIComponent(instantSellId)}`, method: 'GET' };
}

/** cs.money caps `user-inventory` at 60 items per page — same page size the inventory sync uses. */
export const CS_MONEY_INSTANT_SELL_PAGE_SIZE = 60;

/** Safety stop for the whole-inventory instant-sell paging loop (60 × 30 = 1800 items). */
export const CS_MONEY_MAX_INSTANT_SELL_PAGES = 30;

/** Pause between two pages of that loop: it now also runs on every inventory load, so it keeps cs.money's ~500 ms pace. */
export const CS_MONEY_INSTANT_SELL_PAGE_GAP_MS = 500;

/**
 * Pauses before the 2nd and 3rd try of a page of that loop that failed (a 429, a 5xx, a lost reply, or an HTTP 200
 * `{ error: N }` body): three tries in all. A `Retry-After` / `x-ratelimit-reset` longer than the pause is waited out
 * instead, up to {@link CS_MONEY_INSTANT_SELL_MAX_RETRY_WAIT_MS}.
 */
export const CS_MONEY_INSTANT_SELL_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** The longest a failed page of that loop waits for cs.money's own retry time; a longer one ends the walk incomplete. */
export const CS_MONEY_INSTANT_SELL_MAX_RETRY_WAIT_MS = 30_000;

/**
 * The `getInstantSell` endpoint WITHOUT the per-skin `name` filter: one page of the user's whole
 * inventory priced for instant sell (`sort=instantSell`, ordered by `buyOrder.maxPrice` desc).
 * The per-item lookup filters by name because it prices a single selected skin; the instant-sell
 * page prices the entire inventory at once, so it pages through the unfiltered list instead
 * (see `cs-money` in instant-sell-fetchers.ts). Same response shape — the payout is still read
 * from each raw item's `buyOrder.maxPrice`.
 */
export function csMoneyInstantSellInventoryRequest(offset: number): PlatformRequest {
  const qs = new URLSearchParams({
    filter: 'all',
    limit: String(CS_MONEY_INSTANT_SELL_PAGE_SIZE),
    noCache: 'true',
    offset: String(offset),
    order: 'desc',
    sort: 'instantSell',
  });
  return { url: `https://cs.money/1.0/market/user-inventory?${qs}`, method: 'GET' };
}
