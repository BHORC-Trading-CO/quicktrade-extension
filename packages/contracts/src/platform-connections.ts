/**
 * The marketplaces the extension can connect, bundled into it (QUICK-202). The consent page asks the browser for
 * exactly these origins, the status service checks them, and a `cookie` login check may report the presence of the
 * cookie named here and no other. The page chooses platform ids from this table; it never supplies an origin, a URL
 * or a cookie name. The web's PLATFORM_CATALOG must agree with it (`platform-connections.test.ts` in apps/web).
 */
export interface PlatformConnection {
  /** The marketplace's name on the extension's consent page. */
  label: string;
  /** Host-permission patterns: exact hosts only, `https://<host>/*`. */
  origins: readonly string[];
  /** Granted at install through the manifest's required host_permissions. */
  defaultGranted?: boolean;
  /** The one cookie whose presence a `cookie` login check may report (never its value). */
  loginCookie?: { url: string; name: string };
}

export const PLATFORM_CONNECTION_TABLE = {
  'cs.money': {
    label: 'CS.Money',
    origins: ['https://cs.money/*'],
    defaultGranted: true,
    loginCookie: { url: 'https://cs.money', name: 'steamid' },
  },
  'csfloat.com': { label: 'CSFloat', origins: ['https://csfloat.com/*'], defaultGranted: true },
  'tradeit.gg': { label: 'Tradeit', origins: ['https://tradeit.gg/*'] },
  'aim.market': {
    label: 'aim.market',
    origins: ['https://aim.market/*'],
    loginCookie: { url: 'https://aim.market', name: '__user-store' },
  },
  'lis-skins.com': { label: 'LIS-Skins', origins: ['https://lis-skins.com/*', 'https://app.lis-skins.com/*'] },
  'avan.market': { label: 'avan.market', origins: ['https://avan.market/*'] },
  'ntskins.com': { label: 'NTSkins', origins: ['https://ntskins.com/*'] },
  'skinport.com': { label: 'Skinport', origins: ['https://skinport.com/*'] },
  'dmarket.com': {
    label: 'DMarket',
    origins: ['https://dmarket.com/*', 'https://api.dmarket.com/*'],
    loginCookie: { url: 'https://dmarket.com', name: 'dm-trade-token' },
  },
  'white.market': {
    label: 'white.market',
    origins: ['https://white.market/*', 'https://api.white.market/*'],
    loginCookie: { url: 'https://white.market', name: 'access-token' },
  },
  'skin.place': { label: 'SkinPlace', origins: ['https://skin.place/*', 'https://api.skin.place/*'] },
  'skinflow.gg': { label: 'Skinflow', origins: ['https://skinflow.gg/*', 'https://api.skinflow.gg/*'] },
  'skinout.gg': { label: 'SkinOut', origins: ['https://skinout.gg/*'] },
  'skinsell.gg': { label: 'SkinSell', origins: ['https://skinsell.gg/*'] },
  'skinswap.com': { label: 'SkinSwap', origins: ['https://skinswap.com/*', 'https://api.skinswap.com/*'] },
  'skinbaron.de': { label: 'SkinBaron', origins: ['https://skinbaron.de/*'] },
  'shadowpay.com': { label: 'ShadowPay', origins: ['https://shadowpay.com/*', 'https://api.shadowpay.com/*'] },
  'waxpeer.com': { label: 'WaxPeer', origins: ['https://waxpeer.com/*'] },
  'buff.market': { label: 'BUFF Market', origins: ['https://buff.market/*', 'https://api.buff.market/*'] },
  'buff.163.com': { label: 'Buff163', origins: ['https://buff.163.com/*'] },
  'haloskins.com': { label: 'HaloSkins', origins: ['https://www.haloskins.com/*', 'https://haloskins.com/*'] },
  'steamcommunity.com': {
    label: 'Steam',
    origins: ['https://steamcommunity.com/*'],
    defaultGranted: true,
    loginCookie: { url: 'https://steamcommunity.com', name: 'steamLoginSecure' },
  },
} as const satisfies Readonly<Record<string, PlatformConnection>>;

