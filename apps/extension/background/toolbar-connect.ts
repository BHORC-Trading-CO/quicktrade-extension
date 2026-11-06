// apps/extension/background/toolbar-connect.ts
//
// The extension has no UI of its own (1.6.0): the browser's permission prompt needs a user gesture in an extension
// context, and the click on the toolbar icon is that gesture. The web asks for platform ids (`open_connect`); the
// background keeps the request for a few minutes and marks the icon; the next click on the icon asks the browser.
// Without a request, the click opens the site's Platforms page.
import type { ConnectablePlatform } from '@qts/contracts';
import { connectablePlatformIds, connectionOrigins, TOOLBAR_CONNECT_TTL_MS } from '@qts/contracts';

import { config } from '@/shared/config';

/** The request in `storage.session`, so it survives the service worker being stopped between the ask and the click. */
export const PENDING_CONNECT_KEY = 'qts:pendingConnect';
/** Clears the request and the icon mark when nobody clicked in time. */
export const PENDING_CONNECT_ALARM = 'qts:pendingConnectExpiry';
const BADGE_TEXT = '+';
const BADGE_COLOR = '#f59e0b';

export interface PendingConnect {
  /** Known platform ids only: the origins are the bundled ones, resolved at the click. */
  platforms: ConnectablePlatform[];
  /** The web app tab that asked: focused again when the click could not show the prompt. */
  tabId: number | null;
  expiresAt: number;
}

/** In memory first: the click handler must call `permissions.request` before any await. */
let pending: PendingConnect | null = null;

type Toolbar = typeof browser.action;

/** MV3 (Chrome) names the toolbar API `action`; Firefox MV2 still names it `browserAction`. */
export function toolbarApi(): Toolbar | undefined {
  return browser.action ?? (browser as unknown as { browserAction?: Toolbar }).browserAction;
}

function sessionStorage(): typeof browser.storage.session | undefined {
  return browser.storage?.session;
}

/** A stored request read back: anything malformed or with no known platform is no request. */
export function parsePendingConnect(value: unknown): PendingConnect | null {
  if (typeof value !== 'object' || value === null) return null;
  const { platforms, tabId, expiresAt } = value as Record<string, unknown>;
  const ids = connectablePlatformIds(platforms);
  if (!ids.length || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { platforms: ids, tabId: typeof tabId === 'number' && Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : null, expiresAt };
}

async function setBadge(text: string): Promise<void> {
  const toolbar = toolbarApi();
  try {
    if (text) await toolbar?.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await toolbar?.setBadgeText({ text });
  } catch {
    // The icon mark is a hint only.
  }
}

async function readStoredRequest(): Promise<PendingConnect | null> {
  const session = sessionStorage();
  if (!session) return null;
  try {
    return parsePendingConnect((await session.get(PENDING_CONNECT_KEY))[PENDING_CONNECT_KEY]);
  } catch {
    return null;
  }
}

/** Forgets the request: memory, session storage, the icon mark and the expiry alarm. */
export async function clearPendingConnect(): Promise<void> {
  pending = null;
  try {
    await sessionStorage()?.remove(PENDING_CONNECT_KEY);
  } catch {
    // Nothing stored.
  }
  await setBadge('');
  try {
    await browser.alarms.clear(PENDING_CONNECT_ALARM);
  } catch {
    // No alarm.
  }
}

/**
 * Keeps a connect request for the next click on the toolbar icon (a newer request replaces it) and marks the icon.
 * The platforms are validated ids; nothing else from the page is kept.
 */
export async function armToolbarConnect(platforms: readonly ConnectablePlatform[], tabId: number | null, now = Date.now()): Promise<'toolbar'> {
  const request: PendingConnect = { platforms: [...platforms], tabId, expiresAt: now + TOOLBAR_CONNECT_TTL_MS };
  pending = request;
  try {
    await sessionStorage()?.set({ [PENDING_CONNECT_KEY]: request });
  } catch {
    // Memory still holds it while the worker runs.
  }
  await setBadge(BADGE_TEXT);
  try {
    await browser.alarms.create(PENDING_CONNECT_ALARM, { when: request.expiresAt });
  } catch {
    // The click checks the expiry anyway.
  }
  return 'toolbar';
}

/** After a worker restart: the request from session storage, so the next click can prompt without an await. */
export async function restorePendingConnect(now = Date.now()): Promise<void> {
  const stored = await readStoredRequest();
  if (pending) return;
  if (stored && stored.expiresAt > now) {
    pending = stored;
    await setBadge(BADGE_TEXT);
  } else {
    await clearPendingConnect();
  }
}

/** The expiry alarm: drops a request nobody clicked for. */
export async function expirePendingConnect(now = Date.now()): Promise<void> {
  const request = pending ?? (await readStoredRequest());
  if (!request || request.expiresAt <= now) await clearPendingConnect();
}

export function openPlatformsPage(): void {
  void browser.tabs.create({ url: `${config.frontend_root}/platforms` }).catch(() => undefined);
}

/** The prompt could not be shown: back to the asking tab (its hint is still there), else the Platforms page. */
async function returnToAskingTab(tabId: number | null): Promise<void> {
  if (tabId !== null) {
    try {
      await browser.tabs.update(tabId, { active: true });
      return;
    } catch {
      // The tab is gone.
    }
  }
  openPlatformsPage();
}

/**
 * Waits for the browser's answer. Granted or declined, the request is done; the page sees the new access through
 * its permission heartbeat. A refusal to prompt (no gesture after a worker restart) keeps the request in memory, so
 * the next click prompts at once, and brings the asking tab back.
 */
async function settle(prompt: Promise<boolean>, request: PendingConnect): Promise<void> {
  try {
    await prompt;
  } catch {
    pending = request;
    await returnToAskingTab(request.tabId);
    return;
  }
  await clearPendingConnect();
}

function requestAccess(request: PendingConnect): Promise<boolean> {
  try {
    return browser.permissions.request({ origins: connectionOrigins(request.platforms) });
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

/** The worker was stopped since the ask: memory is empty, so read the stored request and still try. */
async function clickAfterRestart(): Promise<void> {
  const stored = await readStoredRequest();
  if (!stored || stored.expiresAt <= Date.now()) {
    await clearPendingConnect();
    openPlatformsPage();
    return;
  }
  // Chrome may still accept the gesture after this short read; Firefox does not. Either way the request is now in
  // memory, so a refusal makes the next click synchronous.
  await settle(requestAccess(stored), stored);
}

/**
 * The toolbar icon click. With a request in memory, `permissions.request` is the first call, in the click's own task
 * (Firefox accepts it only there, Chrome only with a user gesture). The origins are the bundled ones of known ids,
 * never a wildcard or a caller URL.
 */
export function onToolbarClicked(): void {
  const request = pending;
  if (request && request.expiresAt > Date.now()) {
    void settle(requestAccess(request), request);
    return;
  }
  if (request) {
    void clearPendingConnect().then(openPlatformsPage);
    return;
  }
  void clickAfterRestart();
}
