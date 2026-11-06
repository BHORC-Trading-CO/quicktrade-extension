// apps/extension/background/handlers/site.ts
import type { CookiePartitionKey, HttpRequest, ScheduledRule, SiteBridgeMessage } from '@qts/contracts';
import { connectablePlatformIds, operationTableRefusedError, parseActiveBrowserPush, parseBuyOrdersLeasePush, PLATFORM_CONNECTIONS } from '@qts/contracts';

import type { RuntimeResponse } from '@/shared/messaging';
import { platformPermission } from '@/shared/platform-access';
import { getPlatformCatalog } from '@/shared/platformCatalog';
import { StorageKeys } from '@/shared/storage';

import { acceptActiveBrowserPush, activeBrowserView } from '../active-browser';
import { answerEngineRequest, buyOrderEngine } from '../buy-orders/service';
import { acceptBuyOrders } from '../buy-orders-store';
import { disconnectPlatforms, promptFromPageClick } from '../connect-service';
import { takeJournalEntries } from '../diagnostics-journal';
import { installPageDnrRules } from '../dnr-service';
import { setListingBlocks } from '../listing-blocks';
import { checkAllLogins } from '../loginStatus';
import { executeMarketBuy } from '../market-buy/executor';
import { beginForegroundRequest } from '../market-feed/feed-priority';
import { marketFeed } from '../market-feed/service';
import { acceptOperationTable } from '../operation-table-store';
import { getAllPermissionsStatus } from '../permissions';
import { getPlatformStatuses } from '../platform-status';
import { getCookie, proxyRequest } from '../proxy';
import { cancelRule, getRules, registerRule } from '../scheduler';
import { armToolbarConnect } from '../toolbar-connect';

const ALL_PLATFORMS = connectablePlatformIds(Object.keys(PLATFORM_CONNECTIONS));
/** The page's correlation id is echoed back as it came, cut to this length. */
const MAX_REQUEST_ID_LENGTH = 64;

interface ProxyRequestPayload {
  requestId: string;
  platform: string;
  request: HttpRequest;
}

interface GetCookiePayload {
  requestId: string;
  url: string;
  name: string;
  partitionKey?: CookiePartitionKey;
}

interface CancelRulePayload {
  ruleId: string;
}

/**
 * The `data` field on the bridge envelope is a loose union (it has to hold
 * payloads for every site message kind), so per-branch narrowing happens via
 * dedicated payload interfaces above. The runtime shape is guaranteed by the
 * web-side dispatcher.
 */
function asProxyPayload(data: SiteBridgeMessage['data']): Partial<ProxyRequestPayload> | undefined {
  return data as Partial<ProxyRequestPayload> | undefined;
}

function asCookiePayload(data: SiteBridgeMessage['data']): GetCookiePayload {
  return data as GetCookiePayload;
}

function asRulePayload(data: SiteBridgeMessage['data']): ScheduledRule {
  return data as unknown as ScheduledRule;
}

function asCancelPayload(data: SiteBridgeMessage['data']): CancelRulePayload {
  return data as CancelRulePayload;
}

function requestIdOf(data: unknown): string {
  const requestId = (data as { requestId?: unknown } | undefined)?.requestId;
  return typeof requestId === 'string' ? requestId.slice(0, MAX_REQUEST_ID_LENGTH) : '';
}

/** Who sent the message: the router has already checked it is the web app's top frame. */
export interface SiteMessageContext {
  tabId?: number;
}

