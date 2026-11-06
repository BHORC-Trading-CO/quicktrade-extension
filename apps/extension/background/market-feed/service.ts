// apps/extension/background/market-feed/service.ts
//
// QUICK-231: the one Market live feed of this browser, on the real browser APIs (the engine is `feed-poller.ts`).
import type { MarketFeedRow, MarketFeedUpdate } from '@qts/contracts';

import { resolveOperation } from '../operation-policy';
import { proxyRequest } from '../proxy';
import { createMarketFeed, type MarketFeed } from './feed-poller';

/** Restarts the loop when the browser stopped the worker while a tab still holds a lease (30 s: the alarms minimum). */
export const MARKET_FEED_WATCHDOG_ALARM = 'qts:market-feed-watchdog';
/** The background → content-script push of a feed update; the content script relays it as `market_feed_update`. */
export const MARKET_FEED_PUSH_TYPE = 'bg:market_feed_update';
const STORAGE_KEY = 'qts:market-feed';

let instance: MarketFeed | null = null;
const listingListeners = new Set<(rows: MarketFeedRow[], at: number) => void>();

/** QUICK-233: every poll's new listings, for the buy-order engine. Returns the unsubscribe. */
export function onMarketFeedListings(listener: (rows: MarketFeedRow[], at: number) => void): () => void {
  listingListeners.add(listener);
  return () => listingListeners.delete(listener);
}

async function ensureWatchdog(): Promise<void> {
  const existing = await browser.alarms.get(MARKET_FEED_WATCHDOG_ALARM);
  if (!existing) await browser.alarms.create(MARKET_FEED_WATCHDOG_ALARM, { periodInMinutes: 0.5 });
}

export function marketFeed(): MarketFeed {
  instance ??= createMarketFeed({
    proxy: proxyRequest,
    resolve: resolveOperation,
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    // storage.session survives a worker restart, not a browser restart (nor does a tab's lease).
    load: async () => (browser.storage?.session ? (await browser.storage.session.get(STORAGE_KEY))[STORAGE_KEY] : undefined),
    save: async (snapshot) => {
      if (browser.storage?.session) await browser.storage.session.set({ [STORAGE_KEY]: snapshot });
    },
    push: async (tabId: number, update: MarketFeedUpdate) => {
      try {
        await browser.tabs.sendMessage(tabId, { type: MARKET_FEED_PUSH_TYPE, data: update });
        return true;
      } catch {
        return false;
      }
    },
    watchdog: async (on) => {
      if (on) await ensureWatchdog();
      else await browser.alarms.clear(MARKET_FEED_WATCHDOG_ALARM);
    },
    keepAlive: ensureWatchdog,
    onListings: (rows, at) => {
      for (const listener of listingListeners) listener(rows, at);
    },
  });
  return instance;
}
