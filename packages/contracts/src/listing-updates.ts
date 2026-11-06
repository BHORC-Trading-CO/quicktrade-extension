/**
 * The user's own listing changes that no inventory fetch has read yet (QUICK-191), kept on the account (QUICK-210) at
 * `/api/inventory/listing-updates`. The inventory snapshot is account-wide and reused for 15 minutes, so a change made
 * in one browser must reach another one too: every browser applies the pending changes over what it shows and does
 * not trust the cache while any is pending. The server imports this module as types only and repeats the limits.
 */

/** A per-(item, platform) listing change after a sale operation. */
export interface ListingUpdate {
  itemId: string;
  /** Bridge platform id, e.g. 'cs.money' / 'csfloat.com' — matches the inventory entry's platform. */
  platform: string;
  /** Listed after a successful list/edit; unlisted after a successful remove. */
  listed: boolean;
  /** New listing price (list/edit only). Undefined leaves the current price untouched. */
  price?: number;
  /** CSFloat listing id parsed from a create response (list only). */
  listingId?: string;
}

/** One sale operation's updates and when it finished (epoch ms). */
export interface ListingUpdateRecord {
  at: number;
  updates: ListingUpdate[];
}

/** What the server keeps per account; literals, so the server's typed copy fails the type check on drift. */
export const LISTING_UPDATES_LIMITS = {
  /** Operations kept at most (the oldest go first): a full fetch normally empties the list long before. */
  maxRecords: 100,
  /** Updates of one operation (one request). */
  maxUpdatesPerRecord: 500,
  /** Updates of every kept operation together (the oldest operations go first). */
  maxUpdates: 5000,
  /** A change no fetch could read (its marketplace kept failing) stops counting after a day; also the TTL. */
  maxAgeMs: 86_400_000,
  itemIdMaxLength: 128,
  platformMaxLength: 64,
  listingIdMaxLength: 128,
  maxPrice: 100_000_000,
  /** Platforms one fetch may confirm. */
  maxPlatforms: 32,
} as const;

/** `POST /api/inventory/listing-updates`: one operation's updates; the server stamps the time. */
export interface ListingUpdatesAppend {
  updates: ListingUpdate[];
}

/**
 * `POST …/listing-updates/forget`: a full fetch that started at `fetchedFrom` returned `platforms` (with their
 * listings). Times are the browser's clock; `sentAt` (when the request left) lets the server convert `fetchedFrom` to
 * its own.
 */
export interface ListingUpdatesForget {
  fetchedFrom: number;
  sentAt: number;
  platforms: string[];
}

/** `POST …/listing-updates/import`: this browser's former localStorage records, uploaded once; times as `forget`. */
export interface ListingUpdatesImport {
  records: ListingUpdateRecord[];
  sentAt: number;
}

/** The answer of every route: the pending updates, oldest first (applied in order, a later one wins). */
export interface ListingUpdatesState {
  updates: ListingUpdate[];
}
