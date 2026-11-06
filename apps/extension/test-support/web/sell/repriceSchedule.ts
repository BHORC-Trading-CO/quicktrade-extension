import type {
  Platform,
  RepriceBatch,
  RepriceItemErrors,
  RepricePlatformError,
  RepricePriceStep,
  RepriceTemplate,
  ScheduledRule,
} from '@qts/contracts';
import { BATCH_ITEMS_TOKEN, isLegacyRepriceExtension, isValidPriceSchedule, MAX_PRICE_SCHEDULE_STEPS } from '@qts/contracts';

import { CSMONEY_EMPTY_RESULT_CODE } from '../platformIssue';
import { csMoneyClient } from '../platforms/cs-money';

/** Token in `bodyTemplate` the SW replaces with the computed numeric price. */
const PRICE_TOKEN = '__PRICE__';

/** cs.money answers HTTP 200 `{ error: N }` on failures; `error: 2` is its "empty result", not a failure. */
const CSMONEY_PLATFORM_ERROR: RepricePlatformError = { paths: [['error']], ignoredValues: [CSMONEY_EMPTY_RESULT_CODE] };

const CSMONEY_ITEMS_PREFIX = '{"items":[';
const CSMONEY_ITEMS_SUFFIX = ']}';

/**
 * How a cs.money `sell-orders` write joins other scheduled writes in one request (QUICK-289, extension 1.10.0+): its
 * one item inside the shared `{"items":[…]}`. Undefined for a body of another shape (it is then written alone).
 */
export function csMoneySellOrdersBatch(body: string): RepriceBatch | undefined {
  if (!body.startsWith(CSMONEY_ITEMS_PREFIX) || !body.endsWith(CSMONEY_ITEMS_SUFFIX)) return undefined;
  const item = body.slice(CSMONEY_ITEMS_PREFIX.length, body.length - CSMONEY_ITEMS_SUFFIX.length);
  return item
    ? { key: 'csmoney.sell-orders', wrapper: `${CSMONEY_ITEMS_PREFIX}${BATCH_ITEMS_TOKEN}${CSMONEY_ITEMS_SUFFIX}`, item }
    : undefined;
}

/** The per-item rejections a 2xx `sell-orders` body can carry: the vocabulary of `csMoneyItemErrors`. */
function csMoneyItemErrorSpec(assetId: string): RepriceItemErrors {
  return {
    rejectedPaths: [['errors'], ['failed']],
    resultPaths: [['items']],
    rejectedWhen: [
      { path: ['success'], values: [false] },
      { path: ['ok'], values: [false] },
      { path: ['status'], values: ['rejected', 'failed'] },
    ],
    idPaths: [['id'], ['item_id'], ['asset_id']],
    id: assetId,
  };
}


const CSFLOAT_INACTIVE_STATES = ['sold', 'delisted', 'refunded'];

/**
 * Build the edit-price request TEMPLATE a deferred ramp rule fires. The price is left as the
 * `__PRICE__` token (unquoted, since it is numeric) for the SW to substitute each day. cs.money
 * edits by asset id in dollars; csfloat edits by listing id in cents (needs the listing id).
 * Returns null when unsupported or identity is missing (CSFloat needs a listing id).
 */
export function buildRepriceTemplate(platform: Platform, assetId: string, listingId: string | undefined): RepriceTemplate | null {
  if (platform === 'csfloat.com') {
    if (!listingId || !assetId) return null;
    const url = `https://csfloat.com/api/v1/listings/${encodeURIComponent(listingId)}`;
    return {
      url,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      bodyTemplate: `{"price":${PRICE_TOKEN}}`,
      priceInCents: true,
      checkTemplate: {
        request: { url, method: 'GET' },
        goneStatuses: [404, 410],
        matcher: {
          collectionPaths: [[]],
          single: true,
          idPaths: [['id']],
          id: listingId,
          requiredMatches: [{ paths: [['item', 'asset_id']], value: assetId }],
          // https://docs.csfloat.com/#get-a-specific-listing also returns inactive listings.
          state: { paths: [['state']], listedValues: ['listed'], notListedValues: CSFLOAT_INACTIVE_STATES },
          pageSize: 1,
        },
      },
    };
  }
  if (platform === 'cs.money') {
    const pageSize = csMoneyClient.inventoryPageSize;
    if (!Number.isSafeInteger(Number(assetId)) || Number(assetId) <= 0 || !pageSize) return null;
    const bodyTemplate = `{"items":[{"id":${Number(assetId)},"price":${PRICE_TOKEN}}]}`;
    const batch = csMoneySellOrdersBatch(bodyTemplate);
    return {
      url: 'https://cs.money/1.0/market/sell-orders',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      bodyTemplate,
      ...(batch ? { batch } : {}),
      priceInCents: false,
      // A 2xx `{ error: N }` on the write did not apply: the scheduler retries it, never records success.
      platformError: CSMONEY_PLATFORM_ERROR,
      // A 2xx that rejects this item did not apply either: a counted failure, like on the publish path.
      itemErrors: csMoneyItemErrorSpec(String(Number(assetId))),
      checkTemplate: {
        request: { ...csMoneyClient.getInventory('', 0), method: 'GET' },
        goneStatuses: [],
        matcher: {
          collectionPaths: [['items'], ['data'], []],
          idPaths: [['asset', 'id'], ['assetId'], ['id']],
          id: assetId,
          state: { paths: [['onSale'], ['is_listed']], listedValues: [true], notListedValues: [false] },
          pageSize,
        },
        pagination: { offsetParam: 'offset', maxPages: 30 },
        // HTTP 200 `{ error: N }` is a temporary cs.money failure; `error: 2` (empty result) stays a fail-closed unknown.
        platformError: CSMONEY_PLATFORM_ERROR,
      },
    };
  }
  return null;
}

