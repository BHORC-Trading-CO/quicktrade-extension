// apps/extension/background/buy-orders/service.ts
//
// QUICK-233: the buy-order engine of this browser on the real browser APIs (the engine is `engine.ts`). The extension
// has no session with the QTS server: what the engine needs from it (a journal row, a settle, an estimate, a rule's
// pause, a lease renewal) goes to a page that holds the lease as a `bg:buy_orders_engine` push, and comes back as the
// page's `buy_orders_engine_answer` with the same request id. Only pages on the web app's own origin push a lease
// (runtime-router), so only they are asked.
import type { BuyOrderActivity, BuyOrdersEngineAnswer, BuyOrdersEnginePush, BuyOrdersEngineRequest } from '@qts/contracts';
import { parseBuyOrdersEngineAnswer } from '@qts/contracts';

import { MARKET_BUY_BOTS_ENABLED, MARKET_BUY_CSMONEY_MARKET_ENABLED } from '@/shared/market-buy-config';

import { getStoredBuyOrders, onBuyOrdersStored } from '../buy-orders-store';
import { deviceId } from '../device-id';
import { confirmMarketAccount, executeMarketBuy, marketAccountCache, marketBuyRegistry } from '../market-buy/executor';
import { BUY_ORDER_ENGINE_FEED_HOLDER } from '../market-feed/feed-poller';
import { marketFeed, onMarketFeedListings } from '../market-feed/service';
import { type BuyOrderEngine, createBuyOrderEngine } from './engine';

/** The background → content-script push; the content script relays it as `buy_orders_engine_request` / `_event`. */
export const BUY_ORDERS_ENGINE_PUSH_TYPE = 'bg:buy_orders_engine';
const STATE_KEY = 'qts:buy_orders_engine';

const pending = new Map<string, (answer: BuyOrdersEngineAnswer | null) => void>();

function pushTo(tabId: number, data: BuyOrdersEnginePush): Promise<unknown> {
  return browser.tabs.sendMessage(tabId, { type: BUY_ORDERS_ENGINE_PUSH_TYPE, data });
}

/** One request to the first of these pages that takes the message; its answer, or null after `timeoutMs`. */
function ask(tabIds: readonly number[], request: BuyOrdersEngineRequest, timeoutMs: number): Promise<BuyOrdersEngineAnswer | null> {
  if (!tabIds.length || timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(null), timeoutMs);
    function done(answer: BuyOrdersEngineAnswer | null) {
      if (!pending.delete(request.requestId)) return;
      clearTimeout(timer);
      resolve(answer);
    }
    pending.set(request.requestId, done);
    void (async () => {
      for (const tabId of tabIds) {
        try {
          await pushTo(tabId, { request });
          return;
        } catch {
          // That tab is gone or has no content script: the next one.
        }
      }
      done(null);
    })();
  });
}

/** `site:buy_orders_engine_answer`: a page's answer to one of the engine's requests. */
export function answerEngineRequest(value: unknown): { requestId: string; accepted: boolean } {
  const answer = parseBuyOrdersEngineAnswer(value);
  const requestId = typeof (value as { requestId?: unknown } | null)?.requestId === 'string' ? String((value as { requestId: string }).requestId).slice(0, 64) : '';
  if (!answer) return { requestId, accepted: false };
  const resolve = pending.get(answer.requestId);
  if (!resolve) return { requestId, accepted: false };
  resolve(answer);
  return { requestId, accepted: true };
}

function notify(tabIds: readonly number[], event: BuyOrderActivity): void {
  for (const tabId of tabIds) void pushTo(tabId, { event }).catch(() => undefined);
}

let instance: BuyOrderEngine | null = null;

export function buyOrderEngine(): BuyOrderEngine {
  if (instance) return instance;
  const engine = createBuyOrderEngine({
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    execute: (request, options) => executeMarketBuy(request, undefined, options),
    attempted: (key) => marketBuyRegistry.hasRecord(key),
    accounts: marketAccountCache,
    confirmAccount: (platform, steamId) => confirmMarketAccount(platform, steamId),
    ask,
    notify,
    feed: {
      start: async (config) => !(await marketFeed().start({ requestId: 'buy-orders', config }, BUY_ORDER_ENGINE_FEED_HOLDER)).error,
      hold: (until) => marketFeed().hold(BUY_ORDER_ENGINE_FEED_HOLDER, until),
      sources: () => marketFeed().heldSources(BUY_ORDER_ENGINE_FEED_HOLDER),
      stop: async () => {
        await marketFeed().stop({ requestId: 'buy-orders' }, BUY_ORDER_ENGINE_FEED_HOLDER);
      },
    },
    load: async () => (await browser.storage.local.get(STATE_KEY))[STATE_KEY],
    save: async (state) => {
      await browser.storage.local.set({ [STATE_KEY]: state });
    },
    // storage.session survives a worker restart, not a browser restart (nor does the page's lease).
    loadSession: async () => (browser.storage?.session ? (await browser.storage.session.get(STATE_KEY))[STATE_KEY] : undefined),
    saveSession: async (state) => {
      if (browser.storage?.session) await browser.storage.session.set({ [STATE_KEY]: state });
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    botsEnabled: MARKET_BUY_BOTS_ENABLED,
    csmoneyMarketEnabled: MARKET_BUY_CSMONEY_MARKET_ENABLED,
    deviceId,
  });
  onMarketFeedListings((rows, at) => engine.onListings(rows, at));
  onBuyOrdersStored((snapshot) => void engine.setRules(snapshot));
  instance = engine;
  return engine;
}

/** Worker start: the stored rules and the lease from storage.session. */
export async function resumeBuyOrderEngine(): Promise<void> {
  const rules = await getStoredBuyOrders().catch(() => null);
  await buyOrderEngine().resume(rules);
}
