/**
 * The account's settings and the browser-collected state that goes with them (QUICK-210): what the web used to keep in
 * the IndexedDB `settings` row. The server stores them per Clerk user (`/api/auth/me/settings`), so they follow the
 * account to another browser. The server imports this module as types only and repeats the value lists and bounds.
 */
import type { Locale } from './i18n';
import type { MarketViews } from './market-views';
import { STEAM_ID64_PATTERN } from './steam-profiles';

/** The currencies Settings offers, in its order (the web's `SUPPORTED_CURRENCIES`). */
export const ACCOUNT_CURRENCIES = ['USD', 'EUR', 'GBP', 'RUB', 'CNY'] as const;
export type AccountCurrency = (typeof ACCOUNT_CURRENCIES)[number];

/** Bounds the server enforces; the web clamps or drops a value outside them before sending it. */
export const ACCOUNT_SETTINGS_BOUNDS = {
  /** The share below the market price that flags a listing price (Settings takes a typed 5–95 %). */
  minPriceDeviation: { min: 0.05, max: 0.95 },

  exitAskRatio: { min: 0.5, max: 1 },

  needRepriceDays: { min: 1, max: 365 },
  steamTradeUrlMaxLength: 256,
  /** Sold-elsewhere notices kept per account; the oldest detections go first. */
  soldElsewhereNotices: 200,
  /** Ask sightings kept per account; the oldest dates go first. */
  askSightings: 5000,
  /** The user's other Steam accounts (SteamID64s) trade history treats as their own. */
  ownSteamIds: 50,
} as const;

/**
 * QUICK-296: the markets the extension can list on and reprice without a tab (sale-form ids, in the sale-strategy
 * order): its scheduler writes only CSFloat and cs.money Market. "List on markets where the item is missing" picks
 * from these; the account's default listing markets among them apply while none is picked.
 */
export const MARKET_SYNC_FORM_IDS = ['cs-money-market', 'csfloat'] as const;
export type MarketSyncFormId = (typeof MARKET_SYNC_FORM_IDS)[number];

export function isMarketSyncFormId(value: unknown): value is MarketSyncFormId {
  return (MARKET_SYNC_FORM_IDS as readonly unknown[]).includes(value);
}

/**
 * The markets "List on markets where the item is missing" lists on: the ones picked, else the account's default
 * listing markets (`defaults`, sale-form ids) the extension can list on. Each once, in MARKET_SYNC_FORM_IDS order.
 */
export function marketSyncTargets(
  picked: readonly string[] | undefined,
  defaults: readonly string[]
): MarketSyncFormId[] {
  const chosen = picked && picked.length > 0 ? picked : defaults;
  return MARKET_SYNC_FORM_IDS.filter((id) => chosen.includes(id));
}

/**
 * The SteamID64 a user typed or pasted: the id itself, or a `steamcommunity.com/profiles/<id>` link. Null for anything
 * else — a vanity `/id/<name>` link names no id without asking Steam.
 */
export function parseSteamId64(text: string): string | null {
  const trimmed = text.trim();
  const id = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d+)\/?$/.exec(trimmed)?.[1] ?? trimmed;
  return STEAM_ID64_PATTERN.test(id) ? id : null;
}

/** A Steam trade offer URL (partner + token, either order), as Steam's privacy page gives it. */
export const STEAM_TRADE_URL_PATTERN =
  /^https?:\/\/(www\.)?steamcommunity\.com\/tradeoffer\/new\/?\?(partner=\d{1,10}&token=[\w-]{1,32}|token=[\w-]{1,32}&partner=\d{1,10})$/;

/** Empty (not set) or a Steam trade offer URL; anything else is refused by the server. */
export function isSteamTradeUrl(value: string): boolean {
  return (
    value === '' ||
    (value.length <= ACCOUNT_SETTINGS_BOUNDS.steamTradeUrlMaxLength && STEAM_TRADE_URL_PATTERN.test(value))
  );
}

