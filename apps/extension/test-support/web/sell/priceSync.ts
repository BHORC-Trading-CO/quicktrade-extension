import {
  type Platform,
  type ScheduledSyncRule,
  SYNC_INTERVAL_LIMITS,
  type SyncFactors,
  type SyncReference,
  syncRuleId,
} from '@qts/contracts';

import { buildRepriceTemplate } from './repriceSchedule';

/**
 * Price followers (QUICK-296): the requests a `sync:` rule sends, built here like every scheduled template. This module
 * stays free of web aliases: the extension's scheduler tests build their rules with it.
 */

/** Where a CSFloat listing (`GET /api/v1/listings/{id}`) carries its price: integer cents, as normalizeInventory reads it. */
const CSFLOAT_LISTING_PRICE = { paths: [['price']], inCents: true };

/**
 * The CSFloat listing a follower reads as its reference: the same single-listing read (with its listed state and the
 * Steam asset id) the listing's own reprice rule checks with. Null without a listing id.
 */
export function csfloatSyncReference(assetId: string, listingId: string | undefined): SyncReference | null {
  const check = buildRepriceTemplate('csfloat.com', assetId, listingId)?.checkTemplate;
  if (!check) return null;
  return { platform: 'csfloat.com', check, pricePaths: CSFLOAT_LISTING_PRICE.paths, priceInCents: CSFLOAT_LISTING_PRICE.inCents };
}

export interface SyncRuleInput {
  itemId: string;
  marketHashName: string;
  /** Bridge platform id of the follower listing. */
  platform: Platform;
  /** The follower's CSFloat listing id (a CSFloat follower only). */
  listingId?: string;
  /** The follower's live price as the web sees it, USD. */
  syncedPrice: number;
  reference: SyncReference;
  factors: SyncFactors;
  now: number;
  everyMs?: number;
}

/** The follower rule for one live listing, or null when its listing cannot be addressed or nothing would be followed. */
export function buildSyncRule(input: SyncRuleInput): ScheduledSyncRule | null {
  const { itemId, platform, syncedPrice, reference, now } = input;
  if (platform === reference.platform || !Number.isFinite(syncedPrice) || syncedPrice <= 0) return null;
  const template = buildRepriceTemplate(platform, itemId, input.listingId);
  if (!template?.checkTemplate) return null;
  return {
    kind: 'sync',
    ruleId: syncRuleId(itemId, platform),
    platform,
    itemId,
    marketHashName: input.marketHashName,
    firstPrice: syncedPrice,
    secondPrice: syncedPrice,
    startAt: now,
    days: 0,
    lastAppliedDay: 0,
    template,
    active: false,
    syncActivationRequested: true,
    createdAt: now,
    origin: 'auto_sync',
    reference,
    factors: input.factors,
    factorsAt: now,
    everyMs: input.everyMs ?? SYNC_INTERVAL_LIMITS.defaultMs,
    syncedPrice,
    ...(platform === 'csfloat.com' ? { ownPrice: CSFLOAT_LISTING_PRICE } : {}),
    nextSyncAt: now,
  };
}
