import { isRecord, parseDate } from './wire';

export type AccessReason = 'subscription' | 'trial' | 'trial_expired' | 'steam_not_linked' | 'unavailable';

/** trial: 7 days after the Steam link; paid: an active subscription; free: neither (QUICK-158). */
export type AccessTier = 'trial' | 'paid' | 'free';

/**
 * What the account may use (QUICK-158). Removing a listing is never gated: it keeps the user's money safe.
 * Client-side features are gated in the web only; the server enforces the ones it serves.
 */
export interface AccessFeatures {
  /** List, change the price of and auto-reprice items on DEFAULT_LISTING_MARKETS. */
  listingDefaultMarkets: boolean;
  /** The same on every other P2P market (white.market, ShadowPay, BUFF Market, Buff163). */
  listingAllMarkets: boolean;
  /** The Instant sell page and the sell-mode tab; without it no instant-sell site is asked. */
  instantSell: boolean;
  /** Competitor search; the server answers POST /api/pattern/signal only with it. */
  competitorSearch: boolean;
  /** Sale history (QUICK-162/163). */
  saleHistory: boolean;
  /** "Auto accept bargains" in the sale form. */
  autoAcceptBargains: boolean;
  /** Server price data: /api/market predict-batch, validate-price, price-history and price-stats. */
  marketPrices: boolean;
  /** The Market page (QUICK-216): search CSFloat and cs.money, the item panel and buying by hand. */
  marketBuy: boolean;
  /** QTS buy orders (QUICK-216): the account's rules that buy from the live feed automatically. */
  marketBuyOrders: boolean;
}

export type AccessFeature = keyof AccessFeatures;

/** The markets every tier may list on (`Platform` ids): CSFloat and the cs.money market. */
export const DEFAULT_LISTING_MARKETS = ['csfloat.com', 'cs.money'] as const;

export interface Access<TDate = string> {
  /** Full access (trial or subscription). Kept for clients that predate `features`. */
  sell: boolean;
  /** unavailable means the trial ledger could not be read. */
  reason: AccessReason;
  /** null only when reason is unavailable. */
  tier: AccessTier | null;
  /** All false when reason is unavailable. */
  features: AccessFeatures;
  /** When full access ends (trial end or paid period end); null when open-ended or already limited. */
  accessEndsAt: TDate | null;
}

export type TrialStatus = 'not_started' | 'active' | 'expired';

/** ISO strings on the wire; the server uses Trial<Date> internally. */
export type Trial<TDate = string> =
  | { status: 'not_started'; startedAt: null; endsAt: null; daysLeft: null }
  | { status: Exclude<TrialStatus, 'not_started'>; startedAt: TDate; endsAt: TDate; daysLeft: number };

/** What `GET /api/auth/me` tells a banned user (QUICK-165); outside user Support, other routes answer 403 `account_banned`. */
export interface AccountBanNotice<TDate = string> {
  at: TDate;
  reason: string;
}

/** The /auth/me fields consumed by the web; other profile fields may also be returned. */
export interface AuthMeResponse<TDate = string> {
  /** Support rollout (QUICK-243), also for banned accounts; older server responses parse as false. */
  support: boolean;
  /** Internal user id (Mongo ObjectId hex): the analytics distinct id (QUICK-116). */
  id?: string;
  /** When the user first reached product value (QUICK-116); null before, absent from older servers. */
  firstValueAt?: TDate | null;
  clerkId: string;
  steamId?: string;
  steamLinkedAt?: TDate;
  steamPersonaName?: string;
  steamAvatarUrl?: string;
  access: Access<TDate>;
  /** null only when access.reason is unavailable. */
  trial: Trial<TDate> | null;
  /** The account is banned (QUICK-165): the web shows the blocked screen instead of the app. Absent from older servers. */
  banned?: AccountBanNotice<TDate> | null;
}

/** POST /auth/me/first-value (QUICK-116): `first` is true only for the call that recorded the timestamp. */
export interface FirstValueResponse<TDate = string> {
  first: boolean;
  firstValueAt: TDate;
}

// Every key, checked at compile time: a feature added to AccessFeatures must be parsed here too.
const FEATURE_KEYS = Object.keys({
  listingDefaultMarkets: true,
  listingAllMarkets: true,
  instantSell: true,
  competitorSearch: true,
  saleHistory: true,
  autoAcceptBargains: true,
  marketPrices: true,
  marketBuy: true,
  marketBuyOrders: true,
} satisfies Record<AccessFeature, true>) as AccessFeature[];

function parseFeatures(value: unknown): AccessFeatures | null {
  if (!isRecord(value)) return null;
  const features: Partial<AccessFeatures> = {};
  for (const key of FEATURE_KEYS) {
    const enabled = value[key];
    if (typeof enabled !== 'boolean') return null;
    features[key] = enabled;
  }
  return features as AccessFeatures;
}

/** The tier each reason implies; undefined for an unknown reason. */
function tierOf(reason: unknown): AccessTier | null | undefined {
  switch (reason) {
    case 'subscription':
      return 'paid';
    case 'trial':
      return 'trial';
    case 'trial_expired':
    case 'steam_not_linked':
      return 'free';
    case 'unavailable':
      return null;
    default:
      return undefined;
  }
}

/**
 * `access` of `GET /api/auth/me` and of the admin user detail, with dates (QUICK-158); null for anything malformed or
 * inconsistent (a reason that does not imply its tier, a trial without an end). Shared by the web and the admin app
 * (QUICK-250).
 */
export function parseAccess(value: unknown): Access<Date> | null {
  if (!isRecord(value) || typeof value['sell'] !== 'boolean') return null;
  const reason = value['reason'];
  const tier = tierOf(reason);
  if (tier === undefined || value['tier'] !== tier) return null;
  const features = parseFeatures(value['features']);
  const accessEndsAt = value['accessEndsAt'] === null ? null : parseDate(value['accessEndsAt']);
  if (!features || (accessEndsAt === null && value['accessEndsAt'] !== null)) return null;
  // Full access runs out at a known time on the trial; the free tier has nothing left to end.
  if ((tier === 'trial' && !accessEndsAt) || (tier !== 'trial' && tier !== 'paid' && accessEndsAt)) return null;
  return { sell: value['sell'], reason: reason as AccessReason, tier, features, accessEndsAt };
}
