/**
 * The account's preferences (QUICK-194): what the first-login wizard asks and the hints toggle. Stored on the user
 * by the server (`GET/PUT /api/auth/me/preferences`), so they follow the account to another browser; the web keeps
 * only a cache of the last answer.
 */

/** The marketplaces prices can be normalized to (Platforms → Reference platform): the web's coefficient platforms. */
export const REFERENCE_PLATFORM_IDS = [
  'steam',
  'csfloat',
  'cs-money',
  'cs-money-market',
  'avan-market',
  'ntskins',
  'skinport',
  'dmarket',
  'white-market',
  'skin-place',
  'skinbaron',
  'shadowpay',
  'waxpeer',
  'buff-market',
  'buff-163',
  'haloskins',
] as const;

export type ReferencePlatformId = (typeof REFERENCE_PLATFORM_IDS)[number];

/** The P2P markets an item can be listed on, as sale-form platform ids, in the web's sale-strategy order. */
export const LISTING_MARKET_IDS = [
  'cs-money-market',
  'csfloat',
  'white-market',
  'shadowpay',
  'buff-market',
  'buff-163',
] as const;

export type ListingMarketId = (typeof LISTING_MARKET_IDS)[number];

/**
 * The pages with a guided tour (QUICK-258): a few highlighted steps that say what the page's parts mean. A tour starts
 * by itself on the first visit only for a user who chose it in the first-login wizard (`autoTours`); anyone can start
 * it from the header.
 */
export const TOUR_IDS = ['sellMode', 'platforms'] as const;

export type TourId = (typeof TOUR_IDS)[number];

/**
 * The user's own coefficients, which replace the calculated ones (Platforms page): by the reference platform they were
 * set against, then by platform. A coefficient is reference price ÷ platform price, so it only means something against
 * its reference; another reference keeps its own set. With CSFloat as the reference, cs.money Market's value is the
 * same number as quick-buy-skin's cs.money coefficient (cs.money ask = CSFloat ask ÷ coefficient).
 */
export type CoefficientOverrides = Partial<Record<ReferencePlatformId, Partial<Record<ReferencePlatformId, number>>>>;

/** The values a coefficient of one's own may take (inclusive). */
export const COEFFICIENT_OVERRIDE_MIN = 0.01;
export const COEFFICIENT_OVERRIDE_MAX = 100;

/** `GET /api/auth/me/preferences`, and the answer of every `PUT`: defaults filled in, ISO strings on the wire. */
export interface UserPreferences<TDate = string> {
  /** The marketplace prices are normalized to; null until the user picks one (the browser keeps its own). */
  referencePlatform: ReferencePlatformId | null;
  /**
   * The marketplace trade-history profit is also shown in, each leg converted with the coefficient snapshot of its
   * day; null: nominal profit only.
   */
  profitReferencePlatform: ReferencePlatformId | null;
  /** The markets the sale form starts with; null until the user picks (an empty list is a choice). */
  listingMarkets: ListingMarketId[] | null;
  /** Hints on the item panel's and the sale form's fields; true until switched off. */
  hints: boolean;
  /** The user's own coefficients; empty until one is set. */
  coefficientOverrides: CoefficientOverrides;
  /** When the first-login wizard was finished or skipped; null: it opens on the next visit. */
  onboardingDoneAt: TDate | null;
  /** Page tours start by themselves on a page's first visit (the wizard's "I'm new" choice); false until chosen. */
  autoTours: boolean;
  /** The tours finished or closed, so they do not start by themselves again; empty until one is. */
  toursDone: TourId[];
}

/** `PUT /api/auth/me/preferences`: only the fields to change. `onboardingDone` records the wizard as done now. */
export interface UserPreferencesUpdate {
  referencePlatform?: ReferencePlatformId;
  /** null switches the profit in reference prices off. */
  profitReferencePlatform?: ReferencePlatformId | null;
  listingMarkets?: ListingMarketId[];
  hints?: boolean;
  /** Replaces the whole set; a platform left out goes back to the calculated coefficient. */
  coefficientOverrides?: CoefficientOverrides;
  onboardingDone?: true;
  autoTours?: boolean;
  /** Replaces the whole list; an empty list lets every tour start by itself again. */
  toursDone?: TourId[];
}
