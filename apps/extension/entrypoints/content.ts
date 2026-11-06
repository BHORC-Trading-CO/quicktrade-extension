import type { AuthHandoffMessage, ExtensionMessageName, SiteMessage, SiteMessageName } from '@qts/contracts';

import { appExcludeMatchPatterns, appMatchPatterns, isAllowedPageMessage, isExcludedAppPath, pageTargetOrigin } from '@/shared/bridge-policy';
import { EXTENSION_CAPABILITIES } from '@/shared/capabilities';
import { BRIDGE_MODE } from '@/shared/config';

function isSiteMessage(value: unknown): value is SiteMessage {
  return typeof value === 'object' && value !== null && 'type' in value && (value as { type: unknown }).type === 'site' && 'name' in value;
}

function isAuthHandoff(value: unknown): value is AuthHandoffMessage {
  return typeof value === 'object' && value !== null && 'type' in value && (value as { type: unknown }).type === 'qts:auth_handoff';
}

const SITE_TO_BG_TOPIC: Partial<Record<SiteMessageName, string>> = {
  get_user_data_from_platforms: 'site:get_user_data_from_platforms',
  get_inventory_from_platforms: 'site:get_inventory_from_platforms',
  get_transactions_from_platforms: 'site:get_transactions_from_platforms',
  get_competitors_for_item: 'site:get_competitors_for_item',
  send_items_on_sale_on_platforms: 'site:send_items_on_sale_on_platforms',
  remove_items_from_sale_on_platforms: 'site:remove_items_from_sale_on_platforms',
  proxy_request: 'site:proxy_request',
  get_cookie: 'site:get_cookie',
  set_dnr_rules: 'site:set_dnr_rules',
  set_platform_catalog: 'site:set_platform_catalog',
  set_operation_table: 'site:set_operation_table',
  open_popup: 'site:open_popup',
  register_rule: 'site:register_rule',
  cancel_rule: 'site:cancel_rule',
  list_rules: 'site:list_rules',
  get_login_statuses: 'site:get_login_statuses',
  get_platform_statuses: 'site:get_platform_statuses',
  take_diagnostics: 'site:take_diagnostics',
  open_connect: 'site:open_connect',
  disconnect_platforms: 'site:disconnect_platforms',
  set_ui_locale: 'site:set_ui_locale',
  market_feed_start: 'site:market_feed_start',
  market_feed_stop: 'site:market_feed_stop',
  market_feed_retry: 'site:market_feed_retry',
  get_market_feed: 'site:get_market_feed',
  get_market_feed_buffer: 'site:get_market_feed_buffer',
  market_buy: 'site:market_buy',
  set_buy_orders: 'site:set_buy_orders',
  set_buy_orders_lease: 'site:set_buy_orders_lease',
  get_buy_orders_engine: 'site:get_buy_orders_engine',
  set_buy_orders_stopped: 'site:set_buy_orders_stopped',
  buy_orders_engine_answer: 'site:buy_orders_engine_answer',
  set_listing_blocks: 'site:set_listing_blocks',
  set_active_browser: 'site:set_active_browser',
  get_active_browser: 'site:get_active_browser',
};

const BG_TO_PAGE_TOPIC: Partial<Record<SiteMessageName, ExtensionMessageName>> = {
  get_user_data_from_platforms: 'user_data_from_platforms',
  get_inventory_from_platforms: 'inventory_from_platforms',
  get_transactions_from_platforms: 'transactions_from_platforms',
  get_competitors_for_item: 'competitors_for_item',
  send_items_on_sale_on_platforms: 'items_sent_on_sale',
  remove_items_from_sale_on_platforms: 'items_removed_from_sale',
  proxy_request: 'proxy_response',
  get_cookie: 'cookie_response',
  list_rules: 'rules_list',
  get_login_statuses: 'login_statuses',
  get_platform_statuses: 'platform_statuses',
  take_diagnostics: 'diagnostics',
  open_connect: 'connect_opened',
  disconnect_platforms: 'platforms_disconnected',
  market_feed_start: 'market_feed_state',
  market_feed_stop: 'market_feed_state',
  market_feed_retry: 'market_feed_state',
  get_market_feed: 'market_feed',
  get_market_feed_buffer: 'market_feed_buffer',
  market_buy: 'market_buy_result',
  set_buy_orders: 'buy_orders_set',
  set_buy_orders_lease: 'buy_orders_engine',
  get_buy_orders_engine: 'buy_orders_engine',
  set_buy_orders_stopped: 'buy_orders_engine',
  buy_orders_engine_answer: 'buy_orders_engine_ack',
  set_active_browser: 'active_browser',
  get_active_browser: 'active_browser',
};

/** The background's Market feed push (QUICK-231): `{ type: 'bg:market_feed_update', data }`, relayed as `market_feed_update`. */
function isFeedPush(value: unknown): value is { type: 'bg:market_feed_update'; data: unknown } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'bg:market_feed_update';
}

/** The buy-order engine's push (QUICK-233): `{ type: 'bg:buy_orders_engine', data: { request } | { event } }`. */
function isEnginePush(value: unknown): value is { type: 'bg:buy_orders_engine'; data: { request?: unknown; event?: unknown } } {
  if (typeof value !== 'object' || value === null || (value as { type?: unknown }).type !== 'bg:buy_orders_engine') return false;
  const data = (value as { data?: unknown }).data;
  return typeof data === 'object' && data !== null;
}

interface QtsContentWindow extends Window {
  qtsContentLoaded?: boolean;
}

/** `document.prerendering` (Chrome 108+) is not in every DOM lib version yet. */
interface PrerenderingDocument {
  prerendering?: boolean;
}