/** Old schedulers ignore activationRequested and retain active:false. Only registerRule in a safety-aware
 * extension activates this request (and activates such stored rules once it is installed). */
export function requestSafeRepriceActivation(rule: ScheduledRule): ScheduledRule {
  return { ...rule, active: false, activationRequested: true, pausedReason: 'extension_update_required', pausedAt: rule.createdAt };
}

const CSFLOAT_LISTING_URL = /^https:\/\/csfloat\.com\/api\/v1\/listings\/([^/?#]+)$/;

function csfloatListingIdFromUrl(url: string): string | undefined {
  const match = CSFLOAT_LISTING_URL.exec(url);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * The rule with a read-only check: a legacy rule stored without one gets it rebuilt from the rule
 * itself (the CSFloat listing id is in the edit URL). Null when the identity cannot be rebuilt.
 */
function withRebuiltCheck(rule: ScheduledRule): ScheduledRule | null {
  // One-shots and price followers (QUICK-296) are never resumed as ramps.
  if (rule.kind === 'list' || rule.kind === 'sync') return null;
  if (rule.template.checkTemplate) return rule;
  const { platform } = rule;
  if (platform !== 'csfloat.com' && platform !== 'cs.money') return null;
  const listingId = platform === 'csfloat.com' ? csfloatListingIdFromUrl(rule.template.url) : undefined;
  const template = buildRepriceTemplate(platform, String(rule.itemId), listingId);
  return template ? { ...rule, template } : null;
}

/** The scheduler's day: `computeRepriceStep` counts whole days from `startAt`, so the schedule's steps fall on the same. */
const DAY_MS = 86_400_000;

/**
 * What a rule's price schedule is built from: the ramp and the prices planned for it (`PlatformPriceCoefficient.dayPrices`;
 * this module stays free of web aliases, the extension's tests import it).
 */
export interface PriceScheduleInput extends Pick<ScheduledRule, 'firstPrice' | 'secondPrice' | 'startAt' | 'days'> {
  dayPrices?: readonly number[];
}

/**
 * The rule's explicit schedule (QUICK-289 PR 2): day N's planned price from `startAt + N days`, so the extension fires
 * exactly the prices the plan kept on the coefficient instead of recomputing the ramp. Undefined, and the rule ramps
 * linearly as before, without planned prices or when they no longer belong to this ramp (a price or the days edited
 * since the plan).
 */
export function priceScheduleFor({
  firstPrice,
  secondPrice,
  dayPrices,
  startAt,
  days,
}: PriceScheduleInput): RepricePriceStep[] | undefined {
  if (!dayPrices || days < 1 || dayPrices.length !== days + 1 || dayPrices.length > MAX_PRICE_SCHEDULE_STEPS) return undefined;
  const schedule = dayPrices.map((price, day) => ({ at: startAt + day * DAY_MS, price }));
  return isValidPriceSchedule({ schedule, firstPrice, secondPrice }) ? schedule : undefined;
}

/** Re-registration request for a paused rule, keeping its schedule (startAt/lastAppliedDay). */
export function resumeRepriceRule(rule: ScheduledRule): ScheduledRule | null {
  const checked = withRebuiltCheck(rule);
  return checked ? requestSafeRepriceActivation(checked) : null;
}

/**
 * Registration that gives a rule created by an older web its read-only check, keeping its schedule:
 * - paused as `missing_check` (only a safety-aware extension does that): the safe activation request;
 * - still active without a check, before it is ever due: the legacy active shape with the check
 *   attached on an extension older than 1.0.56 (it keeps firing; the check applies after the update),
 *   the safe activation request otherwise. With an unknown version nothing is sent: a dormant request
 *   would switch off a working rule on an older extension.
 * Null when nothing needs to (or can) be sent.
 */
export function legacyRuleRegistration(rule: ScheduledRule, extensionVersion: string | null): ScheduledRule | null {
  if (rule.retiredReason || rule.template.checkTemplate) return null;
  if (rule.pausedReason === 'missing_check') return resumeRepriceRule(rule);
  if (!rule.active || rule.pausedReason || !extensionVersion) return null;
  const checked = withRebuiltCheck(rule);
  if (!checked) return null;
  return isLegacyRepriceExtension(extensionVersion) ? checked : requestSafeRepriceActivation(checked);
}
