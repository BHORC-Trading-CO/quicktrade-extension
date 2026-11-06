import type { ContentBridgeMessage, SiteBridgeMessage } from '@qts/contracts';

import { type BridgeSender, buySenderError, isOwnExtensionPage, pageSenderError } from '@/shared/bridge-policy';
import { BRIDGE_MODE } from '@/shared/config';
import type { RuntimeMessage } from '@/shared/messaging';

import { handleContentMessage } from './handlers/content';
import { handlePopupMessage } from './handlers/popup';
import { handleSiteMessage } from './handlers/site';
import { refusedMarketBuy } from './market-buy/executor';

/**
 * What drives or reads the buy-order engine (QUICK-233): the rules it buys by, its lease, its stop, its view (the
 * activity, the spend) and the page's answers to it.
 */
const ENGINE_MESSAGES: ReadonlySet<string> = new Set([
  'site:set_buy_orders',
  'site:get_buy_orders_engine',
  'site:set_buy_orders_lease',
  'site:set_buy_orders_stopped',
  'site:buy_orders_engine_answer',
]);

/** The account's working browser (QUICK-305): a page hands its claim answer, a device token among it, to the extension. */
const ACTIVE_BROWSER_MESSAGES: ReadonlySet<string> = new Set(['site:set_active_browser', 'site:get_active_browser']);

function isBuyOrderOrigin(data: unknown): boolean {
  const origin = typeof data === 'object' && data !== null ? (data as { origin?: unknown }).origin : undefined;
  return typeof origin === 'object' && origin !== null && (origin as { kind?: unknown }).kind !== 'manual';
}

export function onRuntimeMessage(message: unknown, sender: BridgeSender, sendResponse: (response: unknown) => void): boolean {
  if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'invalid message' });
    return false;
  }
  const { type } = message;
  if (type.startsWith('popup:')) {
    if (!isOwnExtensionPage(sender, browser.runtime.id, browser.runtime.getURL('/'))) {
      sendResponse({ ok: false, error: 'bridge_untrusted_sender' });
      return false;
    }
    handlePopupMessage(message as RuntimeMessage).then(sendResponse);
    return true;
  }
  if (type.startsWith('site:') || type.startsWith('content:')) {
    const error = pageSenderError(sender, browser.runtime.id, BRIDGE_MODE);
    if (error) {
      sendResponse({ ok: false, error });
      return false;
    }
    // QUICK-226: a purchase only from the web app's own origin; the apex gets an unsent result and nothing is read or sent.
    if (type === 'site:market_buy' && buySenderError(sender, browser.runtime.id, BRIDGE_MODE)) {
      sendResponse({ ok: true, data: refusedMarketBuy((message as { data?: unknown }).data, 'origin_not_allowed') });
      return false;
    }
    // QUICK-233: a page asks for manual purchases only; a buy-order attempt starts in the extension's engine.
    if (type === 'site:market_buy' && isBuyOrderOrigin((message as { data?: unknown }).data)) {
      sendResponse({ ok: true, data: refusedMarketBuy((message as { data?: unknown }).data, 'origin_not_allowed') });
      return false;
    }
    // QUICK-233: what drives the buy-order engine comes from the web app's own origin only.
    if ((ENGINE_MESSAGES.has(type) || ACTIVE_BROWSER_MESSAGES.has(type)) && buySenderError(sender, browser.runtime.id, BRIDGE_MODE)) {
      sendResponse({ ok: false, error: 'origin_not_allowed' });
      return false;
    }
    if (type.startsWith('site:')) handleSiteMessage(message as SiteBridgeMessage, { tabId: sender.tab?.id }).then(sendResponse);
    else handleContentMessage(message as ContentBridgeMessage).then(sendResponse);
    return true;
  }
  sendResponse({ ok: false, error: `unhandled type: ${type}` });
  return false;
}
