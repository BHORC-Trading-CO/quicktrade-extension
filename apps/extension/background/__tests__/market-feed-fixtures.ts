

export const CSFLOAT_FEED_URL = 'https://csfloat.com/api/v1/listings?limit=50&type=buy_now&sort_by=most_recent';
export const CSMONEY_MARKET_FEED_URL = 'https://cs.money/2.0/market/sell-orders?limit=60&offset=0&sort=insertDate&order=desc';
export const CSMONEY_BOTS_FEED_URL = 'https://cs.money/6.0/load_bots_inventory/730?limit=60&sort=insertDate&order=desc';

export function csfloatRow(id: string, createdAt: number, patch: { price?: number; item?: Record<string, unknown> } = {}) {
  return {
    id,
    created_at: new Date(createdAt).toISOString(),
    type: 'buy_now',
    state: 'listed',
    price: patch.price ?? 118_500,
    item: {
      asset_id: `9${id}`,
      def_index: 7,
      paint_index: 44,
      paint_seed: 661,
      float_value: 0.218734,
      icon_url: 'icon',
      market_hash_name: 'AK-47 | Case Hardened (Field-Tested)',
      is_stattrak: false,
      is_souvenir: false,
      stickers: [{ stickerId: 1, slot: 0, wear: 0.1, name: 'Sticker | iBUYPOWER | Katowice 2014', reference: { price: 250_000 } }],
      ...patch.item,
    },
  };
}

export function csMoneyMarketRow(id: number, priceUsd: number) {
  return {
    id,
    pricing: { computed: priceUsd, default: priceUsd },
    asset: {
      id: 5000 + id,
      names: { full: 'AWP | Asiimov (Field-Tested)' },
      float: 0.25,
      paintseed: 12,
      images: { steam: 'https://x/i.png' },
      stickers: [null, { name: 'Sticker | Natus Vincere | Katowice 2015', pricing: { default: 1.5 }, wear: 20 }],
    },
  };
}

export function csMoneyBotRow(id: number, priceUsd: number) {
  return { id, assetId: 7000 + id, fullName: 'StatTrak™ AK-47 | Redline (Field-Tested)', float: '0.15', pattern: 18, price: priceUsd, steamImg: 'https://x/r.png' };
}

export function csfloatHeaders(remaining: number, resetAt: number, now: number, limit = 200): Record<string, string> {
  return {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.floor(resetAt / 1000)),
    date: new Date(now).toUTCString(),
  };
}