/** The scalar settings; `GET` fills in the defaults for what the user never set. */
export interface AccountSettings {
  currency: AccountCurrency;
  language: Locale;
  /** Required for aim.market and skin.place instant-sell lookups; empty when not set. */
  steamTradeUrl: string;
  minPriceDeviation: number;
  soldElsewhereWarningEnabled: boolean;
  /** QUICK-209: remove the other listing automatically while a QTS tab is open, or only warn. */
  soldElsewhereAutoRemove: boolean;
  exitAskRatio: number;
  needRepriceDays: number;
  /** QUICK-224: the Market page's last filters and named views. */
  marketViews: MarketViews;
  /**
   * QUICK-295: "Auto add price coefficient for each platform", one setting for the whole account (formerly a checkbox
   * of the One item sale form and a switch of Multi-select). On: each market's price is the reference price moved
   * through the price coefficients; off: the same price on every market.
   */
  autoAddCoefficient: boolean;
  /**
   * The user's other Steam accounts (SteamID64s). Items sent to them and bought back from them on a marketplace are
   * moved between the user's own accounts — a balance transfer, not a sale or a purchase: trade history keeps the cost
   * the copy was first bought at and books only the marketplace fees as a loss.
   */
  ownSteamIds: readonly string[];
  /**
   * QUICK-296 (owner decision 2026-10-29): an item live on one market is listed by the extension on the markets of
   * `autoListMarkets` it is missing from, at the price mirrored from its live ask (through the coefficients when
   * `autoAddCoefficient` is on, the same price when off). Off by default.
   */
  autoListMissing: boolean;
  /** The markets `autoListMissing` lists on (MARKET_SYNC_FORM_IDS); empty: the account's default listing markets. */
  autoListMarkets: readonly MarketSyncFormId[];
  /**
   * QUICK-296: each live listing's price follows the item's ask on the reference platform — through the coefficients
   * when `autoAddCoefficient` is on, the same price when off — kept by the extension even with the tab closed. Off by
   * default.
   */
  keepPricesInSync: boolean;
}

/** What `GET` answers for a field the user never set (the web's former IndexedDB defaults). */
export const ACCOUNT_SETTINGS_DEFAULTS = {
  currency: 'USD',
  language: 'en',
  steamTradeUrl: '',
  minPriceDeviation: 0.5,
  soldElsewhereWarningEnabled: true,
  soldElsewhereAutoRemove: true,
  exitAskRatio: 0.9,
  needRepriceDays: 30,
  marketViews: { current: null, saved: [] },
  // On: listings priced through the coefficients (as the owner's are) keep their per-market prices, and nothing reads as
  // "prices differ" until an account turns it off.
  autoAddCoefficient: true,
  ownSteamIds: [],
  autoListMissing: false,
  autoListMarkets: [],
  keepPricesInSync: false,
} as const satisfies AccountSettings;

/** `PUT /api/auth/me/settings`: only the fields to change. */
export type AccountSettingsUpdate = Partial<AccountSettings>;

export type SoldElsewhereMarket = 'csfloat.com' | 'cs.money';

export const SOLD_ELSEWHERE_STATUSES = [
  'pending',
  'removed',
  'failed',
  'conflict',
  'not-listed',
  'source-unconfirmed',
  'queue-cancelled',
  'queue-not-queued',
  'queue-listed',
  'queue-unresponsive',
] as const;
export type SoldElsewhereStatus = (typeof SOLD_ELSEWHERE_STATUSES)[number];

/** A sale on one market whose item is still listed (or queued) on the other one. Times are epoch ms. */
export interface SoldElsewhereNotice {
  id: string;
  source: SoldElsewhereMarket;
  steamId: string;
  tradeId: string;
  assetId: string;
  committedAt: number;
  sourceListingId?: string;
  target: SoldElsewhereMarket;
  targetListingId: string;
  /** A separate actionable target from a live listing; retain the original id after Steam re-issues it. */
  queuedListing?: { ruleId: string; itemId: string; createdAt: number };
  itemName: string;
  detectedAt: number;
  status: SoldElsewhereStatus;
  sourceUnconfirmed?: boolean;
  dismissed: boolean;
  seen: boolean;
  toasted: boolean;
  /** QUICK-209: when automatic mode claimed this pair. Set once on the server, so no poll, reload or tab repeats it. */
  autoClaimedAt?: number;
  /** The automatic run: under way in an open page, or cut off because that page closed. Cleared with its outcome. */
  autoRun?: 'running' | 'interrupted';
  /** The current outcome came from the automatic run, not from a click. */
  autoOutcome?: boolean;
  /** The source market later showed this sale cancelled or failed. */
  fellThrough?: boolean;
  /** Folded into a double-sale card for the same asset (not the user's dismissal): nothing may act on it any more. */
  superseded?: boolean;
  /** The automatic removal's reprice/one-shot cleanup also cancelled this item's waiting queued listing there. */
  queuedListingCancelled?: boolean;
}