/** A platform id of the bundled table (the same set as `Platform`; index.ts asserts it). */
export type ConnectablePlatform = keyof typeof PLATFORM_CONNECTION_TABLE;

const CONNECTABLE_IDS: readonly string[] = Object.keys(PLATFORM_CONNECTION_TABLE);

export function isConnectablePlatform(value: unknown): value is ConnectablePlatform {
  return typeof value === 'string' && CONNECTABLE_IDS.includes(value);
}

/**
 * The known platform ids of a caller-supplied list, first occurrence kept, at most one per bundled platform.
 * Anything that is not an array of known ids contributes nothing.
 */
export function connectablePlatformIds(value: unknown): ConnectablePlatform[] {
  if (!Array.isArray(value)) return [];
  const ids: ConnectablePlatform[] = [];
  for (const entry of value.slice(0, CONNECTABLE_IDS.length * 2)) {
    if (isConnectablePlatform(entry) && !ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

/** The bundled origins of these platforms, without duplicates. Never a wildcard host. */
export function connectionOrigins(platforms: readonly ConnectablePlatform[]): string[] {
  return [...new Set(platforms.flatMap((platform) => PLATFORM_CONNECTION_TABLE[platform].origins))];
}

// ─── Platform status (QUICK-202) ────────────────────────────────────────────────────────────────

/** Host access of one platform: every origin, some of them, none. */
export type PlatformPermissionState = 'granted' | 'partial' | 'missing';

/**
 * Why a login state is unknown, or what else the platform answered. An enumerated code only: never response text, a
 * header, a cookie value or an account id.
 *  - `not_granted`: the extension may not reach the platform, so nothing was checked;
 *  - `no_check`: the platform has no login check (HaloSkins);
 *  - `check_refused`: the published check is not a bundled read operation or bundled cookie of the platform;
 *  - `network`: the request did not complete (offline, DNS, TLS, blocked by the browser or the network);
 *  - `timeout`: no answer within the time limit;
 *  - `rate_limited`: HTTP 429;
 *  - `captcha`: a recognised challenge (Cloudflare `cf-mitigated: challenge`, cs.money error 4030);
 *  - `server_error`: HTTP 5xx;
 *  - `blocked`: HTTP 403 without a recognised reason;
 *  - `unexpected`: an answer the check cannot read (another status, a body of the wrong shape, a redirect outside the
 *    allowlist);
 *  - `region_blocked`: a verified regional-restriction signal of the platform. None is recognised yet: a failed
 *    request or a 403/451 alone does not prove a region block.
 */
export type PlatformStatusIssue =
  | 'not_granted'
  | 'no_check'
  | 'check_refused'
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'captcha'
  | 'server_error'
  | 'blocked'
  | 'unexpected'
  | 'region_blocked';

/** One platform as the extension last observed it. Status only: the page learns nothing it could sign in with. */
export interface PlatformConnectionStatus {
  platform: ConnectablePlatform;
  permission: PlatformPermissionState;
  login: 'logged-in' | 'logged-out' | 'unknown';
  /** What the login state rests on: a cookie's presence, or the platform's answer to a read request. */
  evidence?: 'cookie' | 'request';
  issue?: PlatformStatusIssue;
  /** HTTP status of the check when it explains the issue (429, 5xx, 403, an unexpected status). */
  httpStatus?: number;
  /** Epoch ms when the platform said a rate limit clears. */
  retryAt?: number;
  /** Epoch ms of the observation. */
  checkedAt: number;
}

/**
 * What an extension build can do beyond the original bridge, announced with `installed`:
 *  - `platform_statuses`: answers `get_platform_statuses` with `PlatformConnectionStatus` rows;
 *  - `connect_tab`: answers `open_connect` (QUICK-202: by opening its consent tab) and `disconnect_platforms`, which
 *    removes optional access;
 *  - `toolbar_connect` (extension 1.6.0, no UI of its own): `open_connect` opens nothing. The extension keeps the
 *    request for `TOOLBAR_CONNECT_TTL_MS` and marks its toolbar icon; the user's click on the icon is the gesture the
 *    browser's permission prompt needs, so the page tells the user to click it;
 *  - `market_search` (extension 1.7.0, QUICK-224): its bundled operations carry the Market page's search keys (CSFloat
 *    price and cursor, cs.money price and seed, cs.money's 6.0 bot feed). An older extension refuses those requests,
 *    so the Market page asks for an update instead of searching.
 *  - `market_buy` (QUICK-226): answers `market_buy` with `market_buy_result`: its buy executor re-reads the listing and
 *    the balance and buys a CSFloat or cs.money market listing at the confirmed price;
 *  - `market_buy_csmoney_market` (27.10): the executor also buys cs.money market listings (off in the build until the
 *    first live cs.money market purchase); without it the web offers only "Open on cs.money" for them.
 *  - `market_buy_bots` (QUICK-226): the executor also buys from cs.money's bot inventory (off by default in the build).
 *  - `buy_orders` (QUICK-232): accepts `set_buy_orders`, the account's QTS buy orders as the server answered them, and
 *    keeps the newest revision per account for the buy-order engine (T11). The web pushes them only to a build that says so.
 *  - `buy_orders_engine` (QUICK-233): runs the buy-order engine: takes the lease the page renews (`set_buy_orders_lease`),
 *    answers `get_buy_orders_engine` / `buy_orders_stop`, and asks the page for the server work it cannot do itself
 *    (`buy_orders_engine_request`, answered with `buy_orders_engine_answer`).
 *  - `diagnostics_journal` (extension 1.9.0, QUICK-214): keeps its scheduler's runs per account (the rule's `owner`) and
 *    hands them to a page of that account with `take_diagnostics`, answered with `diagnostics`.
 *  - `signed_operation_table`: accepts `set_operation_table`, an operation table signed with the key bundled in the
 *    extension (`operation-table-document.ts`). Announced only by a build that carries a real public key.
 * An older extension announces none, and the web keeps the popup path for it.
 */
export type ExtensionCapability =
  | 'platform_statuses'
  | 'connect_tab'
  | 'toolbar_connect'
  | 'market_search'
  | 'market_feed'
  | 'market_buy'
  | 'market_buy_csmoney_market'
  | 'market_buy_bots'
  | 'buy_orders'
  | 'buy_orders_engine'
  | 'diagnostics_journal'
  | 'listing_blocks'
  | 'signed_operation_table'
  /** QUICK-289 (1.10.0): the catalog's `scheduler` policy and batched scheduled writes (`RepriceTemplate.batch`). */
  | 'scheduler_policy'
  /**
   * QUICK-289 PR 2 (1.10.0): a reprice rule's explicit price `schedule`, and the catalog policy's `errors` map (an
   * older build ignores the map; the web sends a schedule only to an extension announcing this).
   */
  | 'scheduler_schedule'
  /**
   * QUICK-296 (1.10.0): price followers (`ScheduledSyncRule`, `sync:` rules) that keep a live listing's price on the
   * reference listing's with the tab closed. The web registers them only with an extension announcing this.
   */
  | 'scheduler_sync'
  /**
   * QUICK-305 (1.12.0): one working browser per account. The extension runs scheduled rules only while it holds the
   * account's lease (`set_active_browser`), renews it alone with its device token, and waits otherwise.
   */
  | 'active_browser';

const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = [
  'platform_statuses',
  'connect_tab',
  'toolbar_connect',
  'market_search',
  'market_feed',
  'market_buy',
  'market_buy_csmoney_market',
  'market_buy_bots',
  'buy_orders',
  'buy_orders_engine',
  'diagnostics_journal',
  'listing_blocks',
  'signed_operation_table',
  'scheduler_policy',
  'scheduler_schedule',
  'scheduler_sync',
  'active_browser',
];

/** How long a toolbar-icon connect request waits for the click (capability `toolbar_connect`). */
export const TOOLBAR_CONNECT_TTL_MS = 5 * 60 * 1000;

/** The known capabilities of an announcement, in a stable order; anything else is ignored. */
export function parseExtensionCapabilities(value: unknown): ExtensionCapability[] {
  if (!Array.isArray(value)) return [];
  return EXTENSION_CAPABILITIES.filter((capability) => value.includes(capability));
}
