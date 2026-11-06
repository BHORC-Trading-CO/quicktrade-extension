import {
  ASSET_ID_TOKEN,
  type ListingIdentity,
  type ListingPrecondition,
  listingRuleId,
  type ListingStallCheck,
  type Platform,
  type ScheduledListingRule,
} from '@qts/contracts';

import { csMoneyClient } from '../platforms/cs-money';
import { CSFLOAT_STALL_PAGE_SIZE, csfloatClient, csfloatStallPageRequest } from '../platforms/csfloat';
import { buildRepriceTemplate, csMoneySellOrdersBatch } from './repriceSchedule';

/** Marketplaces a one-shot listing can target (bridge platform ids). */
export function isScheduledListingPlatform(platform: string): boolean {
  return platform === 'cs.money' || platform === 'csfloat.com';
}

/** Every rule the extension may hold for an (item, platform) pair: its reprice rule, then its one-shot listing. */
export function pairRuleIds(itemId: string, platform: string): string[] {
  const reprice = `${itemId}:${platform}`;
  return isScheduledListingPlatform(platform) ? [reprice, listingRuleId(itemId, platform)] : [reprice];
}

/** One copy as the marketplace inventories report it: market hash name, float (6 digits), paint seed. */
export type ListingCopy = Pick<ListingIdentity, 'name' | 'float' | 'seed'>;

/** Where each inventory row carries the copy's identity: the fields normalizeInventory reads. */
const IDENTITY_PATHS: Record<'cs.money' | 'csfloat.com', Pick<ListingIdentity, 'namePaths' | 'floatPaths' | 'seedPaths'>> = {
  'cs.money': {
    namePaths: [['asset', 'names', 'full'], ['fullName'], ['name']],
    floatPaths: [['asset', 'float'], ['float']],
    seedPaths: [['asset', 'paintseed'], ['pattern']],
  },
  'csfloat.com': {
    namePaths: [['market_hash_name'], ['item_name']],
    floatPaths: [['float_value'], ['float']],
    seedPaths: [['paint_seed'], ['pattern']],
  },
};

/** A numeric asset id that the client requests carry verbatim, swapped for ASSET_ID_TOKEN afterwards. */
const ASSET_ID_SENTINEL = String(Number.MAX_SAFE_INTEGER);

/** The create body with the asset id left as ASSET_ID_TOKEN, or null unless it appears exactly once. */
function bodyWithAssetToken(body: string): string | null {
  const parts = body.split(ASSET_ID_SENTINEL);
  return parts.length === 2 ? parts.join(ASSET_ID_TOKEN) : null;
}

/**
 * Same create requests as immediate listing; prices arrive in USD and are frozen in native units. With a
 * `copy` (an item trade-protected when scheduled, whose asset id Steam may re-issue), the run finds the item
 * by that identity and names its current asset id in the create.
 */
export function buildListingTemplate(
  platform: Platform,
  assetId: string,
  priceUsd: number,
  steamId: string,
  copy?: ListingCopy,
): ScheduledListingRule['template'] | null {
  if (!assetId || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const requestId = copy ? ASSET_ID_SENTINEL : assetId;
  if (platform === 'cs.money') {
    const reprice = buildRepriceTemplate(platform, assetId, undefined);
    const request = csMoneyClient.setPrice?.(requestId, priceUsd);
    const body = request?.body && copy ? bodyWithAssetToken(request.body) : request?.body;
    if (!reprice?.checkTemplate || !body) return null;
    const { batch: _repriceBatch, ...rest } = reprice;
    const batch = csMoneySellOrdersBatch(body);
    return {
      ...rest,
      checkTemplate: reprice.checkTemplate,
      bodyTemplate: body,
      ...(batch ? { batch } : {}),
      ...(copy ? { identity: { ...copy, ...IDENTITY_PATHS[platform] } } : {}),
    };
  }
  if (platform !== 'csfloat.com' || !steamId || Math.round(priceUsd * 100) <= 0) return null;
  const request = csfloatClient.setPrice?.(requestId, priceUsd);
  const body = request?.body && copy ? bodyWithAssetToken(request.body) : request?.body;
  if (!request || !body) return null;
  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    bodyTemplate: body,
    ...(copy ? { identity: { ...copy, ...IDENTITY_PATHS[platform] } } : {}),
    // The created listing, as the immediate path reads it: its id.
    successIdPaths: [['id']],
    priceInCents: true,
    checkTemplate: {
      request: { ...csfloatClient.getInventory(steamId), method: 'GET' },
      goneStatuses: [],
      matcher: {
        collectionPaths: [[]],
        idPaths: [['asset_id']],
        id: assetId,
        // Presence only: CSFloat's `tradable` is not a lock flag (see Item.tradable), so it is not matched.
        // Whether the item is already listed is decided by the complete stall read below.
        // This client returns the whole inventory, with no pagination.
        pageSize: Number.MAX_SAFE_INTEGER,
      },
    },
    stallCheck: csfloatStallCheck(assetId, steamId),
  };
}

/**
 * The complete read of the CSFloat stall (`GET /users/{steamId}/stall`, cursor-paged) that finds the lot of `assetId`:
 * the item's row is `item.asset_id`, a page is `data`, the cursor and total come with it.
 */
function csfloatStallCheck(assetId: string, steamId: string): ListingStallCheck {
  return {
    request: { ...csfloatStallPageRequest(steamId), method: 'GET' },
    goneStatuses: [],
    matcher: {
      collectionPaths: [['data'], ['items'], []],
      idPaths: [['item', 'asset_id']],
      id: assetId,
      pageSize: CSFLOAT_STALL_PAGE_SIZE,
    },
    cursor: { param: 'cursor', path: ['cursor'], totalPath: ['total_count'], rowIdPaths: [['id']], maxPages: 100 },
  };
}


export function csfloatLiveLotPrecondition(assetId: string, steamId: string): ListingPrecondition | null {
  if (!assetId || !steamId) return null;
  return { reason: 'cross_list_hold', platform: 'csfloat.com', liveCheck: csfloatStallCheck(assetId, steamId) };
}