/** What a click, a poll or the automatic run may change on one notice. */
export type SoldElsewhereNoticePatch = Partial<
  Pick<
    SoldElsewhereNotice,
    'status' | 'dismissed' | 'seen' | 'autoRun' | 'autoOutcome' | 'fellThrough' | 'queuedListingCancelled'
  >
>;

/**
 * `POST …/sold-elsewhere/update`: one notice's patch on the wire. JSON has no `undefined`, so a patch that clears the
 * automatic run sends `autoRun: null`; nothing else may set it (claims and settles have their own routes).
 */
export interface SoldElsewhereNoticeUpdate {
  id: string;
  steamId: string;
  patch: Omit<SoldElsewhereNoticePatch, 'autoRun'> & { autoRun?: null };
}

/** When a live ask was first seen at its current price (Need reprice). `at` is epoch ms. */
export interface AskSighting {
  price: number;
  at: number;
}

/** A live ask: `<source platform>:<asset id>`, e.g. `csfloat.com:123`, and its listed price. */
export interface LiveAsk {
  key: string;
  price: number;
}


export const ASK_SIGHTING_PLATFORMS = ['csfloat.com', 'cs.money'] as const;

/** Two ask prices closer than half a cent are the same ask: its sighting keeps its date. A literal, so a typed copy fails on drift. */
export const ASK_SIGHTING_SAME_PRICE = 0.005;

/** A sold-elsewhere notice is kept 7 days after its detection and after the sale (QUICK-118). A literal, as above. */
export const SOLD_ELSEWHERE_TTL_MS = 604_800_000;

/** `GET /api/auth/me/settings` and the answer of `PUT` / `POST …/import`. */
export interface AccountSettingsState extends AccountSettings {
  soldElsewhereNotices: SoldElsewhereNotice[];
  /** Keyed `<platform>:<asset id>`. */
  askSightings: Record<string, AskSighting>;
  /** Epoch ms of the one-time upload of a browser's IndexedDB settings; null until one happened. */
  localImportedAt: number | null;
  /** Epoch ms of the last time the notification bell was opened; null until then. Never moves back. */
  notificationsLastSeenAt: number | null;
}

/** `POST /api/auth/me/settings/notifications-seen`: the bell was opened; a time before the stored one changes nothing. */
export interface NotificationsSeenUpdate {
  at: number;
}

/** `POST /api/auth/me/settings/import`: one browser's IndexedDB settings, uploaded once per account. */
export interface AccountSettingsImport extends AccountSettingsUpdate {
  soldElsewhereNotices?: SoldElsewhereNotice[];
  askSightings?: Array<AskSighting & { key: string }>;
}

/** The answer of every sold-elsewhere operation: the notices after it. */
export interface SoldElsewhereNoticesResult {
  notices: SoldElsewhereNotice[];
}

/** `POST …/sold-elsewhere/claim-auto`: the pair this call claimed for the automatic run, if any. */
export interface SoldElsewhereClaimResult extends SoldElsewhereNoticesResult {
  claimed: SoldElsewhereNotice | null;
}

/** `POST …/sold-elsewhere/take-toasts`: the cards this call claimed for the toast stack, one per sale. */
export interface SoldElsewhereToastsResult extends SoldElsewhereNoticesResult {
  toasts: SoldElsewhereNotice[];
}

/** `POST …/ask-sightings`: one inventory sync of `readPlatforms`. */
export interface AskSightingsUpdate {
  live: LiveAsk[];
  readPlatforms: Array<(typeof ASK_SIGHTING_PLATFORMS)[number]>;
}

export interface AskSightingsResult {
  askSightings: Record<string, AskSighting>;
}