export default defineContentScript({
  matches: appMatchPatterns(BRIDGE_MODE),
  excludeMatches: appExcludeMatchPatterns(BRIDGE_MODE),
  main() {
    // The path check also covers background re-injection, which ignores exclude_matches.
    if (!pageTargetOrigin(location.origin, BRIDGE_MODE) || isExcludedAppPath(location.pathname)) return;

    function postToPage(message: unknown) {
      const targetOrigin = pageTargetOrigin(location.origin, BRIDGE_MODE);
      if (targetOrigin) window.postMessage(message, targetOrigin);
    }
    // When the extension is re-enabled, the background re-injects this script
    // into already-open tabs (Chrome won't do it automatically). Guard against
    // running twice — a second message listener would double every bridge reply.
    const qtsWindow = window as unknown as QtsContentWindow;
    if (qtsWindow.qtsContentLoaded) return;
    qtsWindow.qtsContentLoaded = true;

    console.log('[qts content] script loaded at', location.href);

    // A Chrome-prerendered page is not yet the tab's primary main frame, so the background refuses its
    // messages (non-zero frameId). Hold bridge traffic until the page is shown; then frameId is 0.
    let activation: Promise<void> | null = null;
    if ((document as PrerenderingDocument).prerendering) {
      activation = new Promise((resolve) => {
        document.addEventListener(
          'prerenderingchange',
          () => {
            activation = null;
            resolve();
          },
          { once: true }
        );
      });
    }
    let announceQueued = false;

    /**
     * Reloading or updating the extension leaves this script running in tabs already open, cut off from the
     * background: `runtime.id` is gone and every runtime call throws "Extension context invalidated". The page
     * keeps probing every 2 s, so stop listening. The new copy is injected by the background and answers instead.
     */
    function retireIfOrphaned(): boolean {
      if (browser.runtime?.id) return false;
      window.removeEventListener('message', onPageMessage);
      return true;
    }

    async function handleSiteMessage(message: SiteMessage) {
      // Handshake: page asks us to (re-)announce ourselves. Used by
      // ExtensionProvider on mount to avoid the race where the page's listener
      // is attached after content script's initial announce bursts.
      if (message.name === 'probe_installed') {
        void announce();
        return;
      }
      const bgType = SITE_TO_BG_TOPIC[message.name];
      if (!bgType) {
        console.warn('[qts content] no bgType for', message.name);
        return;
      }

      try {
        if (activation) await activation;
        const data = 'data' in message ? message.data : undefined;
        const response = await browser.runtime.sendMessage({ type: bgType, data });
        const responseName = BG_TO_PAGE_TOPIC[message.name] ?? `${message.name}_response`;
        postToPage({
          type: 'extension',
          name: responseName,
          data: response?.ok ? response.data : { error: response?.error ?? 'unknown' },
        });
      } catch (error) {
        if (!retireIfOrphaned()) console.warn('[qts content] background relay failed', error);
      }
    }

    async function handleAuthHandoff(message: AuthHandoffMessage) {
      try {
        if (activation) await activation;
        await browser.runtime.sendMessage({
          type: 'content:auth_handoff',
          auth: message.data.auth,
          user: message.data.user,
        });
      } catch (error) {
        if (!retireIfOrphaned()) console.warn('[qts content] failed to forward auth', error);
      }
    }

    function onPageMessage(event: MessageEvent) {
      if (!isAllowedPageMessage(event, window, location.origin, BRIDGE_MODE)) return;
      if (retireIfOrphaned()) return;
      const data: unknown = event.data;
      if (isSiteMessage(data)) {
        void handleSiteMessage(data);
        return;
      }
      if (isAuthHandoff(data)) {
        void handleAuthHandoff(data);
      }
    }
    window.addEventListener('message', onPageMessage);

    // Only this extension's background can reach a content script's runtime listener.
    browser.runtime.onMessage?.addListener((message: unknown) => {
      if (isFeedPush(message)) postToPage({ type: 'extension', name: 'market_feed_update', data: message.data });
      if (isEnginePush(message)) {
        if (message.data.request !== undefined) postToPage({ type: 'extension', name: 'buy_orders_engine_request', data: message.data.request });
        else if (message.data.event !== undefined) postToPage({ type: 'extension', name: 'buy_orders_engine_event', data: message.data.event });
      }
    });

    async function announce() {
      if (activation) {
        // The page probes every 2 s while prerendered: announce once, after activation.
        if (announceQueued) return;
        announceQueued = true;
        await activation;
      }
      let permissions: Record<string, boolean> = {};
      try {
        const res = await browser.runtime.sendMessage({ type: 'site:get_permissions' });
        if (res?.ok && typeof res.data === 'object' && res.data !== null) {
          permissions = res.data as Record<string, boolean>;
        }
      } catch (e) {
        if (!retireIfOrphaned()) console.warn('[qts content] get_permissions failed:', e);
      }
      // getManifest() below throws in an orphaned script, and nothing awaits this function.
      if (retireIfOrphaned()) return;
      postToPage({
        type: 'extension',
        name: 'installed',
        // Static: the 2 s heartbeat reads permissions only and never probes a marketplace.
        data: { isInstalled: true, version: browser.runtime.getManifest().version, permissions, capabilities: [...EXTENSION_CAPABILITIES] },
      });
    }
    // Immediate announce covers the warm-reload case (page already mounted
    // when the extension is reinstalled — ExtensionProvider's listener is
    // already attached). The cold-load case (content script injects before
    // React hydrates) is handled by `site:probe_installed` instead.
    void announce();
  },
});