export async function handleSiteMessage(message: SiteBridgeMessage, context: SiteMessageContext = {}): Promise<RuntimeResponse<unknown>> {
  try {
    switch (message.type) {
      case 'site:proxy_request': {
        const d = asProxyPayload(message.data);
        const request = d?.request;
        // Only an instance of a bundled operation of `platform` is sent (QUICK-171); a refusal still answers the requestId.
        // The page goes first: the Market live feed waits while its CSFloat / cs.money request runs (QUICK-231).
        const foreground = beginForegroundRequest(typeof d?.platform === 'string' ? d.platform : '', { url: request?.url, method: request?.method });
        let result: Awaited<ReturnType<typeof proxyRequest>> | undefined;
        try {
          result = await proxyRequest(typeof request?.url === 'string' ? request.url : '', {
            method: request?.method,
            headers: request?.headers,
            body: request?.body,
            credentials: request?.credentials,
            platform: typeof d?.platform === 'string' ? d.platform : '',
            purpose: 'page',
          });
        } finally {
          foreground.end(result);
        }
        return { ok: true, data: { requestId: d?.requestId, ...result } };
      }

      case 'site:get_cookie': {
        const d = asCookiePayload(message.data ?? {});
        const result = await getCookie(d.url, d.name, d.partitionKey);
        return { ok: true, data: { requestId: d.requestId, ...result } };
      }

      case 'site:get_permissions': {
        const permissions = await getAllPermissionsStatus();
        return { ok: true, data: permissions };
      }

      case 'site:open_popup': {
        // A web tab from before connect_tab still asks for the popup ("Grant access"). The extension has no popup or
        // consent tab any more (1.6.0): the next click on its toolbar icon asks for every platform it cannot fully
        // reach, the old "Allow all" with explicit domains. When nothing is missing, there is nothing to ask for.
        const states = await Promise.all(ALL_PLATFORMS.map(async (platform) => [platform, await platformPermission(platform)] as const));
        const missing = states.filter(([, state]) => state !== 'granted').map(([platform]) => platform);
        if (!missing.length) return { ok: false, error: 'no_platforms' };
        return { ok: true, data: { opened: await armToolbarConnect(missing, context.tabId ?? null) } };
      }

      case 'site:set_platform_catalog': {
        const catalog = message.data?.catalog ?? [];
        await browser.storage.local.set({ [StorageKeys.platformCatalog]: catalog });
        return { ok: true, data: { stored: catalog.length } };
      }

      case 'site:set_operation_table': {
        // Verified with the bundled key and the hard limits before it replaces any platform's operations.
        const result = await acceptOperationTable(message.data);
        if (!result.ok) return { ok: false, error: operationTableRefusedError(result.refusal) };
        return { ok: true, data: { version: result.version, unchanged: result.unchanged } };
      }

      case 'site:set_dnr_rules': {
        return { ok: true, data: await installPageDnrRules(message.data) };
      }

      case 'site:register_rule': {
        await registerRule(asRulePayload(message.data));
        return { ok: true, data: null };
      }

      case 'site:cancel_rule': {
        const d = asCancelPayload(message.data);
        await cancelRule(d.ruleId);
        return { ok: true, data: null };
      }

      case 'site:take_diagnostics': {
        // QUICK-214: this account's scheduler runs, handed over once (another account's stay for its own page).
        const owner = (message.data as { owner?: unknown } | undefined)?.owner;
        return { ok: true, data: { requestId: requestIdOf(message.data), entries: await takeJournalEntries(owner) } };
      }

      case 'site:list_rules': {
        const rules = await getRules();
        return { ok: true, data: { rules } };
      }

      case 'site:get_login_statuses': {
        const catalog = await getPlatformCatalog();
        const statuses = await checkAllLogins(catalog);
        return { ok: true, data: { statuses } };
      }

      case 'site:get_platform_statuses': {
        // Platform ids only (unknown ones dropped); the extension resolves origins and checks from bundled data.
        const d = message.data;
        const requestId = typeof d?.requestId === 'string' ? d.requestId.slice(0, MAX_REQUEST_ID_LENGTH) : '';
        const platforms = d?.platforms === undefined ? ALL_PLATFORMS : connectablePlatformIds(d.platforms);
        const statuses = await getPlatformStatuses(platforms, { force: d?.force === true });
        return { ok: true, data: { requestId, statuses } };
      }

      case 'site:open_connect': {
        // Ids only (the locale was for older builds' consent tab): the domains come from bundled data.
        const platforms = connectablePlatformIds(message.data?.platforms);
        if (!platforms.length) return { ok: false, error: 'no_platforms' };
        // The browser's prompt straight from the page's Connect click, when the browser lets that click count as the
        // user gesture permissions.request needs. The call must come before any await. Refused: the toolbar icon asks.
        if (await promptFromPageClick(platforms)) return { ok: true, data: { opened: 'prompt' } };
        return { ok: true, data: { opened: await armToolbarConnect(platforms, context.tabId ?? null) } };
      }

      case 'site:disconnect_platforms': {
        return { ok: true, data: { removed: await disconnectPlatforms(connectablePlatformIds(message.data?.platforms)) } };
      }

      case 'site:market_buy': {
        // QUICK-226: the page only asks; the executor re-reads, claims the listing and sends the one buy request.
        return { ok: true, data: await executeMarketBuy(message.data) };
      }

      // The Market live feed (QUICK-231, capability `market_feed`); every answer echoes the page's requestId.
      case 'site:market_feed_start': {
        return { ok: true, data: await marketFeed().start(message.data, context.tabId) };
      }

      case 'site:market_feed_stop': {
        return { ok: true, data: await marketFeed().stop(message.data, context.tabId) };
      }

      case 'site:market_feed_retry': {
        return { ok: true, data: await marketFeed().retry(message.data) };
      }

      case 'site:get_market_feed': {
        return { ok: true, data: await marketFeed().read(message.data, context.tabId) };
      }

      case 'site:get_market_feed_buffer': {
        return { ok: true, data: await marketFeed().readBuffer(message.data) };
      }

      case 'site:set_buy_orders': {
        // QUICK-232: the account's buy orders as the server answered them; kept only when valid and newer.
        const result = await acceptBuyOrders(message.data);
        return 'error' in result ? { ok: false, error: result.error } : { ok: true, data: result };
      }

      // The buy-order engine (QUICK-233, capability `buy_orders_engine`); the router lets only the web app's own origin
      // push a lease or answer the engine.
      case 'site:set_buy_orders_lease': {
        const push = parseBuyOrdersLeasePush(message.data);
        if (!push) return { ok: true, data: { error: 'buy_orders_lease_refused:invalid' } };
        return { ok: true, data: await buyOrderEngine().setLease(push, context.tabId) };
      }

      // The account's working browser (QUICK-305, capability `active_browser`); the router lets only the web app's own
      // origin hand a claim answer over.
      case 'site:set_active_browser': {
        const push = parseActiveBrowserPush(message.data);
        if (!push) return { ok: true, data: { error: 'active_browser_refused:invalid' } };
        return { ok: true, data: await acceptActiveBrowserPush(push) };
      }

      case 'site:get_active_browser':
        return { ok: true, data: await activeBrowserView(requestIdOf(message.data)) };

      case 'site:get_buy_orders_engine': {
        await buyOrderEngine().init();
        return { ok: true, data: buyOrderEngine().view(requestIdOf(message.data)) };
      }

      case 'site:set_buy_orders_stopped': {
        const stopped = (message.data as { stopped?: unknown } | undefined)?.stopped;
        if (typeof stopped !== 'boolean') return { ok: true, data: { requestId: requestIdOf(message.data), error: 'invalid' } };
        return { ok: true, data: { ...(await buyOrderEngine().setStopped(stopped)), requestId: requestIdOf(message.data) } };
      }

      case 'site:set_listing_blocks':
        return { ok: true, data: await setListingBlocks(message.data) };
      case 'site:buy_orders_engine_answer': {
        return { ok: true, data: answerEngineRequest(message.data) };
      }

      case 'site:set_ui_locale': {
        // Still accepted from the web; with no page of its own (1.6.0) the extension has nothing to translate.
        return { ok: true, data: null };
      }

      default:
        return { ok: false, error: `unhandled site message: ${(message as { type: string }).type}` };
    }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
