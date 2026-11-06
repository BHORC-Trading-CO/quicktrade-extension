// apps/extension/entrypoints/background.ts
import { ACTIVE_BROWSER_ALARM, onActiveBrowserWorking, tickActiveBrowser } from '@/background/active-browser';
import { buyOrderEngine, resumeBuyOrderEngine } from '@/background/buy-orders/service';
import { migrateLegacyPageDnrRules } from '@/background/dnr-service';
import { primeHaloSkins } from '@/background/haloskins-service';
import { accountPlatformOfCookie } from '@/background/market-buy/account-cache';
import { marketAccountCache } from '@/background/market-buy/executor';
import { MARKET_FEED_WATCHDOG_ALARM, marketFeed } from '@/background/market-feed/service';
import { getEffectiveOperationTable } from '@/background/operation-table-store';
import { onRuntimeMessage } from '@/background/runtime-router';
import { ensureIndex, processDueRules } from '@/background/scheduler';
import { expirePendingConnect, onToolbarClicked, PENDING_CONNECT_ALARM, restorePendingConnect, toolbarApi } from '@/background/toolbar-connect';
import { REPRICE_CONTINUE_ALARM, REPRICE_TICK_ALARM } from '@/models/constants';
import { appMatchPatterns, appOriginFromUrl, isAllowedAppOrigin } from '@/shared/bridge-policy';
import { BRIDGE_MODE } from '@/shared/config';
import { StorageKeys } from '@/shared/storage';

const REINJECT_SESSION_FLAG = 'qts:contentReinjected';

/**
 * Re-enabling the extension does NOT re-inject manifest-declared content
 * scripts into tabs that were already open. Without that, the web app can't
 * tell the extension has come back (it talks to the content script). So on
 * service-worker startup — which is exactly when the extension is enabled — we
 * inject the content script into any open app tabs ourselves. The content
 * script guards against double-init, and a session flag keeps this to once per
 * enable (the SW wakes many times per session otherwise).
 */
async function reinjectContentScriptIntoOpenTabs(): Promise<void> {
  if (!browser.scripting?.executeScript || !browser.storage?.session) return;
  try {
    const stored = await browser.storage.session.get(REINJECT_SESSION_FLAG);
    if (stored[REINJECT_SESSION_FLAG]) return;
    await browser.storage.session.set({ [REINJECT_SESSION_FLAG]: true });

    const contentScript = browser.runtime.getManifest().content_scripts?.find((cs) => cs.matches?.some((m) => appMatchPatterns(BRIDGE_MODE).includes(m)));
    const file = contentScript?.js?.[0];
    if (!file) return;

    // No `url` filter (that needs the broad "tabs" permission); instead read
    // tab.url, which host_permissions make visible only for our app origins.
    const tabs = await browser.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id == null || !tab.url || !isAllowedAppOrigin(appOriginFromUrl(tab.url), BRIDGE_MODE)) return;
        try {
          // `file` is read from the manifest at runtime, so it isn't one of
          // WXT's statically-known ScriptPublicPath literals — cast is safe.
          await browser.scripting.executeScript({ target: { tabId: tab.id }, files: [file as ScriptPublicPath] });
        } catch {
          // Tab not injectable (discarded, mid-navigation, …) — ignore.
        }
      })
    );
  } catch {
    // storage.session / tabs unavailable — non-fatal, page reload still works.
  }
}

/**
 * Alarms outlive the service worker, and `alarms.create` with an existing name replaces the alarm and
 * restarts its period. This file runs on every worker start, so create the alarm only when it is missing
 * (or its period changed); otherwise every wake-up would push the next tick back.
 */
async function ensurePeriodicAlarm(name: string, periodInMinutes: number): Promise<void> {
  try {
    const existing = await browser.alarms.get(name);
    if (existing?.periodInMinutes === periodInMinutes) return;
  } catch {
    // Lookup failed: (re)create it, as every start did before this guard.
  }
  await browser.alarms.create(name, { periodInMinutes });
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(onRuntimeMessage);
  // No popup and no page of its own (1.6.0): the toolbar icon click is the user gesture for a pending marketplace
  // access request from the site's Platforms page, and opens that page otherwise (toolbar-connect.ts).
  toolbarApi()?.onClicked.addListener(onToolbarClicked);
  void restorePendingConnect();
  browser.runtime.onInstalled.addListener(() => void migrateLegacyPageDnrRules());
  void migrateLegacyPageDnrRules();

  // Background owns HaloSkins credentials; both old and new web primers can remain unchanged. No polling
  // alarm: a stale rule is refreshed right before the next HaloSkins proxy request (handlers/site.ts).
  browser.permissions.onAdded.addListener(() => void primeHaloSkins());
  browser.permissions.onRemoved.addListener(() => void primeHaloSkins());
  void primeHaloSkins();

  // Old per-point format lived under a single `scheduled_rules` array key — incompatible with the
  // new per-key ramp model. Drop it once (idempotent).
  void browser.storage.local.remove('scheduled_rules');
  // The old popup cached login dots here; the popup no longer checks logins (QUICK-202).
  void browser.storage.local.remove('qts_login_statuses');
  // The consent tab's language; nothing reads it since the tab was removed (1.6.0).
  void browser.storage.local.remove(StorageKeys.siteLocale);
  browser.runtime.onStartup.addListener(() => void ensureIndex().then(() => processDueRules()));
  void ensurePeriodicAlarm(REPRICE_TICK_ALARM, 360);
  void ensureIndex().then(() => processDueRules());
  // QUICK-305: one browser of the account runs the rules. Its lease is renewed (or, on standby, checked) by an alarm;
  // getting the lease runs the due rules at once.
  onActiveBrowserWorking(() => void processDueRules());
  void ensurePeriodicAlarm(ACTIVE_BROWSER_ALARM, 1);
  void tickActiveBrowser();

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ACTIVE_BROWSER_ALARM) void tickActiveBrowser();
    if (alarm.name === REPRICE_TICK_ALARM || alarm.name === REPRICE_CONTINUE_ALARM) void processDueRules();
    if (alarm.name === PENDING_CONNECT_ALARM) void expirePendingConnect();
    if (alarm.name === MARKET_FEED_WATCHDOG_ALARM) void marketFeed().resume();
  });

  // The Market live feed (QUICK-231) runs while a QTS tab holds its lease: a closed tab drops it at once, and a worker
  // the browser stopped picks the loop up again from storage.session.
  browser.tabs?.onRemoved?.addListener((tabId) => marketFeed().tabRemoved(tabId));
  void marketFeed().resume();

  // The buy-order engine (QUICK-233) runs while a QTS page of the web app renews its lease; the last such tab closing
  // stops it at once, and a worker restart picks it up from storage.session.
  browser.tabs?.onRemoved?.addListener((tabId) => buyOrderEngine().tabRemoved(tabId));
  void resumeBuyOrderEngine();
  // A marketplace session that changed (a sign-in, a sign-out, another account) drops that marketplace's confirmation:
  // the next automatic buy reads the account first.
  browser.cookies?.onChanged?.addListener(({ cookie }) => {
    const platform = accountPlatformOfCookie(cookie);
    if (platform) marketAccountCache.invalidate(platform);
  });

  void reinjectContentScriptIntoOpenTabs();
  // Verify the stored signed operation table (if any) now, so the first request does not wait for it.
  void getEffectiveOperationTable();
});
