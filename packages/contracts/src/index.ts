import type { ActiveBrowserPush, ActiveBrowserView } from './active-browser';
import type {
  BuyOrderActivity,
  BuyOrdersEngineAnswer,
  BuyOrdersEngineRequest,
  BuyOrdersEngineView,
  BuyOrdersLeasePush,
} from './buy-order-engine';
import type { BuyOrdersSetResult, BuyOrdersSnapshot } from './buy-orders';
import type { ExtensionJournalEntry } from './diagnostics';
import { BUNDLED_OPERATION_SINCE } from './extension-operations';
import type { MarketBuyRequest, MarketBuyResult } from './market-buy';
import type {
  MarketFeedBufferRequest,
  MarketFeedBufferResponse,
  MarketFeedConfig,
  MarketFeedPlatform,
  MarketFeedStateResponse,
  MarketFeedUpdate,
} from './market-feed';
import type { SignedOperationTable } from './operation-table-document';
import type { OperationRequest, PlatformOperation } from './operation-types';
import type {
  ConnectablePlatform,
  ExtensionCapability,
  PlatformConnection,
  PlatformConnectionStatus,
} from './platform-connections';
import { PLATFORM_CONNECTION_TABLE } from './platform-connections';
import { PLATFORM_OPERATION_TABLE } from './platform-operations';
import { type PlatformSchedulerPolicy, type RepriceBatch, composeBatchBody } from './scheduler-policy';

/**
 * Shared contract for the page ↔ extension bridge.
 *
 * Both the WXT extension (content script + popup) and the Next.js web app
 * import from the @qts/contracts workspace. It must stay free of `browser.*` runtime references
 * so the web side can resolve it without `@types/chrome`.
 */

export {
  BATCH_ITEMS_TOKEN,
  batchGroupKey,
  classifySchedulerError,
  composeBatchBody,
  resolveErrorMap,
  resolveSchedulerPolicy,
  SCHEDULER_ERROR_MAP_LIMITS,
  SCHEDULER_ERROR_OUTCOMES,
  SCHEDULER_POLICY_LIMITS,
  schedulerBackoffMs,
  schedulerErrorCodes,
} from './scheduler-policy';
export type {
  PlatformSchedulerPolicy,
  RepriceBatch,
  ResolvedSchedulerPolicy,
  SchedulerErrorMap,
  SchedulerErrorOutcome,
  SchedulerErrorRule,
  SchedulerErrorVerdict,
} from './scheduler-policy';
export {
  PAGE_DNR_MIN_ID,
  PAGE_DNR_MAX_ID,
  PAGE_DNR_MAX_RULES,
  PAGE_DNR_MAX_DOMAINS,
  validatePageDnrRules,
} from './dnr-policy';
export type { DnrRejection, DnrRejectionReason, DnrRulesResult, PageDnrRule } from './dnr-policy';
export type {
  AdminAlreadyHandledResponse,
  AdminHandleTransferRequest,
  AdminUnmatchedListResponse,
  AdminUnmatchedStatus,
  AdminUnmatchedTransfer,
} from './admin-billing';

export type {
  OperationAuth,
  OperationBodyKind,
  OperationGraphql,
  OperationMatch,
  OperationMethod,
  OperationPurpose,
  OperationRefusal,
  OperationRefusalReason,
  OperationRequest,
  OperationTable,
  PlatformOperation,
} from './operation-types';
export {
  findPlatformOperation,
  followsOperationRedirects,
  graphqlOperations,
  isAllowedOperationRedirect,
  isOperationPathPattern,
  matchOperationPath,
  matchPlatformOperation,
  operationRefusedError,
  platformOperations,
} from './operation-policy';
export type { MatchOperationOptions } from './operation-policy';
export {
  BUNDLED_OPERATION_TABLE_VERSION,
  effectiveOperationTable,
  OPERATION_TABLE_CLOCK_SKEW_MS,
  OPERATION_TABLE_FORBIDDEN_HOSTS,
  OPERATION_TABLE_LIMITS,
  OPERATION_TABLE_MAX_LIFETIME_MS,
  OPERATION_TABLE_PUBLIC_SUFFIXES,
  operationTableRefusedError,
  parseOperationTableDocument,
  platformOperationHosts,
  serializeOperationTableDocument,
  validateOperationTableDocument,
} from './operation-table-document';
export type {
  OperationTableDocument,
  OperationTableParse,
  OperationTableRefusal,
  OperationTableRefusalReason,
  SignedOperationTable,
} from './operation-table-document';
export {
  isAllowedSteamSignedOperation,
  isPathPatternWithin,
  isSteamHost,
  STEAM_HOSTS,
  STEAM_SIGNED_OPERATION_ALLOWLIST,
} from './steam-operation-allowlist';
export type { SteamSignedOperationRule } from './steam-operation-allowlist';

export type Platform =
  | 'cs.money'
  | 'csfloat.com'
  | 'buff.163.com'
  | 'steamcommunity.com'
  | 'tradeit.gg'
  | 'aim.market'
  | 'lis-skins.com'
  | 'avan.market'
  | 'ntskins.com'
  | 'skinport.com'
  | 'dmarket.com'
  | 'white.market'
  | 'skin.place'
  | 'skinflow.gg'
  | 'skinout.gg'
  | 'skinswap.com'
  | 'skinsell.gg'
  | 'skinbaron.de'
  | 'shadowpay.com'
  | 'waxpeer.com'
  | 'buff.market'
  | 'haloskins.com';

/**
 * The operations the extension executes, per platform (QUICK-171). Bundled into the extension, so the page
 * cannot widen it; a catalog entry's `operations` can only narrow it. A new marketplace or origin needs an extension
 * rebuild; a changed or new endpoint on an already bundled, granted origin can also come with a signed operation
 * table the operator re-signs and the web serves (`operation-table-document.ts`). Every `Platform` must have an
 * entry (an empty list refuses every request).
 */
export const PLATFORM_OPERATIONS: Readonly<Record<Platform, readonly PlatformOperation[]>> = PLATFORM_OPERATION_TABLE;

/**
 * The connectable marketplaces bundled into the extension (QUICK-202): their consent label, host origins and the one
 * cookie a login check may look at. The page picks platform ids from it; it cannot add an origin or a cookie.
 */
export const PLATFORM_CONNECTIONS: Readonly<Record<Platform, PlatformConnection>> = PLATFORM_CONNECTION_TABLE;

type AssertTrue<T extends true> = T;
type SamePlatformKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time guard: the connection table covers every Platform and nothing else. */
export type ConnectionTableMatchesPlatforms = AssertTrue<SamePlatformKeys<Platform, ConnectablePlatform>>;

export type {
  ConnectablePlatform,
  ExtensionCapability,
  PlatformConnection,
  PlatformConnectionStatus,
  PlatformPermissionState,
  PlatformStatusIssue,
} from './platform-connections';
export {
  connectablePlatformIds,
  connectionOrigins,
  isConnectablePlatform,
  parseExtensionCapabilities,
  TOOLBAR_CONNECT_TTL_MS,
} from './platform-connections';

export interface PlatformUser {
  isAuthorized?: boolean;
  steamId?: string;
  email?: string;
  balance?: number;
  /**
   * CSFloat only: the account sells under the $2,000 balance cap (not both KYC `approved` and Stripe payouts on).
   * Undefined when unknown. See lib/sell/csfloat-cap.ts.
   */
  balanceCapped?: boolean;
  username?: string;
  avatar?: string;
  /** Steam only: the profile's canonical URL, `/id/<vanity>/` when it has a custom one. */
  profileUrl?: string;
}

/**
 * Page-supplied identity (`qts:auth_handoff`). Any script on the web origin can send one, so it must never drive a
 * decision: plan and access are enforced by the server and the web. The extension stores only the subset its validator
 * accepts (`background/auth-handoff-policy.ts`) and reads it nowhere (QUICK-176, test-enforced); it is for display only.
 */
export interface AuthState {
  /** Clerk user id of the signed-in user; absent when signed out. */
  userId?: string;
}

/** Identity summary the web app hands to the extension, display-only like `AuthState`: never plan or access data. */
export interface AuthUserSummary {
  clerkId: string;
  /** Empty for accounts without an email (Sign in with Steam). */
  email: string;
  /** Dropped when it is empty, longer than 256 characters or contains controls or bidi marks. */
  displayName?: string;
  /** Kept only from the Clerk and Steam avatar hosts, and only while the stored identity stays within 4,096 characters. */
  avatarUrl?: string;
}

// ─── Page → extension envelopes ───────────────────────────────────────────

/**
 * Payload shape per site-message name. Use `undefined` for events that carry
 * no data (the resulting envelope omits the `data` property entirely).
 */
/**
 * `platforms` is typed loosely as `string[]` to match the redux action shape
 * upstream. The extension keeps a validated `Platform` whitelist internally
 * and ignores unknown platform names — there is no benefit to forcing the
 * union here. Same reasoning for `items[].id`: Steam asset IDs sometimes flow
 * as strings through the saga even though the platform APIs expect numbers,
 * so we accept both and coerce at the boundary.
 */
/**
 * Minimal shape platforms need to look up competitors for a user's item
 * (currently only sticker-based lookup is implemented per platform). Keep
 * this lean — we don't want to ship the whole Item type through the bridge.
 */
export interface CompetitorLookupItem {
  id: number | string;
  name?: string;
  stickers?: Array<{ name: string; position: number } | null>;
  /** Whether the source item is StatTrak — required for the cache key so StatTrak / non-StatTrak share no entries. */
  isStatTrack?: boolean;
  /** Whether the source item is Souvenir — required for the cache key. */
  isSouvenir?: boolean;
  /** CSFloat weapon def_index — enables precise def_index + paint_index competitor search. */
  defIndex?: number;
  /** CSFloat paint_index — identifies the Doppler/Gamma-Doppler phase for narrowing the search. */
  paintIndex?: number;
}

/** Tri-state login status for a platform, surfaced in the popup and queryable by the web app. */
export type LoginStatus = 'logged-in' | 'logged-out' | 'unknown';

/**
 * Web-supplied instruction for how the extension checks login status on a platform. The extension
 * stays generic — it executes this descriptor, it does not embed per-platform auth knowledge.
 *  - `cookie`: logged-in when the named cookie exists and is non-empty.
 *  - `request`: proxy a request and classify the response (status membership + optional truthy JSON path).
 */
export type LoginCheck =
  | { kind: 'cookie'; url: string; name: string }
  | {
      kind: 'request';
      url: string;
      method?: 'GET' | 'POST';
      headers?: Record<string, string>;
      body?: string;
      /** Status codes that mean logged-in. Defaults to [200]. */
      okStatus?: number[];
      /** Status codes that mean definitely logged-out (e.g. [401, 403]). */
      loggedOutStatus?: number[];
      /**
       * Optional dot-path into the JSON body that must be truthy (e.g. 'user.steam_id'). An explicit empty value on the
       * path (null, false, 0, '') is a signed-out answer; a body that lacks the path is not (QUICK-202): its login stays
       * unknown unless it matches `loggedOutMatch`.
       */
      truthyPath?: string;
      /** The documented signed-out body of a platform whose answer then lacks `truthyPath` (Skinport `{ success: false }`). */
      loggedOutMatch?: { path: string; equals: string | number | boolean };
    };

/** One connectable marketplace, supplied by the web app at runtime so new sites need no extension rebuild. */
export interface PlatformCatalogEntry {
  /** Logical platform id (e.g. 'aim.market'). */
  id: string;
  /** Human label shown in the popup (e.g. 'AIM'). */
  label: string;
  /** Host-permission origin patterns to request/check for this platform (e.g. ['https://aim.market/*']). */
  origins: string[];
  /** Whether the platform is usable in the UI (false = shown but disabled, e.g. partial integrations). Defaults to true. */
  available?: boolean;
  /**
   * Granted at install via the extension's required `host_permissions` (cs.money / csfloat.com /
   * steamcommunity.com — the ACTIVE_PLATFORMS). These can't be revoked through the permissions API, so the
   * popup shows them as a static "Default" state instead of a Disconnect toggle. Defaults to false
   * (user-granted).
   */
  defaultGranted?: boolean;
  /** How the extension checks login status for this platform. Omitted → status is always 'unknown'. */
  loginCheck?: LoginCheck;
  /** Quick-login URL (e.g. a Steam OpenID redirect that returns to the platform). Omitted → no Login button. */
  loginUrl?: string;
  /**
   * Narrows the bundled `PLATFORM_OPERATIONS` of this platform to these ids (unknown ids are ignored); it
   * can never add an operation. Omitted → every bundled operation of the platform.
   */
  operations?: string[];
  /** How the scheduler paces this platform (QUICK-289, extension 1.10.0+); clamped by the extension, ignored by older ones. */
  scheduler?: PlatformSchedulerPolicy;
}

// ─── Scheduled price-decrease rules ──────────────────────────────────────────

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Cookie behaviour for the proxied fetch. Defaults to `'include'` (the proxy sends the origin's
   * cookies — the norm for session-cookie auth). Set `'omit'` for APIs that authenticate purely via
   * an `Authorization` header and reject requests that carry the session cookie (DMarket's
   * api.dmarket.com returns 504 when the `dm-trade-token` cookie is present).
   */
  credentials?: 'omit' | 'include';
}

/** Serialisable subset of chrome.declarativeNetRequest.Rule — no Chrome-specific enum types. */
export interface DnrRule {
  id: number;
  priority?: number;
  action: {
    type: string;
    requestHeaders?: Array<{ header: string; operation: string; value?: string }>;
    responseHeaders?: Array<{ header: string; operation: string; value?: string }>;
  };
  condition: {
    urlFilter?: string;
    resourceTypes?: string[];
    /** Replaced on a page rule by extension 1.11.1+: it pins its own host as the only initiator (QUICK-291). */
    initiatorDomains?: string[];
    /** Exclude requests initiated by these domains — used to scope a rule to the extension's own proxy
     *  fetches (not the user's own tab on the same site, e.g. HaloSkins' cf_clearance Cookie injection). */
    excludedInitiatorDomains?: string[];
  };
}

const DAY_MS = 86_400_000;
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Edit-price request template the SW fills with the computed price. */
export interface RepriceTemplate {
  url: string;
  method: string;
  headers?: Record<string, string>;
  /** Body containing the literal token `__PRICE__` where the numeric price is substituted. */
  bodyTemplate: string;
  /** csfloat needs integer cents; cs.money uses dollars. */
  priceInCents: boolean;
  /** Required by safety-aware schedulers; absent on legacy templates. */
  checkTemplate?: RepriceCheckTemplate;
  /** A 2xx write response carrying this error code did not apply: temporary failure, never success. */
  platformError?: RepricePlatformError;
  /** A 2xx write response that rejects this item (e.g. cs.money `errors[]`/`failed[]`) did not apply. */
  itemErrors?: RepriceItemErrors;
  /** How this write joins other rules' writes in one request (QUICK-289, extension 1.10.0+; older ones send it alone). */
  batch?: RepriceBatch;
}

/** Declarative per-item rejection inside a 2xx write body. Rows without a matching id are ignored. */
export interface RepriceItemErrors {
  /** Arrays whose rows each name a rejected item (e.g. `errors`, `failed`). */
  rejectedPaths: string[][];
  /** Arrays of per-item results; a row is a rejection when any `rejectedWhen` path holds one of its values. */
  resultPaths?: string[][];
  rejectedWhen?: Array<{ path: string[]; values: Array<string | number | boolean> }>;
  idPaths: string[][];
  id: string;
}

/** A 2xx body code at these paths is a temporary platform failure (e.g. cs.money `{ error: N }`), unless ignored. */
export interface RepricePlatformError {
  paths: string[][];
  ignoredValues: Array<string | number>;
}

/** Declarative, read-only reconciliation. All paths are relative to JSON, never executable code. */
export interface RepriceCheckTemplate {
  request: HttpRequest & { method: 'GET' };
  /** Only item-specific endpoints should declare e.g. 404/410 as proof of absence. */
  goneStatuses: number[];
  matcher: {
    /** Ordered alternatives for the response array and canonical item/listing id. [] means root. */
    collectionPaths: string[][];
    /** The selected value must be one object; a different id is uncertainty, never absence. */
    single?: boolean;
    idPaths: string[][];
    id: string;
    /** Additional identity checks on the matched row (e.g. listing's Steam asset id). */
    requiredMatches?: Array<{ paths: string[][]; value: string }>;
    state?: {
      paths: string[][];
      listedValues: Array<string | number | boolean>;
      /** Explicit inactive vocabulary only; any other value is uncertainty, never absence. */
      notListedValues: Array<string | number | boolean>;
    };
    /** Absence is conclusive only on a short page. A full page is unknown. */
    pageSize: number;
  };
  /** Offset pagination, only for endpoints whose existing client already uses it. */
  pagination?: { offsetParam: string; maxPages: number };
  platformError?: RepricePlatformError;
}

export interface RepriceResponse {
  ok: boolean;
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

export interface RepriceCheckResult {
  outcome: 'listed' | 'not_listed' | 'unknown';
  reason: string;
  observedStatus?: string | number | boolean;
  /** Full, well-formed page without the target; scheduler may read the next page. */
  hasMore?: boolean;
  /** A declared temporary platform failure: back off, never count it toward the pause limit. */
  transient?: boolean;
  /** Rows on this collection page, so a paged scan can tell an empty inventory from a real absence. */
  rowCount?: number;
}

function readCheckPath(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function firstCheckValue(value: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const found = readCheckPath(value, path);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}

/** True when a 2xx body reports a declared platform error code (see RepricePlatformError). */
export function hasRepricePlatformError(spec: RepricePlatformError | undefined, data: unknown): boolean {
  if (!spec) return false;
  const code = firstCheckValue(data, spec.paths);
  return (
    (typeof code === 'number' || (typeof code === 'string' && code.length > 0)) && !spec.ignoredValues.includes(code)
  );
}

function checkId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

/** True when a 2xx write body rejects the rule's item (see RepriceItemErrors). */
export function hasRepriceItemError(spec: RepriceItemErrors | undefined, data: unknown): boolean {
  if (!spec) return false;
  const rows = (paths: string[][]): unknown[] =>
    paths.flatMap((path) => {
      const value = readCheckPath(data, path);
      return Array.isArray(value) ? value : [];
    });
  const isItem = (row: unknown) => checkId(firstCheckValue(row, spec.idPaths)) === spec.id;
  const rejected = (row: unknown) =>
    (spec.rejectedWhen ?? []).some(({ path, values }) => {
      const value = readCheckPath(row, path);
      return (
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && values.includes(value)
      );
    });
  return (
    rows(spec.rejectedPaths).some(isItem) || rows(spec.resultPaths ?? []).some((row) => isItem(row) && rejected(row))
  );
}

/**
 * Missing/malformed data, unknown states and incomplete pages can never authorize a write.
 * `rowsSeenBefore` counts rows on earlier pages of the same scan: an empty scan is never proof of absence.
 */
export function evaluateRepriceCheck(
  check: RepriceCheckTemplate,
  response: RepriceResponse,
  rowsSeenBefore = 0
): RepriceCheckResult {
  if (isRepriceTransientStatus(response.status)) return { outcome: 'unknown', reason: 'check_http_error' };
  if (check.goneStatuses.includes(response.status) && [404, 410].includes(response.status)) {
    return { outcome: 'not_listed', reason: 'gone_http_status' };
  }
  if (!response.ok || response.status < 200 || response.status >= 300)
    return { outcome: 'unknown', reason: 'check_http_error' };
  if (hasRepricePlatformError(check.platformError, response.data)) {
    return { outcome: 'unknown', reason: 'check_platform_error', transient: true };
  }
  const { matcher } = check;
  const collection = firstCheckValue(response.data, matcher.collectionPaths);
  if (matcher.single && (collection === null || typeof collection !== 'object' || Array.isArray(collection))) {
    return { outcome: 'unknown', reason: 'invalid_check_response' };
  }
  const rows = matcher.single ? [collection] : collection;
  if (!Array.isArray(rows) || !Number.isInteger(matcher.pageSize) || matcher.pageSize <= 0 || !matcher.id) {
    return { outcome: 'unknown', reason: 'invalid_check_response' };
  }
  // Do not turn a changed schema (including a malformed unrelated row) into proof of absence.
  const ids = rows.map((row) => checkId(firstCheckValue(row, matcher.idPaths)));
  if (ids.some((id) => id === undefined)) return { outcome: 'unknown', reason: 'invalid_check_response' };
  const matches = rows.filter((_, index) => ids[index] === matcher.id);
  if (matches.length === 0) {
    if (matcher.single) return { outcome: 'unknown', reason: 'identity_mismatch' };
    const rowCount = rows.length;
    // An empty inventory (a logged-out or failed read can look like one) never proves absence.
    if (rowCount + rowsSeenBefore === 0) return { outcome: 'unknown', reason: 'empty_check_response', rowCount };
    return rowCount < matcher.pageSize
      ? { outcome: 'not_listed', reason: 'absent_from_complete_response', rowCount }
      : { outcome: 'unknown', reason: 'partial_check_response', hasMore: true, rowCount };
  }
  if (matches.length !== 1) return { outcome: 'unknown', reason: 'ambiguous_check_response' };
  const row = matches[0];
  if (matcher.requiredMatches?.some((match) => checkId(firstCheckValue(row, match.paths)) !== match.value)) {
    return { outcome: 'unknown', reason: 'identity_mismatch' };
  }
  if (!matcher.state) return { outcome: 'listed', reason: 'matched_listing' };
  const state = firstCheckValue(row, matcher.state.paths);
  const observedStatus =
    typeof state === 'string' || typeof state === 'number' || typeof state === 'boolean' ? state : undefined;
  if (observedStatus !== undefined && matcher.state.listedValues.includes(observedStatus)) {
    return { outcome: 'listed', reason: 'matched_listing', observedStatus };
  }
  if (observedStatus !== undefined && matcher.state.notListedValues.includes(observedStatus)) {
    return { outcome: 'not_listed', reason: 'inactive_listing', observedStatus };
  }
  return { outcome: 'unknown', reason: 'unknown_listing_state', observedStatus };
}

export const MAX_REPRICE_FAILURES = 3;
const HOUR_MS = 3_600_000;
/** Just under the 6 h tick: one counted failure per rule per tick window, however often the worker restarts. */
export const REPRICE_FAILURE_RETRY_MS = 5 * HOUR_MS;
/** First retry after a transient failure; doubles per consecutive transient failure up to REPRICE_FAILURE_RETRY_MS. */
export const REPRICE_TRANSIENT_RETRY_MS = 5 * 60_000;
/** A rule blocked (401/403, no site access) this long without a break pauses as `blocked_too_long`. */
export const REPRICE_BLOCKED_PAUSE_MS = 7 * DAY_MS;
/** A rule failing only temporarily this long without a break pauses as `transient_too_long`. */
export const REPRICE_TRANSIENT_PAUSE_MS = 7 * DAY_MS;
/** Retired rules stay visible in list_rules for a week, then are pruned. */
export const REPRICE_RETIRED_TTL_MS = 7 * DAY_MS;
/** Paused rules nobody resumed are pruned a month after the pause. */
export const REPRICE_PAUSED_TTL_MS = 30 * DAY_MS;
/** Write statuses that can reject one listing for good (after the circuit breaker, see recordRepriceFailure). */
const REPRICE_TERMINAL_WRITE_STATUSES = new Set([400, 404, 405, 410, 422]);

export function isRepriceTerminalWriteStatus(status: number | undefined): boolean {
  return status !== undefined && REPRICE_TERMINAL_WRITE_STATUSES.has(status);
}
/** First extension release whose scheduler gates every write on the read-only check (QUICK-151). */
export const SAFE_REPRICE_EXTENSION_VERSION = '1.0.56';
/** First extension that can activate and execute one-shot listings. */
export const SCHEDULED_LISTING_EXTENSION_VERSION = '1.0.58';
/**
 * First extension that executes only allowlisted operations and adds the white.market, aim.market and
 * DMarket auth headers itself from their cookies (QUICK-171); those cookies are no longer page-readable.
 */
export const OPERATION_ALLOWLIST_EXTENSION_VERSION = '1.1.0';
/**
 * First extension whose one-shot listings can wait for a trade-locked item to arrive (`waitForArrival`): an
 * absent or empty inventory read keeps the rule waiting until its `arrivalDeadline` instead of retiring it.
 */
export const ARRIVAL_LISTING_EXTENSION_VERSION = '1.2.0';

export const LISTING_PRECONDITION_EXTENSION_VERSION = '1.4.0';

export function isRepriceTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Session expired, captcha (cs.money 403 `errors[].code 4030`) or withheld site access: a platform block, not a rule defect. */
export function isRepriceBlockedStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** `transient` and `blocked` back the platform off and keep the rule; only `counted` failures can pause it. */
export type RepriceFailureKind = 'transient' | 'blocked' | 'counted';

/** An undefined status denotes a local template error, not a failed transport (status 0). */
export function classifyRepriceFailure(status: number | undefined): RepriceFailureKind {
  if (status === undefined) return 'counted';
  if (isRepriceTransientStatus(status)) return 'transient';
  return isRepriceBlockedStatus(status) ? 'blocked' : 'counted';
}

/** Retry delay after the n-th consecutive transient failure of one rule (n >= 1). */
export function repriceTransientRetryMs(count: number): number {
  return Math.min(REPRICE_FAILURE_RETRY_MS, REPRICE_TRANSIENT_RETRY_MS * 2 ** Math.max(0, count - 1));
}

/**
 * Every failure makes the rule wait (`nextAttemptAt`) so one failing rule cannot pin its platform.
 * - transient: a growing retry (5 min doubling to 5 h), never counted; a week of nothing but transient
 *   failures pauses it as `transient_too_long`;
 * - blocked: one retry window; a week of continuous blocking pauses it as `blocked_too_long`;
 * - counted: one retry window; three of them pause the rule (`empty_inventory` when the last read came
 *   back empty). A terminal write status (400/404/405/410/422) pauses it at once only when it is shown
 *   to be about this item: the same status on its previous write, or another rule on the platform
 *   succeeded in the same pass (`provenItemSpecific`). Otherwise it is one strike, so a platform-wide
 *   glitch cannot pause every due rule.
 */
export function recordRepriceFailure(
  rule: ScheduledRule,
  status: number | undefined,
  message: string,
  now: number,
  kind: RepriceFailureKind = classifyRepriceFailure(status),
  stage: 'check' | 'write' = 'write',
  provenItemSpecific = false
): ScheduledRule {
  // Any outcome other than a second "not listed" breaks the consecutive-absence evidence.
  const failed = {
    ...rule,
    lastFailureAt: now,
    lastStatus: status,
    lastMessage: message,
    pendingNotListedAt: undefined,
  };
  const consecutive = rule.consecutiveFailures ?? 0;
  if (kind === 'transient') {
    const transientFailures = (rule.transientFailures ?? 0) + 1;
    const transientSince = rule.transientSince ?? now;
    if (now - transientSince >= REPRICE_TRANSIENT_PAUSE_MS) {
      return {
        ...failed,
        consecutiveFailures: consecutive,
        transientFailures,
        transientSince,
        active: false,
        pausedReason: 'transient_too_long',
        pausedAt: now,
      };
    }
    return {
      ...failed,
      consecutiveFailures: consecutive,
      transientFailures,
      transientSince,
      nextAttemptAt: now + repriceTransientRetryMs(transientFailures),
    };
  }
  if (kind === 'blocked') {
    const blockedSince = rule.blockedSince ?? now;
    if (now - blockedSince >= REPRICE_BLOCKED_PAUSE_MS) {
      return {
        ...failed,
        consecutiveFailures: consecutive,
        blockedSince,
        active: false,
        pausedReason: 'blocked_too_long',
        pausedAt: now,
      };
    }
    return { ...failed, consecutiveFailures: consecutive, blockedSince, nextAttemptAt: now + REPRICE_FAILURE_RETRY_MS };
  }
  const consecutiveFailures = consecutive + 1;
  const terminal = stage === 'write' && isRepriceTerminalWriteStatus(status);
  const pausedReason: ScheduledRule['pausedReason'] =
    terminal && (provenItemSpecific || rule.lastTerminalStatus === status)
      ? 'permanent_http_error'
      : consecutiveFailures >= MAX_REPRICE_FAILURES
        ? message === 'empty_check_response'
          ? 'empty_inventory'
          : 'consecutive_failures'
        : undefined;
  return {
    ...failed,
    consecutiveFailures,
    blockedSince: undefined,
    transientSince: undefined,
    lastTerminalStatus: terminal ? status : rule.lastTerminalStatus,
    nextAttemptAt: now + REPRICE_FAILURE_RETRY_MS,
    ...(pausedReason ? { active: false, pausedReason, pausedAt: now } : {}),
  };
}

/** Absence retires a rule only when two consecutive checks, a retry window apart, both prove it. */
export function recordRepriceNotListed(
  rule: ScheduledRule,
  result: RepriceCheckResult,
  status: number,
  now: number
): ScheduledRule {
  const observed = {
    ...rule,
    lastStatus: status,
    lastCheckStatus: result.observedStatus,
    lastMessage: result.reason,
    transientFailures: undefined,
    transientSince: undefined,
    blockedSince: undefined,
  };
  if (rule.pendingNotListedAt === undefined) {
    return { ...observed, pendingNotListedAt: now, nextAttemptAt: now + REPRICE_FAILURE_RETRY_MS };
  }
  return {
    ...observed,
    active: false,
    retiredReason: 'not_listed',
    retiredAt: now,
    pendingNotListedAt: undefined,
    nextAttemptAt: undefined,
  };
}

export function recordRepriceSuccess(rule: ScheduledRule, dayIndex: number): ScheduledRule {
  return {
    ...rule,
    lastAppliedDay: dayIndex,
    consecutiveFailures: 0,
    lastFailureAt: undefined,
    lastStatus: undefined,
    lastMessage: undefined,
    nextAttemptAt: undefined,
    pendingNotListedAt: undefined,
    transientFailures: undefined,
    transientSince: undefined,
    blockedSince: undefined,
    lastTerminalStatus: undefined,
  };
}

/**
 * Earliest time a rule that is due, apart from its own retry window or its platform's backoff, may
 * run again; null when none waits. The scheduler wakes then instead of polling every minute.
 */
export function nextRepriceWakeAt(rules: ScheduledRule[], now: number, backoff: BackoffMap): number | null {
  let wake: number | null = null;
  for (const rule of rules) {
    if (isScheduledListingRule(rule)) {
      // An overdue or expired one-shot needs no wake: the next pass pauses or retires it without a request.
      if (
        !rule.active ||
        rule.pausedReason ||
        rule.retiredReason ||
        !Number.isFinite(rule.listAt) ||
        isListingOverdue(rule, now) ||
        isArrivalExpired(rule, now)
      )
        continue;
    } else if (isScheduledSyncRule(rule)) {
      // Stale factors need no wake: the next pass pauses the rule without a request.
      if (!rule.active || rule.pausedReason || rule.retiredReason || isSyncFactorsStale(rule, now)) continue;
    } else if (computeRepriceStep({ ...rule, nextAttemptAt: undefined }, now) === null) continue;
    const at = Math.max(
      isScheduledListingRule(rule) ? rule.listAt : isScheduledSyncRule(rule) ? rule.nextSyncAt : now,
      rule.nextAttemptAt ?? now,
      backoff[rule.platform] ?? now,
      isScheduledSyncRule(rule) ? (backoff[rule.reference.platform] ?? now) : now
    );
    wake = wake === null ? at : Math.min(wake, at);
  }
  return wake;
}

/** Retired rules are pruned a week after retirement, paused ones a month after the pause. */
export function isRepriceRuleExpired(rule: ScheduledRule, now: number): boolean {
  if (rule.retiredReason !== undefined && rule.retiredAt !== undefined)
    return now - rule.retiredAt >= REPRICE_RETIRED_TTL_MS;
  return rule.pausedReason !== undefined && rule.pausedAt !== undefined && now - rule.pausedAt >= REPRICE_PAUSED_TTL_MS;
}

function parseVersion(value: string): number[] | null {
  return /^\d+(\.\d+)*$/.test(value) ? value.split('.').map(Number) : null;
}

/** Numeric dotted-version comparison; null when either side is not a plain `x.y.z` version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True only for a known extension version older than the safety-aware scheduler. Unknown is not "old". */
export function isLegacyRepriceExtension(version: string | null | undefined): boolean {
  if (!version) return false;
  const diff = compareVersions(version, SAFE_REPRICE_EXTENSION_VERSION);
  return diff !== null && diff < 0;
}

/** Only explicit registration can activate/reset a paused rule; reading storage never does. */
export function prepareRepriceRegistration(rule: ScheduledRule, now: number): ScheduledRule {
  // A typed refusal, like a malformed listing: the extension never stores a schedule it would not follow.
  if (rule.schedule !== undefined && !isValidPriceSchedule(rule)) throw new Error('invalid_price_schedule');
  const { activationRequested, ...stored } = rule;
  if (!rule.template.checkTemplate) return { ...stored, active: false, pausedReason: 'missing_check', pausedAt: now };
  if (!rule.active && !activationRequested) return stored;
  return {
    ...recordRepriceSuccess(stored, stored.lastAppliedDay),
    active: true,
    pausedReason: undefined,
    pausedAt: undefined,
    retiredReason: undefined,
    retiredAt: undefined,
    lastCheckStatus: undefined,
  };
}

/** One linear reprice ramp for a (item, platform). The SW computes today's price on the fly. */
export interface ScheduledRule {
  /** `sync`: a price follower (QUICK-296, see ScheduledSyncRule). */
  kind?: 'reprice' | 'list' | 'sync';
  ruleId: string; // `${itemId}:${platform}`
  platform: string;
  itemId: number | string;
  marketHashName: string;
  firstPrice: number;
  secondPrice: number;
  startAt: number;
  days: number;
  lastAppliedDay: number; // last applied day-index (0 = only firstPrice so far); with a `schedule`, its step index
  /**
   * The exact prices the web planned (QUICK-289 PR 2, extension 1.10.0+, capability `scheduler_schedule`): step 0 is
   * the listing's own price (`firstPrice`), the last one `secondPrice`; each later step applies once its `at` has
   * passed, instead of the linear `firstPrice` → `secondPrice` ramp. Older extensions ignore it and ramp.
   */
  schedule?: RepricePriceStep[];
  template: RepriceTemplate;
  active: boolean;
  createdAt: number;
  /** Registration-only opt-in. New web sends active:false so old extensions cannot fire it. */
  activationRequested?: boolean;
  consecutiveFailures?: number;
  pausedReason?:
    | 'missing_check'
    | 'extension_update_required'
    | 'permanent_http_error'
    | 'consecutive_failures'
    | 'blocked_too_long'
    | 'transient_too_long'
    | 'empty_inventory'
    | 'scheduled_listing_update_required'
    | 'listing_outcome_unknown'
    | 'listing_overdue'
    | 'identity_ambiguous'
    /** A request of the stored template is not an allowlisted scheduled operation (QUICK-171); no request was made. */
    | 'operation_not_allowed'
    /** A price follower whose factors the web has not refreshed for SYNC_FACTORS_MAX_AGE_MS (QUICK-296). */
    | 'sync_factors_stale';
  pausedAt?: number;
  /**
   * Who planned the rule: `auto_sync` for the market sync of the account's settings (QUICK-296), which the web may
   * cancel when they are switched off. Kept verbatim by every scheduler; absent for what the user scheduled.
   */
  origin?: 'auto_sync';
  /**
   * The Clerk user id of the account that registered the rule (web 1.9.0+, QUICK-214): the extension files the rule's
   * runs in that account's journal only. A rule without one (registered by an older web) is not journaled.
   */
  owner?: string;
  /**
   * `never_appeared`: a `waitForArrival` one-shot whose item was not listable by its `arrivalDeadline`.
   * `required_lot_gone`: a one-shot's `precondition` read found the lot it waits behind gone; nothing was written.
   * `reference_gone`: a price follower's reference listing is sold, delisted or gone (QUICK-296).
   */
  retiredReason?: ListingRetiredReason | 'not_listed' | 'reference_gone';
  retiredAt?: number;
  lastFailureAt?: number;
  lastStatus?: number;
  /** Diagnostic codes only: never store raw marketplace bodies or exception messages. */
  lastMessage?: string;
  lastCheckStatus?: string | number | boolean;
  /** Set by a counted failure or a first "not listed" check: the rule is not attempted before this time. */
  nextAttemptAt?: number;
  /** First conclusive "not listed" check; a second consecutive one retires the rule. */
  pendingNotListedAt?: number;
  /** Consecutive transient failures (never counted toward a pause); sets the growing retry delay. */
  transientFailures?: number;
  /** Start of an unbroken run of 401/403 or withheld-access failures. */
  blockedSince?: number;
  /** Start of an unbroken run of transient failures (cleared by success, not-listed or a counted failure). */
  transientSince?: number;
  /** Terminal write status of the rule's last terminal write failure; the same status again pauses it. */
  lastTerminalStatus?: number;
}

/** A fixed-price one-shot, with inert ramp fields for extensions older than 1.0.58. */
export interface ScheduledListingRule extends ScheduledRule {
  kind: 'list';
  ruleId: string; // `list:${itemId}:${platform}`; never shares a reprice key
  days: 0;
  listAt: number;
  /** Platform-native unit: USD for cs.money, integer cents for CSFloat. */
  fixedPrice: number;
  /** Older schedulers ignore this opt-in; activationRequested is deliberately absent. */
  listingActivationRequested?: boolean;
  /**
   * Sent only after the user confirmed, having checked the marketplace, that an earlier one-shot for this
   * pair which may have been sent (or was listed) can be replaced. Never stored.
   */
  replaceAcknowledged?: boolean;
  /**
   * The item is still trade locked (extension 1.2.0+, see supportsArrivalListing): until `arrivalDeadline` an
   * absent or empty inventory read keeps the rule waiting (ARRIVAL_RETRY_MS) instead of retiring it, and a late
   * run is never paused as `listing_overdue`. Past the deadline it retires as `never_appeared` without a request.
   */
  waitForArrival?: true;
  /** Epoch ms; set exactly when `waitForArrival` is. After `listAt`, at most ARRIVAL_WAIT_MS later. */
  arrivalDeadline?: number;
  template: RepriceTemplate & {
    checkTemplate: RepriceCheckTemplate;
    /** A separate complete stall read when inventory has no listed-state field (CSFloat). */
    stallCheck?: ListingStallCheck;
    /** Read right before the write, after the item proved listable (extension 1.4.0+, see ListingPrecondition). */
    precondition?: ListingPrecondition;
    /**
     * Set for an item that was trade-protected when scheduled: Steam may re-issue its asset id when the
     * protection ends, so the run finds the row by this identity and sends its CURRENT id, which replaces
     * ASSET_ID_TOKEN in `bodyTemplate`. Without it the pinned `itemId` is used.
     */
    identity?: ListingIdentity;
    /** A 2xx create proves the listing only when its JSON object body carries a non-empty id at one of these. */
    successIdPaths?: string[][];
  };
}

/** How a one-shot ended without a pause (`not_listed` belongs to reprice rules). */
export type ListingRetiredReason =
  | 'listed'
  | 'already_listed'
  | 'not_in_inventory'
  | 'never_appeared'
  | 'required_lot_gone';

/** A complete cursor-paged read of the user's own listings (CSFloat's stall), with the row `matcher.id` names. */
export type ListingStallCheck = RepriceCheckTemplate & {
  cursor: { param: string; path: string[]; totalPath: string[]; rowIdPaths: string[][]; maxPages: number };
};


export interface ListingPrecondition {
  /** Why the one-shot waits, for the web's wording: CSFloat lists first (`cross_list_hold`). */
  reason: 'cross_list_hold';
  /** Bridge platform id of the read, e.g. `csfloat.com` for a `cs.money` one-shot. */
  platform: string;
  liveCheck: ListingStallCheck;
}

/** Name, float and paint seed of one copy, and where an inventory row of the marketplace reports them. */
export interface ListingIdentity {
  name: string;
  /** `float.toFixed(LISTING_FLOAT_DIGITS)`, as `listingIdentityFloat` renders it. */
  float: string;
  seed: number;
  namePaths: string[][];
  floatPaths: string[][];
  /** A row without a seed reads as 0, as the web inventory normalizers do. */
  seedPaths: string[][];
}

/** Replaced by the asset id the run resolved; only in templates with an `identity`. */
export const ASSET_ID_TOKEN = '__ASSET_ID__';
/** Float digits that identify a copy across marketplaces (FLOAT_KEY_PRECISION in the web's trade history). */
export const LISTING_FLOAT_DIGITS = 6;

/** The float as an identity string, or undefined when it is missing or not a wear float. */
export function listingIdentityFloat(value: unknown): string | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 && number < 1
    ? number.toFixed(LISTING_FLOAT_DIGITS)
    : undefined;
}

function isValidIdentity(identity: ListingIdentity): boolean {
  const paths = [identity.namePaths, identity.floatPaths, identity.seedPaths];
  return (
    typeof identity.name === 'string' &&
    identity.name.trim().length > 0 &&
    listingIdentityFloat(identity.float) === identity.float &&
    Number.isSafeInteger(identity.seed) &&
    identity.seed >= 0 &&
    paths.every(
      (alternatives) =>
        Array.isArray(alternatives) &&
        alternatives.length > 0 &&
        alternatives.every((path) => Array.isArray(path) && path.length > 0)
    )
  );
}

export function isScheduledListingRule(rule: ScheduledRule): rule is ScheduledListingRule {
  return rule.kind === 'list';
}

/** The one-shot of an (item, platform) pair; the pair's reprice rule is `${itemId}:${platform}`. */
export function listingRuleId(itemId: number | string, platform: string): string {
  return `list:${itemId}:${platform}`;
}

export function supportsScheduledListing(version: string | null | undefined): boolean {
  const diff = version ? compareVersions(version, SCHEDULED_LISTING_EXTENSION_VERSION) : null;
  return diff !== null && diff >= 0;
}

/** The extension keeps a `waitForArrival` one-shot waiting through absent reads (see ScheduledListingRule). */
export function supportsArrivalListing(version: string | null | undefined): boolean {
  const diff = version ? compareVersions(version, ARRIVAL_LISTING_EXTENSION_VERSION) : null;
  return diff !== null && diff >= 0;
}

/** The extension runs a one-shot's `precondition` read before its write (see ListingPrecondition). */
export function supportsListingPrecondition(version: string | null | undefined): boolean {
  const diff = version ? compareVersions(version, LISTING_PRECONDITION_EXTENSION_VERSION) : null;
  return diff !== null && diff >= 0;
}

/** The extension adds marketplace auth headers itself: the page sends those requests without a token. */
export function supportsBackgroundAuth(version: string | null | undefined): boolean {
  const diff = version ? compareVersions(version, OPERATION_ALLOWLIST_EXTENSION_VERSION) : null;
  return diff !== null && diff >= 0;
}

export { BUNDLED_OPERATION_SINCE } from './extension-operations';

export interface ExtensionOperationContext {
  extensionVersion: string | null | undefined;
  /** Only an acknowledged, still-valid table; the caller drops it on expiry, refusal or disconnect. */
  acceptedTable?: { version: number; operationIds: readonly string[] };
}

/** An unknown version cannot prove an operation is missing; the extension still enforces its own allowlist. */
export function extensionSupportsOperation(opId: string, ctx: ExtensionOperationContext): boolean {
  if (ctx.extensionVersion == null) return true;
  if (ctx.acceptedTable?.operationIds.includes(opId)) return true;
  // Own keys only; Object.hasOwn is not in the server's ES lib.
  if (!Object.prototype.hasOwnProperty.call(BUNDLED_OPERATION_SINCE, opId)) return false;
  const since = BUNDLED_OPERATION_SINCE[opId];
  if (since === 'always') return true;
  const diff = ctx.extensionVersion && since ? compareVersions(ctx.extensionVersion, since) : null;
  return diff === null || diff >= 0;
}

/** The token a reprice `bodyTemplate` carries where the scheduler writes the day's price. */
const PRICE_TOKEN = '__PRICE__';
/** Stand-in values for the tokens a template carries, so its requests can be matched before they fire. */
const SCHEDULED_PROBE_PRICE = '1';
const SCHEDULED_PROBE_ASSET_ID = '1';
const SCHEDULED_PROBE_CURSOR = 'probe';

/** A request of a stored rule: the scheduler's read-only checks and its write. */
export interface ScheduledRuleRequest {
  stage: 'check' | 'write';
  request: OperationRequest;
  /** The platform whose operations it must match when it is not the rule's own (a `precondition` read). */
  platform?: string;
}

/** Headers the scheduler adds to every check read so a stale cache never decides a write. */
export function scheduledCheckHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return { ...headers, 'Cache-Control': 'no-cache' };
}

function withQueryParam(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Every request a scheduled rule can send, built the way the scheduler builds them (price and asset id
 * replaced by probe values, pagination and cursor parameters set). Matched at registration; each real
 * request is matched again right before it is sent.
 */
export function scheduledRuleRequests(rule: ScheduledRule): ScheduledRuleRequest[] {
  const { template } = rule;
  const out: ScheduledRuleRequest[] = [];
  const check = template.checkTemplate;
  if (check) {
    const url = check.pagination
      ? withQueryParam(check.request.url, check.pagination.offsetParam, '0')
      : check.request.url;
    out.push({
      stage: 'check',
      request: { ...check.request, url, headers: scheduledCheckHeaders(check.request.headers) },
    });
  }
  if (isScheduledListingRule(rule) && rule.template.stallCheck) {
    const stall = rule.template.stallCheck;
    out.push({
      stage: 'check',
      request: {
        ...stall.request,
        url: withQueryParam(stall.request.url, stall.cursor.param, SCHEDULED_PROBE_CURSOR),
        headers: scheduledCheckHeaders(stall.request.headers),
      },
    });
  }
  if (isScheduledSyncRule(rule) && rule.reference?.check) {
    const { platform, check: reference } = rule.reference;
    out.push({
      stage: 'check',
      platform,
      request: { ...reference.request, headers: scheduledCheckHeaders(reference.request.headers) },
    });
  }
  if (isScheduledListingRule(rule) && rule.template.precondition) {
    const { platform, liveCheck } = rule.template.precondition;
    out.push({
      stage: 'check',
      platform,
      request: {
        ...liveCheck.request,
        url: withQueryParam(liveCheck.request.url, liveCheck.cursor.param, SCHEDULED_PROBE_CURSOR),
        headers: scheduledCheckHeaders(liveCheck.request.headers),
      },
    });
  }
  out.push({
    stage: 'write',
    request: {
      url: template.url,
      method: template.method,
      headers: template.headers ?? { 'Content-Type': 'application/json' },
      body: String(template.bodyTemplate)
        .split(PRICE_TOKEN)
        .join(SCHEDULED_PROBE_PRICE)
        .split(ASSET_ID_TOKEN)
        .join(SCHEDULED_PROBE_ASSET_ID),
    },
  });
  // A batched write (two probe items) must match an operation as well as the rule's own write.
  const { batch } = template;
  if (batch && typeof batch.wrapper === 'string' && typeof batch.item === 'string') {
    const item = batch.item
      .split(PRICE_TOKEN)
      .join(SCHEDULED_PROBE_PRICE)
      .split(ASSET_ID_TOKEN)
      .join(SCHEDULED_PROBE_ASSET_ID);
    out.push({
      stage: 'write',
      request: {
        url: template.url,
        method: template.method,
        headers: template.headers ?? { 'Content-Type': 'application/json' },
        body: composeBatchBody(batch.wrapper, [item, item]),
      },
    });
  }
  return out;
}

export const MAX_LISTING_DELAY_MS = 30 * DAY_MS;
/** A one-shot this late would list at a price frozen long ago: it pauses for the user to reschedule instead. */
export const LISTING_OVERDUE_MS = DAY_MS;

/** How long a `waitForArrival` one-shot may wait past its `listAt` (the default `arrivalDeadline`). */
export const ARRIVAL_WAIT_MS = 7 * DAY_MS;
/** A `waitForArrival` one-shot whose item is not in the marketplace inventory yet looks again this much later. */
export const ARRIVAL_RETRY_MS = 20 * 60_000;

/** A one-shot carrying the arrival fields (prepareListingRegistration has validated them). */
export type ArrivalListingRule = ScheduledListingRule & { waitForArrival: true; arrivalDeadline: number };

/** A one-shot that waits for its trade-locked item to arrive (a valid `waitForArrival` + `arrivalDeadline`). */
export function isArrivalListing(rule: ScheduledRule): rule is ArrivalListingRule {
  return isScheduledListingRule(rule) && rule.waitForArrival === true && Number.isFinite(rule.arrivalDeadline);
}

/** A waiting arrival one-shot past its deadline; the scheduler retires it as `never_appeared` without any request. */
export function isArrivalExpired(rule: ScheduledListingRule, now: number): boolean {
  return (
    isArrivalListing(rule) && rule.active && !rule.pausedReason && !rule.retiredReason && now > rule.arrivalDeadline
  );
}

/**
 * A waiting one-shot more than LISTING_OVERDUE_MS past its time; the scheduler pauses it without any request.
 * An arrival one-shot is never overdue: it waits for the item until its own deadline (isArrivalExpired).
 */
export function isListingOverdue(rule: ScheduledListingRule, now: number): boolean {
  return (
    !isArrivalListing(rule) &&
    rule.active &&
    !rule.pausedReason &&
    !rule.retiredReason &&
    Number.isFinite(rule.listAt) &&
    now - rule.listAt > LISTING_OVERDUE_MS
  );
}

export function isListingDue(rule: ScheduledListingRule, now: number): boolean {
  return (
    rule.active &&
    !rule.pausedReason &&
    !rule.retiredReason &&
    rule.days === 0 &&
    Number.isFinite(rule.listAt) &&
    now >= rule.listAt &&
    now >= (rule.nextAttemptAt ?? 0) &&
    !isListingOverdue(rule, now) &&
    !isArrivalExpired(rule, now)
  );
}

/** A stored one-shot whose listing may have been sent, or was sent: replacing it needs the user's confirmation. */
export function needsListingAcknowledgement(rule: ScheduledRule): boolean {
  return (
    isScheduledListingRule(rule) && (rule.pausedReason === 'listing_outcome_unknown' || rule.retiredReason === 'listed')
  );
}

/** A listing never goes through ramp arithmetic, even with a damaged legacy days field. */
export function computeScheduledStep(rule: ScheduledRule, now: number): RepriceStep | null {
  // A follower's price is known only after it read its reference: the scheduler replaces this step before any write.
  if (isScheduledSyncRule(rule))
    return isSyncDue(rule, now) ? { targetPrice: Number.NaN, dayIndex: 0, final: false } : null;
  if (!isScheduledListingRule(rule)) return computeRepriceStep(rule, now);
  return isListingDue(rule, now) ? { targetPrice: rule.fixedPrice, dayIndex: 0, final: true } : null;
}

/** Both arrival fields or neither; the deadline after `listAt` and at most ARRIVAL_WAIT_MS later. */
function isValidArrivalWindow(rule: ScheduledListingRule): boolean {
  if (rule.waitForArrival === undefined && rule.arrivalDeadline === undefined) return true;
  const deadline = rule.arrivalDeadline;
  return (
    rule.waitForArrival === true &&
    typeof deadline === 'number' &&
    Number.isFinite(deadline) &&
    deadline > rule.listAt &&
    deadline <= rule.listAt + ARRIVAL_WAIT_MS
  );
}

/** A read-only cursor read of another platform naming one row; absent means no precondition. */
function isValidPrecondition(rule: ScheduledListingRule): boolean {
  const precondition = rule.template.precondition;
  if (precondition === undefined) return true;
  const { liveCheck } = precondition;
  return (
    precondition.reason === 'cross_list_hold' &&
    typeof precondition.platform === 'string' &&
    precondition.platform.length > 0 &&
    precondition.platform !== rule.platform &&
    liveCheck?.request?.method === 'GET' &&
    typeof liveCheck.matcher?.id === 'string' &&
    liveCheck.matcher.id.length > 0 &&
    Number.isInteger(liveCheck.cursor?.maxPages) &&
    liveCheck.cursor.maxPages > 0
  );
}

export function prepareListingRegistration(rule: ScheduledListingRule, now: number): ScheduledListingRule {
  if (
    !isValidPrecondition(rule) ||
    rule.ruleId !== listingRuleId(rule.itemId, rule.platform) ||
    rule.days !== 0 ||
    !Number.isFinite(rule.listAt) ||
    rule.listAt <= now ||
    rule.listAt > now + MAX_LISTING_DELAY_MS ||
    !Number.isFinite(rule.fixedPrice) ||
    rule.fixedPrice <= 0 ||
    !Number.isFinite(rule.createdAt) ||
    rule.createdAt > now ||
    !rule.template.checkTemplate ||
    rule.template.checkTemplate.request.method !== 'GET' ||
    (!rule.template.checkTemplate.matcher.state && !rule.template.stallCheck) ||
    rule.template.bodyTemplate.includes('__PRICE__') ||
    rule.template.bodyTemplate.split(ASSET_ID_TOKEN).length !== (rule.template.identity ? 2 : 1) ||
    (rule.template.identity !== undefined && !isValidIdentity(rule.template.identity)) ||
    rule.template.method !== 'POST' ||
    !isValidArrivalWindow(rule)
  ) {
    throw new Error('invalid_listing_rule');
  }
  const {
    listingActivationRequested,
    activationRequested: _legacyActivation,
    replaceAcknowledged: _acknowledgement,
    ...stored
  } = rule;
  // Only a payload that itself carries a completed or ambiguous state (the web never sends one) stays
  // inactive here. The stored record is guarded by the extension's registerRule (needsListingAcknowledgement).
  if (stored.retiredReason || stored.pausedReason === 'listing_outcome_unknown') return { ...stored, active: false };
  return {
    ...stored,
    active: listingActivationRequested === true,
    pausedReason: listingActivationRequested ? undefined : 'scheduled_listing_update_required',
    pausedAt: listingActivationRequested ? undefined : now,
  };
}

export interface ListingCheckResult extends Omit<RepriceCheckResult, 'outcome'> {
  outcome: 'ready' | 'already_listed' | 'absent' | 'ambiguous' | 'unknown';
}

/** One inventory page read for an identity: the matching rows' current ids and listed state. */
export interface ListingIdentityPage {
  /** Set when the page cannot be used: nothing may be concluded from the scan. */
  failure?: ListingCheckResult;
  rowCount: number;
  /** A full page: the scan must read the next one before concluding. */
  full: boolean;
  matches: Array<{ id: string; listed?: boolean; observedStatus?: string | number | boolean }>;
}

function failedIdentityPage(reason: string, transient = false): ListingIdentityPage {
  return {
    failure: { outcome: 'unknown', reason, ...(transient ? { transient } : {}) },
    rowCount: 0,
    full: false,
    matches: [],
  };
}

/** Fail-closed like evaluateRepriceCheck: every row needs an id, and any doubt fails the page. */
export function evaluateListingIdentityPage(
  check: RepriceCheckTemplate,
  identity: ListingIdentity,
  response: RepriceResponse
): ListingIdentityPage {
  const fail = failedIdentityPage;
  if (isRepriceTransientStatus(response.status) || !response.ok || response.status < 200 || response.status >= 300)
    return fail('check_http_error');
  if (hasRepricePlatformError(check.platformError, response.data)) return fail('check_platform_error', true);
  const rows = firstCheckValue(response.data, check.matcher.collectionPaths);
  if (!Array.isArray(rows) || !Number.isInteger(check.matcher.pageSize) || check.matcher.pageSize <= 0)
    return fail('invalid_check_response');
  const matches: ListingIdentityPage['matches'] = [];
  for (const row of rows) {
    const id = checkId(firstCheckValue(row, check.matcher.idPaths));
    if (id === undefined) return fail('invalid_check_response');
    const name = firstCheckValue(row, identity.namePaths);
    const seed = firstCheckValue(row, identity.seedPaths) ?? 0;
    if (
      typeof name !== 'string' ||
      name.trim() !== identity.name.trim() ||
      listingIdentityFloat(firstCheckValue(row, identity.floatPaths)) !== identity.float ||
      Number(seed) !== identity.seed
    )
      continue;
    const state = check.matcher.state ? firstCheckValue(row, check.matcher.state.paths) : undefined;
    const observedStatus =
      typeof state === 'string' || typeof state === 'number' || typeof state === 'boolean' ? state : undefined;
    const listed = !check.matcher.state
      ? undefined
      : observedStatus !== undefined && check.matcher.state.listedValues.includes(observedStatus)
        ? true
        : observedStatus !== undefined && check.matcher.state.notListedValues.includes(observedStatus)
          ? false
          : undefined;
    matches.push({ id, listed, observedStatus });
  }
  return { rowCount: rows.length, full: rows.length >= check.matcher.pageSize, matches };
}

/** Steam asset ids are decimal; anything else never reaches a request body. */
export function isListingAssetId(id: string): boolean {
  return /^[1-9]\d{0,19}$/.test(id);
}

/**
 * The result of a complete identity scan: no match is absence (the two-read retirement applies), more
 * than one is ambiguity (paused, never guessed), one decides by its listed state and gives the id to use.
 */
export function concludeListingIdentity(
  check: RepriceCheckTemplate,
  matches: ListingIdentityPage['matches'],
  rowsSeen: number
): { result: ListingCheckResult; assetId?: string } {
  if (rowsSeen === 0) return { result: { outcome: 'unknown', reason: 'empty_check_response', rowCount: 0 } };
  if (matches.length === 0) return { result: { outcome: 'absent', reason: 'absent_from_complete_response' } };
  if (matches.length > 1) return { result: { outcome: 'ambiguous', reason: 'identity_ambiguous' } };
  const [match] = matches;
  if (!match || !isListingAssetId(match.id)) return { result: { outcome: 'unknown', reason: 'invalid_asset_id' } };
  const observed = { observedStatus: match.observedStatus };
  if (!check.matcher.state || match.listed === false)
    return { result: { outcome: 'ready', reason: 'identity_matched', ...observed }, assetId: match.id };
  if (match.listed) return { result: { outcome: 'already_listed', reason: 'matched_listing', ...observed } };
  return { result: { outcome: 'unknown', reason: 'unknown_listing_state', ...observed } };
}

/** A 2xx create body that proves the listing: a JSON object, with an id where the template names one. */
export function isListingWriteConfirmed(template: ScheduledListingRule['template'], data: unknown): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  return !template.successIdPaths || checkId(firstCheckValue(data, template.successIdPaths)) !== undefined;
}

/** Reuse the fail-closed inventory parser; a missing row is never permission to create a listing. */
export function evaluateListingCheck(
  check: RepriceCheckTemplate,
  response: RepriceResponse,
  rowsSeenBefore = 0
): ListingCheckResult {
  const result = evaluateRepriceCheck(check, response, rowsSeenBefore);
  const outcome =
    result.outcome === 'unknown'
      ? 'unknown'
      : result.reason === 'absent_from_complete_response' || result.reason === 'gone_http_status'
        ? 'absent'
        : result.outcome === 'listed' && check.matcher.state
          ? 'already_listed'
          : 'ready';
  return { ...result, outcome };
}

/** Complete cursor-page evidence, interpreted without platform code in the extension. */
export function evaluateListingStallPage(
  check: NonNullable<ScheduledListingRule['template']['stallCheck']>,
  response: RepriceResponse,
  seen: number,
  previousTotal?: number
): { result: ListingCheckResult; total?: number; cursor?: string; rowIds?: string[] } {
  // Inventory presence was proved separately. An empty *stall* is allowed to prove "not listed".
  const parsed = evaluateRepriceCheck(check, response, 1);
  if (parsed.outcome === 'listed') return { result: { ...parsed, outcome: 'already_listed' } };
  const unknown: ListingCheckResult = { ...parsed, outcome: 'unknown' };
  if (parsed.reason !== 'absent_from_complete_response' && parsed.reason !== 'partial_check_response')
    return { result: unknown };
  const rows = firstCheckValue(response.data, check.matcher.collectionPaths);
  if (!Array.isArray(rows)) return { result: unknown };
  const rowIds = rows.map((row) => checkId(firstCheckValue(row, check.cursor.rowIdPaths)));
  if (rowIds.some((id) => id === undefined) || new Set(rowIds).size !== rowIds.length) {
    return { result: { outcome: 'unknown', reason: 'invalid_stall_row' } };
  }
  const validIds = rowIds.filter((id): id is string => id !== undefined);
  const reported = readCheckPath(response.data, check.cursor.totalPath);
  if (
    reported !== undefined &&
    (typeof reported !== 'number' ||
      !Number.isSafeInteger(reported) ||
      reported < 0 ||
      (previousTotal !== undefined && reported !== previousTotal))
  ) {
    return { result: { outcome: 'unknown', reason: 'invalid_stall_total' } };
  }
  const total = typeof reported === 'number' ? reported : previousTotal;
  const count = seen + (parsed.rowCount ?? 0);
  if (total !== undefined && count > total) return { result: { outcome: 'unknown', reason: 'invalid_stall_total' } };
  const reportedCursor = readCheckPath(response.data, check.cursor.path);
  const cursor = typeof reportedCursor === 'string' && reportedCursor ? reportedCursor : undefined;
  const rowCount = parsed.rowCount ?? 0;
  // A reported total decides. Without one, a cursor means another page may follow even after a short page
  // (the server may cap pages below the limit): only an empty page, or a short one without a cursor, ends it.
  const complete =
    total !== undefined ? count === total : rowCount === 0 || (!cursor && rowCount < check.matcher.pageSize);
  if (complete) return { result: { outcome: 'ready', reason: 'absent_from_complete_stall' }, total, rowIds: validIds };
  if (!rowCount || !cursor) return { result: { outcome: 'unknown', reason: 'incomplete_stall' }, total };
  return { result: { ...unknown, hasMore: true }, total, cursor, rowIds: validIds };
}

/**
 * What a complete `precondition` read (evaluateListingStallPage over its pages) says about the write: the named row
 * present lets it go ahead (`met`), a complete read without it retires the one-shot (`unmet`), anything else proves
 * nothing (`unknown`, a failure retried behind a fresh read).
 */
export function listingPreconditionOutcome(
  result: ListingCheckResult | RepriceCheckResult
): 'met' | 'unmet' | 'unknown' {
  if (result.outcome === 'already_listed') return 'met';
  if (result.outcome === 'ready' && result.reason === 'absent_from_complete_stall') return 'unmet';
  return 'unknown';
}

export function retireListing(rule: ScheduledRule, reason: ListingRetiredReason, now: number): ScheduledRule {
  return {
    ...recordRepriceSuccess(rule, 0),
    active: false,
    pausedReason: undefined,
    pausedAt: undefined,
    retiredReason: reason,
    retiredAt: now,
    lastMessage: reason,
  };
}

/**
 * The item is not in the marketplace inventory. A regular one-shot retires on two consecutive absent reads; an
 * arrival one-shot waits ARRIVAL_RETRY_MS and looks again (no absence evidence is kept), or retires as
 * `never_appeared` once its deadline has passed.
 */
export function recordListingAbsent(
  rule: ScheduledRule,
  result: ListingCheckResult,
  status: number,
  now: number
): ScheduledRule {
  if (isArrivalListing(rule)) {
    if (now > rule.arrivalDeadline) return retireListing(rule, 'never_appeared', now);
    return {
      ...rule,
      lastStatus: status,
      lastCheckStatus: result.observedStatus,
      lastMessage: result.reason,
      pendingNotListedAt: undefined,
      transientFailures: undefined,
      transientSince: undefined,
      blockedSince: undefined,
      nextAttemptAt: now + ARRIVAL_RETRY_MS,
    };
  }
  const updated = recordRepriceNotListed(rule, { ...result, outcome: 'not_listed' }, status, now);
  return updated.retiredReason ? retireListing(updated, 'not_in_inventory', now) : updated;
}

/**
 * The reprice failure policy: a terminal write status (400/404/405/410/422) is one strike with a retry
 * window and a fresh check, and pauses the rule when the same status repeats (a listing scheduled at the
 * exact unlock time may meet a marketplace that has not seen the unlock yet); three counted failures pause.
 */
export function recordListingFailure(
  rule: ScheduledRule,
  status: number | undefined,
  message: string,
  now: number,
  kind: RepriceFailureKind = classifyRepriceFailure(status),
  stage: 'check' | 'write' = 'write'
): ScheduledRule {
  const updated = recordRepriceFailure(rule, status, message, now, kind, stage);
  // Interleaved absence/blocked/transient reads must not reset the one-shot's retry horizon forever. An arrival
  // one-shot is bounded by its own deadline instead (isArrivalExpired).
  if (
    isScheduledListingRule(rule) &&
    !isArrivalListing(rule) &&
    now - rule.listAt >= REPRICE_TRANSIENT_PAUSE_MS &&
    updated.active
  ) {
    return { ...updated, active: false, pausedReason: 'transient_too_long', pausedAt: now };
  }
  // A one-shot's price is frozen and it is written by its deadline or never: a transient failure (a rate limit, a
  // server error, a refusal the platform's error map reads as transient) looks again within minutes, never after the
  // ramp's hours-long retry, and never later than the last moment it may still be written.
  if (kind === 'transient' && isScheduledListingRule(rule) && updated.active && updated.nextAttemptAt !== undefined) {
    const latest = Math.min(updated.nextAttemptAt, now + LISTING_TRANSIENT_RETRY_MAX_MS, listingDeadline(rule));
    return { ...updated, nextAttemptAt: Math.max(now, latest) };
  }
  return updated;
}

/** The longest a one-shot waits after a transient failure (its retries double from REPRICE_TRANSIENT_RETRY_MS). */
export const LISTING_TRANSIENT_RETRY_MAX_MS = 20 * 60_000;

/** The last moment a one-shot may still be written: an arrival one-shot's own deadline, else its overdue time. */
export function listingDeadline(rule: ScheduledListingRule): number {
  return isArrivalListing(rule) ? rule.arrivalDeadline : rule.listAt + LISTING_OVERDUE_MS;
}

/** The reprice to apply now, or null when nothing is due. Pure — unit-tested. */
export interface RepriceStep {
  targetPrice: number;
  dayIndex: number;
  final: boolean;
}

/** One price of a rule's `schedule`: from `at` (ms epoch) on, the listing should be at `price`. */
export interface RepricePriceStep {
  at: number;
  price: number;
}

/** The most steps a `schedule` may carry: a year of daily steps, with room to spare. */
export const MAX_PRICE_SCHEDULE_STEPS = 400;

/**
 * A schedule the scheduler may follow: 2…MAX_PRICE_SCHEDULE_STEPS steps, strictly ascending integer times, positive
 * prices, beginning at `firstPrice` and ending at `secondPrice` (the prices the rule shows the user).
 */
export function isValidPriceSchedule(
  rule: Pick<ScheduledRule, 'schedule' | 'firstPrice' | 'secondPrice'>
): rule is Pick<ScheduledRule, 'firstPrice' | 'secondPrice'> & { schedule: RepricePriceStep[] } {
  const { schedule } = rule;
  if (!Array.isArray(schedule) || schedule.length < 2 || schedule.length > MAX_PRICE_SCHEDULE_STEPS) return false;
  for (let i = 0; i < schedule.length; i++) {
    const step: unknown = schedule[i];
    if (!step || typeof step !== 'object') return false;
    const { at, price } = step as Partial<RepricePriceStep>;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return false;
    if (typeof price !== 'number' || !Number.isFinite(price) || round2(price) <= 0) return false;
    if (i > 0 && at <= schedule[i - 1].at) return false;
  }
  return (
    round2(schedule[0].price) === round2(rule.firstPrice) &&
    round2(schedule[schedule.length - 1].price) === round2(rule.secondPrice)
  );
}

/** The step of a schedule due now: the latest whose `at` has passed, when it is not the one applied last. */
function computeScheduleStep(rule: ScheduledRule, now: number): RepriceStep | null {
  // Registration refuses a malformed schedule; a damaged stored one writes nothing rather than guess a price.
  if (!isValidPriceSchedule(rule)) return null;
  const { schedule } = rule;
  let dayIndex = -1;
  for (let i = schedule.length - 1; i >= 0; i--) {
    if (schedule[i].at <= now) {
      dayIndex = i;
      break;
    }
  }
  if (dayIndex <= rule.lastAppliedDay) return null;
  return { targetPrice: round2(schedule[dayIndex].price), dayIndex, final: dayIndex === schedule.length - 1 };
}

export function computeRepriceStep(rule: ScheduledRule, now: number): RepriceStep | null {
  if (!rule.active || rule.pausedReason || rule.retiredReason || rule.days <= 0) return null;
  if (rule.nextAttemptAt !== undefined && now < rule.nextAttemptAt) return null;
  if (rule.schedule !== undefined) return computeScheduleStep(rule, now);
  const elapsed = Math.floor((now - rule.startAt) / DAY_MS);
  const dayIndex = Math.min(rule.days, elapsed);
  if (dayIndex <= rule.lastAppliedDay) return null;
  const final = dayIndex >= rule.days;
  const targetPrice = final
    ? round2(rule.secondPrice)
    : round2(rule.firstPrice - ((rule.firstPrice - rule.secondPrice) * dayIndex) / rule.days);
  return { targetPrice, dayIndex, final };
}

// ─── Price sync followers (QUICK-296) ────────────────────────────────────────

/**
 * The reference listing a `sync:` rule follows (QUICK-296): one read of it, and where its row carries the price. The
 * read is an allowlisted `schedule: 'check'` operation of the reference market, matched like every scheduled request.
 */
export interface SyncReference {
  /** Bridge platform id of the reference market (e.g. `csfloat.com`); never the rule's own platform. */
  platform: string;
  /**
   * A single-row read (`matcher.single`, no pagination) with the listing's state: a sold, delisted or gone reference
   * is conclusive and stops the rule; anything unclear is a failure retried later. Never a price to follow.
   */
  check: RepriceCheckTemplate;
  /** Where the matched row carries its price; the first positive number at these paths is the price. */
  pricePaths: string[][];
  /** The reference price is in integer cents (CSFloat). */
  priceInCents: boolean;
}

/**
 * How the reference price becomes the follower's: `round2(round2(reference × reference factor) ÷ follower factor)`,
 * the web's `mirrorPrice` through the price coefficients. Both 1 when every market gets the same price.
 */
export interface SyncFactors {
  reference: number;
  follower: number;
}

/**
 * A follower listing that keeps its price on the reference listing's (QUICK-296, extension 1.10.0+, capability
 * `scheduler_sync`), with the tab closed too. Every `everyMs` it reads the reference (`reference`), then its own
 * listing (`template.checkTemplate`, as a reprice rule), and writes the follower price through `template` when it
 * differs by half a cent or more. The ramp fields are inert (`days: 0`): an older scheduler stores it and never fires it.
 */
export interface ScheduledSyncRule extends ScheduledRule {
  kind: 'sync';
  ruleId: string; // `sync:${itemId}:${platform}`; never shares a reprice or listing key
  days: 0;
  reference: SyncReference;
  factors: SyncFactors;
  /** When the web computed `factors` (epoch ms): SYNC_FACTORS_MAX_AGE_MS later the rule pauses as `sync_factors_stale`. */
  factorsAt: number;
  /** Time between two runs, ms; registration clamps it to SYNC_INTERVAL_LIMITS. */
  everyMs: number;
  /** The follower's price as last known, USD: the web's at registration, then each write's. */
  syncedPrice: number;
  /**
   * When the follower last wrote its price (epoch ms), so the page tells a change made after the inventory it shows was
   * read. Absent before the first write, and always from extension 1.10.0, which does not record it.
   */
  syncedAt?: number;
  /** Where the follower check's row carries the follower's live price; without it `syncedPrice` stands for it. */
  ownPrice?: { paths: string[][]; inCents: boolean };
  /** The next run (epoch ms); registration makes it due at once. */
  nextSyncAt: number;
  /** Registration-only opt-in: without it the rule is stored inactive. Never stored. */
  syncActivationRequested?: boolean;
}

const MINUTE_MS = 60_000;
/** How often a follower may run, and how often the web asks by default. */
export const SYNC_INTERVAL_LIMITS = { minMs: HOUR_MS, maxMs: DAY_MS, defaultMs: 3 * HOUR_MS } as const;
/** Factors the web has not refreshed for this long are no longer trusted: the rule pauses until it registers again. */
export const SYNC_FACTORS_MAX_AGE_MS = 7 * DAY_MS;
/** A follower closer than this to its target price is in sync (half a cent, as ASK_SIGHTING_SAME_PRICE). */
export const SYNC_PRICE_TOLERANCE = 0.005;
/** A follower ÷ reference factor outside this is a broken coefficient table, never a price to follow. */
const SYNC_FACTOR_RATIO = { min: 0.2, max: 5 } as const;

/** The follower rule of an (item, platform) pair; its reprice rule is `${itemId}:${platform}`. */
export function syncRuleId(itemId: number | string, platform: string): string {
  return `sync:${itemId}:${platform}`;
}

export function isScheduledSyncRule(rule: ScheduledRule): rule is ScheduledSyncRule {
  return rule.kind === 'sync';
}

function validSyncFactors(factors: SyncFactors | undefined): factors is SyncFactors {
  if (!factors) return false;
  const { reference, follower } = factors;
  if (![reference, follower].every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0))
    return false;
  const ratio = reference / follower;
  return ratio >= SYNC_FACTOR_RATIO.min && ratio <= SYNC_FACTOR_RATIO.max;
}

/** The follower price for a reference price (both USD), or null when either is unusable. */
export function syncFollowerPrice(referencePrice: number, factors: SyncFactors): number | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !validSyncFactors(factors)) return null;
  const price = round2(round2(referencePrice * factors.reference) / factors.follower);
  return price > 0 ? price : null;
}

function isPathList(paths: unknown): paths is string[][] {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every((path) => Array.isArray(path) && path.length > 0 && path.every((key) => typeof key === 'string'))
  );
}

/**
 * The price (USD) the row of `check.matcher.id` carries at `paths` in a 2xx check body: the first positive number,
 * or undefined (no such row, or no usable price). Only after evaluateRepriceCheck proved the row listed.
 */
export function readSyncRowPrice(
  check: RepriceCheckTemplate,
  data: unknown,
  paths: string[][],
  inCents: boolean
): number | undefined {
  const collection = firstCheckValue(data, check.matcher.collectionPaths);
  const rows = check.matcher.single ? [collection] : Array.isArray(collection) ? collection : [];
  const row = rows.find((candidate) => checkId(firstCheckValue(candidate, check.matcher.idPaths)) === check.matcher.id);
  if (row === undefined) return undefined;
  for (const path of paths) {
    const value = readCheckPath(row, path);
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      return inCents ? round2(value / 100) : round2(value);
  }
  return undefined;
}

/** What one read of the reference says: its price, gone for good, or nothing usable. */
export type SyncReferenceRead =
  | { outcome: 'listed'; price: number }
  | { outcome: 'gone'; reason: string }
  | { outcome: 'unknown'; reason: string; transient?: boolean };

/** Fail-closed like evaluateRepriceCheck: only a listed row with a positive price is a price to follow. */
export function readSyncReference(reference: SyncReference, response: RepriceResponse): SyncReferenceRead {
  const result = evaluateRepriceCheck(reference.check, response);
  if (result.outcome === 'not_listed') return { outcome: 'gone', reason: result.reason };
  if (result.outcome === 'unknown')
    return { outcome: 'unknown', reason: result.reason, ...(result.transient ? { transient: true } : {}) };
  const price = readSyncRowPrice(reference.check, response.data, reference.pricePaths, reference.priceInCents);
  return price === undefined ? { outcome: 'unknown', reason: 'reference_price_missing' } : { outcome: 'listed', price };
}

/** Factors older than SYNC_FACTORS_MAX_AGE_MS: the scheduler pauses the rule without a request. */
export function isSyncFactorsStale(rule: ScheduledSyncRule, now: number): boolean {
  return rule.active && !rule.pausedReason && !rule.retiredReason && !(now - rule.factorsAt < SYNC_FACTORS_MAX_AGE_MS);
}

export function isSyncDue(rule: ScheduledSyncRule, now: number): boolean {
  return (
    rule.active &&
    !rule.pausedReason &&
    !rule.retiredReason &&
    now >= rule.nextSyncAt &&
    now >= (rule.nextAttemptAt ?? 0) &&
    !isSyncFactorsStale(rule, now)
  );
}

function clampSyncInterval(everyMs: number): number {
  const value = Number.isFinite(everyMs) ? everyMs : SYNC_INTERVAL_LIMITS.defaultMs;
  return Math.min(SYNC_INTERVAL_LIMITS.maxMs, Math.max(SYNC_INTERVAL_LIMITS.minMs, Math.round(value)));
}

/** A typed refusal (`invalid_sync_rule`) for anything the scheduler could not follow safely; otherwise the stored rule. */
export function prepareSyncRegistration(rule: ScheduledSyncRule, now: number): ScheduledSyncRule {
  const { reference, template } = rule;
  const check = reference?.check;
  const own = template?.checkTemplate;
  if (
    rule.ruleId !== syncRuleId(rule.itemId, rule.platform) ||
    rule.days !== 0 ||
    rule.schedule !== undefined ||
    typeof reference?.platform !== 'string' ||
    reference.platform.length === 0 ||
    reference.platform === rule.platform ||
    check?.request?.method !== 'GET' ||
    check.matcher?.single !== true ||
    check.pagination !== undefined ||
    !check.matcher.state ||
    typeof check.matcher.id !== 'string' ||
    check.matcher.id.length === 0 ||
    !isPathList(reference.pricePaths) ||
    typeof reference.priceInCents !== 'boolean' ||
    !validSyncFactors(rule.factors) ||
    !Number.isFinite(rule.factorsAt) ||
    rule.factorsAt > now + 5 * MINUTE_MS ||
    now - rule.factorsAt >= SYNC_FACTORS_MAX_AGE_MS ||
    !Number.isFinite(rule.syncedPrice) ||
    round2(rule.syncedPrice) <= 0 ||
    !Number.isFinite(rule.createdAt) ||
    rule.createdAt > now ||
    own?.request?.method !== 'GET' ||
    template.method === 'GET' ||
    !String(template.bodyTemplate).includes(PRICE_TOKEN) ||
    (rule.ownPrice !== undefined && (!isPathList(rule.ownPrice.paths) || typeof rule.ownPrice.inCents !== 'boolean'))
  ) {
    throw new Error('invalid_sync_rule');
  }
  const { syncActivationRequested, activationRequested: _legacyActivation, ...stored } = rule;
  return {
    ...recordRepriceSuccess(stored, stored.lastAppliedDay ?? 0),
    kind: 'sync',
    days: 0,
    reference,
    factors: rule.factors,
    factorsAt: rule.factorsAt,
    syncedPrice: rule.syncedPrice,
    nextSyncAt: now,
    everyMs: clampSyncInterval(rule.everyMs),
    active: syncActivationRequested === true,
    pausedReason: undefined,
    pausedAt: undefined,
    retiredReason: undefined,
    retiredAt: undefined,
    lastCheckStatus: undefined,
  };
}

/**
 * A run that ended well: the follower is at `price` now (written, or found in sync). A write counts in `lastAppliedDay`,
 * so the journal tells a write (`ok`) from a check that changed nothing (`skipped`).
 */
export function recordSyncSuccess(
  rule: ScheduledSyncRule,
  price: number,
  now: number,
  wrote: boolean
): ScheduledSyncRule {
  return {
    ...rule,
    ...recordRepriceSuccess(rule, wrote ? (rule.lastAppliedDay ?? 0) + 1 : rule.lastAppliedDay),
    kind: 'sync',
    days: 0,
    syncedPrice: round2(price),
    ...(wrote ? { syncedAt: now } : {}),
    nextSyncAt: now + rule.everyMs,
  };
}

/** The reference listing is gone (sold, delisted, replaced): the follower stops for good, nothing written. */
export function retireSync(rule: ScheduledRule, now: number): ScheduledRule {
  return {
    ...rule,
    active: false,
    pendingNotListedAt: undefined,
    nextAttemptAt: undefined,
    retiredReason: 'reference_gone',
    retiredAt: now,
    lastMessage: 'reference_gone',
  };
}

/** Backoff state per platform (persisted across SW restarts): platform -> backoffUntil epoch ms. */
export type BackoffMap = Record<string, number>;

export interface DuePassPlan {
  byPlatform: Record<string, ScheduledRule[]>;
  hasMore: boolean;
  /** Due rules were left out by the maxFires cap (not only by backoff): continue soon. */
  capped: boolean;
}

export interface PlanDuePassOptions {
  maxFires: number;
  backoff: BackoffMap;
  /** Platforms with a cap of their own (scheduler policy, QUICK-289): not counted toward `maxFires`. */
  maxFiresByPlatform?: Readonly<Record<string, number>>;
}

/**
 * Decide what to fire this pass: rules with a due step (computeRepriceStep != null), excluding
 * platforms whose backoffUntil > now, grouped by platform (least recently failed first), capped round-robin so the total across
 * platforms is <= maxFires. `hasMore` is true when due rules were left out (cap) or skipped (backoff);
 * `capped` only for the cap.
 */
export function planDuePass(rules: ScheduledRule[], now: number, opts: PlanDuePassOptions): DuePassPlan {
  const byPlatformAll: Record<string, ScheduledRule[]> = {};
  let backedOff = false;
  for (const r of rules) {
    if (computeScheduledStep(r, now) === null) continue;
    if ((opts.backoff[r.platform] ?? 0) > now) {
      backedOff = true;
      continue;
    }
    (byPlatformAll[r.platform] ??= []).push(r);
  }
  // Least recently failed first (then by ruleId), so a failing rule cannot keep its platform's first slot.
  for (const list of Object.values(byPlatformAll)) {
    list.sort(
      (a, b) =>
        (a.lastFailureAt ?? 0) - (b.lastFailureAt ?? 0) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
    );
  }

  const own = opts.maxFiresByPlatform ?? {};
  const cursors: Record<string, number> = {};
  const byPlatform: Record<string, ScheduledRule[]> = {};
  // A platform with a cap of its own takes up to that many, outside the shared round-robin.
  for (const p of Object.keys(byPlatformAll)) {
    const cap = own[p];
    if (cap === undefined) continue;
    const take = byPlatformAll[p].slice(0, Math.max(0, cap));
    if (take.length) byPlatform[p] = take;
    cursors[p] = take.length;
  }
  const platforms = Object.keys(byPlatformAll).sort();
  const shared = platforms.filter((p) => own[p] === undefined);
  let picked = 0;
  let exhausted = false;
  while (picked < opts.maxFires && !exhausted) {
    exhausted = true;
    for (const p of shared) {
      if (picked >= opts.maxFires) break;
      const idx = cursors[p] ?? 0;
      if (idx < byPlatformAll[p].length) {
        (byPlatform[p] ??= []).push(byPlatformAll[p][idx]);
        cursors[p] = idx + 1;
        picked += 1;
        exhausted = false;
      }
    }
  }
  const leftOver = platforms.some((p) => (cursors[p] ?? 0) < byPlatformAll[p].length);
  return { byPlatform, hasMore: backedOff || leftOver, capped: leftOver };
}

/**
 * Backoff delay (ms) from response headers; null if none.
 * Honors Retry-After (sec or HTTP-date) and x-ratelimit-reset (epoch sec).
 */
export function parseRetryAfter(headers: Record<string, string> | undefined, now: number): number | null {
  if (!headers) return null;
  const ra = headers['retry-after'];
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = headers['x-ratelimit-reset'];
  if (reset) {
    const resetSec = Number(reset);
    if (Number.isFinite(resetSec)) return Math.max(0, resetSec * 1000 - now);
  }
  return null;
}

/**
 * CHIPS cookie partition key (top-level site). Cloudflare's `cf_clearance` (and other partitioned cookies)
 * are keyed by top-level site, so an unpartitioned read returns null. The extension reads the one it needs
 * (HaloSkins) in the background; the page bridge refuses partitioned reads.
 */
export interface CookiePartitionKey {
  topLevelSite: string;
}

/** Page → extension `get_cookie` payload: read cookie `name` for origin `url`. */
export interface GetCookiePayload {
  requestId: string;
  url: string;
  name: string;
  /**
   * Partitioned reads are refused: a read that carries any `partitionKey` (even `null`) resolves to
   * `value: null` with an error. The field stays only so existing web callers still compile.
   */
  partitionKey?: CookiePartitionKey;
}

export type CookieReadError =
  | 'cookie_not_allowed'
  | 'cookie_partition_not_allowed'
  | 'cookie_http_only'
  | 'cookie_permission_denied'
  | 'cookie_read_failed';

/** Extension → page `cookie_response`: null on absence/refusal; requestId always echoes the request. */
export interface CookieResponsePayload {
  requestId: string;
  value: string | null;
  error?: CookieReadError;
}

type SitePayloads = {
  probe_installed: undefined;
  get_user_data_from_platforms: { platforms: readonly string[] };
  get_inventory_from_platforms: { platforms: readonly string[] };
  get_transactions_from_platforms: { platforms: readonly string[] };
  get_competitors_for_item: { platforms: readonly string[]; item: CompetitorLookupItem };
  send_items_on_sale_on_platforms: { platforms: readonly string[]; items: { id: number | string; price: number }[] };
  remove_items_from_sale_on_platforms: { platforms: readonly string[]; items: { id: number | string }[] };
  proxy_request: {
    requestId: string;
    platform: string;
    request: HttpRequest;
  };
  /**
   * Read a single cookie value for an origin the user has granted. A generic primitive: the
   * extension does not interpret the value — the web app uses it to build platform-specific auth
   * (e.g. a Bearer token) it cannot read itself, since cookies are cross-origin to the web app.
   */
  get_cookie: GetCookiePayload;
  set_dnr_rules: { rules: DnrRule[] };
  set_platform_catalog: { catalog: PlatformCatalogEntry[] };
  /**
   * An operation table signed by the operator (capability `signed_operation_table`), as the web serves it. The
   * extension verifies it with its bundled key and the limits of `operation-table-document.ts`. The content script
   * answers with `set_operation_table_response`: `{ version, unchanged }`, or `{ error: 'operation_table_refused:<reason>' }`;
   * the web does not wait for it (the extension logs refusals itself).
   */
  set_operation_table: SignedOperationTable;
  get_permissions: undefined;
  /** Re-check login status for every catalog platform; answered with `login_statuses`. */
  get_login_statuses: undefined;
  /**
   * Permission, login state and last check issue per platform (QUICK-202, capability `platform_statuses`); answered
   * with `platform_statuses` carrying the same `requestId`. `platforms` narrows to these known ids (omitted = all);
   * `force` skips the extension's short cache, not its per-platform cooldown.
   */
  get_platform_statuses: { requestId: string; platforms?: readonly string[]; force?: boolean };
  /**
   * The extension's journal entries of this account (QUICK-214, capability `diagnostics_journal`), handed over once:
   * answered with `diagnostics` carrying the same `requestId`; the entries given are removed from the extension.
   */
  take_diagnostics: { requestId: string; owner: string };
  /**
   * Ask for access to these known platform ids (capability `connect_tab`); answered with `connect_opened`. The
   * extension resolves the domains itself. With `toolbar_connect` (1.6.0) it keeps the request and the browser's
   * prompt follows the user's click on the toolbar icon (`opened: 'toolbar'`); an older build opens its consent tab,
   * in `locale` when it is one of LOCALES (`opened: 'tab' | 'reused'`).
   */
  open_connect: { platforms: readonly string[]; locale?: string };
  /** Remove the extension's optional access to these platforms (not their sign-in); answered with `platforms_disconnected`. */
  disconnect_platforms: { platforms: readonly string[] };
  /** The site's interface language, for an older extension's own pages (popup, consent tab); 1.6.0 has none and ignores it. */
  set_ui_locale: { locale: string };
  /** Legacy (before `connect_tab`): ask for access to every platform the extension cannot reach; 1.6.0 handles it like `open_connect`. */
  open_popup: undefined;
  register_rule: ScheduledRule;
  cancel_rule: { ruleId: string };
  list_rules: undefined;
  /**
   * Buy one Market listing at the confirmed price (QUICK-226, capability `market_buy`); answered with
   * `market_buy_result` carrying the same `requestId`. The extension's buy executor re-reads the listing and the
   * balance first and sends nothing when either does not match.
   */
  market_buy: MarketBuyRequest;
  /**
   * The Market live feed (QUICK-231, capability `market_feed`): start it, or change its sources, for this tab and renew
   * the tab's lease; `market_feed_stop` drops the lease (the feed stops with the last one), `market_feed_retry` asks a
   * paused platform again now. All three are answered with `market_feed_state`.
   */
  market_feed_start: { requestId: string; config: MarketFeedConfig };
  market_feed_stop: { requestId: string };
  market_feed_retry: { requestId: string; platform: MarketFeedPlatform };
  /** New feed listings after `sinceSeq` with their rows, and the state; renews the tab's lease. Answered with `market_feed`. */
  get_market_feed: { requestId: string; sinceSeq?: number };
  /** The compact last hour of the feed (QUICK-232 preview); answered with `market_feed_buffer`. */
  get_market_feed_buffer: MarketFeedBufferRequest;
  /** The account's QTS buy orders as the server answered them (QUICK-232, capability `buy_orders`); answered with `buy_orders_set`. */
  set_buy_orders: BuyOrdersSnapshot;
  /**
   * The buy-order engine (QUICK-233, capability `buy_orders_engine`): the server's last answer about the account's lease
   * (`status: null` takes it away at once), answered with `buy_orders_engine`. Only from the web app's own origin.
   */
  set_buy_orders_lease: BuyOrdersLeasePush;
  /** The engine's state, today's spend and activity; answered with `buy_orders_engine`. */
  get_buy_orders_engine: { requestId: string };
  /**
   * Stop all (R-F3, `stopped: true`): the engine of this browser stops at once and stays stopped until this browser's
   * page starts it again (`stopped: false`); the page tells the server too. Answered with `buy_orders_engine`.
   */
  set_buy_orders_stopped: { requestId: string; stopped: boolean };
  /** The page's answer to a `buy_orders_engine_request`. Only from the web app's own origin. */
  buy_orders_engine_answer: BuyOrdersEngineAnswer;
  /** Active sold-elsewhere assets for this account (capability `listing_blocks`), from the app origin only. */
  set_listing_blocks: ListingBlocksSnapshot;
  /**
   * The account's working browser (QUICK-305, capability `active_browser`): the server's claim answer for this browser,
   * answered with `active_browser`. Only from the web app's own origin.
   */
  set_active_browser: ActiveBrowserPush;
  /** What the extension holds (its device id for the claim, whether it has a token); answered with `active_browser`. */
  get_active_browser: { requestId: string };
};

export type SiteMessage = {
  [K in keyof SitePayloads]: SitePayloads[K] extends undefined
    ? { type: 'site'; name: K }
    : { type: 'site'; name: K; data: SitePayloads[K] };
}[keyof SitePayloads];

export type SiteMessageName = SiteMessage['name'];

export interface AuthHandoffMessage {
  type: 'qts:auth_handoff';
  data: { auth: AuthState; user?: AuthUserSummary | null };
}

export type PageToExtensionMessage = SiteMessage | AuthHandoffMessage;

// ─── Extension → page envelopes ───────────────────────────────────────────

export interface PlatformInventoryBatch {
  platform: Platform;
  steamId: string;
  inventory: unknown[];
}

export interface PlatformTransactionsBatch {
  platform: Platform;
  steamId: string;
  transactions: unknown[];
}

export interface PlatformCompetitorsBatch {
  platform: Platform;
  competitors: unknown[];
}

type ExtensionPayloads = {
  installed: {
    isInstalled: boolean;
    version: string;
    permissions?: Record<string, boolean>;
    capabilities?: ExtensionCapability[];
  };
  user_data_from_platforms: Record<string, PlatformUser>;
  inventory_from_platforms: { inventories: PlatformInventoryBatch[] };
  transactions_from_platforms: { transactions: PlatformTransactionsBatch[] };
  // `itemId` echoes back the requested ID so clients can drop stale responses
  // when the user has switched to a different selection mid-flight.
  competitors_for_item: { itemId: number | string; competitors: PlatformCompetitorsBatch[] };
  items_sent_on_sale: unknown;
  items_removed_from_sale: unknown;
  proxy_response: {
    requestId: string;
    ok: boolean;
    status: number;
    data: unknown;
    headers?: Record<string, string>;
    error?: string;
  };
  set_operation_table_response: { version: number; unchanged?: boolean } | { error: string };
  cookie_response: CookieResponsePayload;
  rules_list: { rules: ScheduledRule[] };
  login_statuses: { statuses: Record<string, LoginStatus> };
  platform_statuses: { requestId: string; statuses: PlatformConnectionStatus[] };
  diagnostics: { requestId: string; entries: ExtensionJournalEntry[] };
  connect_opened: { opened: 'tab' | 'reused' | 'toolbar' | 'prompt' } | { error: string };
  platforms_disconnected: { removed: ConnectablePlatform[] } | { error: string };
  market_buy_result: MarketBuyResult;
  market_feed_state: MarketFeedStateResponse;
  market_feed: MarketFeedUpdate;
  /** Pushed to every tab holding a feed lease after a poll brought something new (no `requestId`). */
  market_feed_update: MarketFeedUpdate;
  market_feed_buffer: MarketFeedBufferResponse;
  buy_orders_set: BuyOrdersSetResult;
  /** The engine's view (QUICK-233): the answer to `get_buy_orders_engine`, `set_buy_orders_lease` and `set_buy_orders_stopped`. */
  buy_orders_engine: BuyOrdersEngineView | { requestId?: string; error: string };
  /** Pushed by the engine to a page holding its lease: something to ask the QTS server (no session in the extension). */
  buy_orders_engine_request: BuyOrdersEngineRequest;
  /** Pushed by the engine to every page holding its lease: an activity worth a notification (bought, paused, …). */
  buy_orders_engine_event: BuyOrderActivity;
  /** The extension took the page's `buy_orders_engine_answer`. */
  buy_orders_engine_ack: { requestId: string; accepted: boolean };
  /** The answer to `get_active_browser` and `set_active_browser` (QUICK-305). */
  active_browser: ActiveBrowserView | { requestId?: string; error: string };
};

export type ExtensionMessage = {
  [K in keyof ExtensionPayloads]: { type: 'extension'; name: K; data: ExtensionPayloads[K] };
}[keyof ExtensionPayloads];

export type ExtensionMessageName = ExtensionMessage['name'];

export type ExtensionToPageMessage = ExtensionMessage;

// ─── Content script → background envelopes ────────────────────────────────
//
// Content script collapses a page `{ type: 'site', name: 'foo', data }` into
// a single `site:foo` type string before relaying via `runtime.sendMessage`.
// `probe_installed` is intentionally excluded — it is answered locally in the
// content script and never reaches the background SW.

type ForwardedSiteName = Exclude<SiteMessageName, 'probe_installed'>;

export type SiteBridgeType = `site:${ForwardedSiteName}`;

/** The app's last known active sold-elsewhere set; an empty set clears the account's blocks. */
export interface ListingBlocksSnapshot {
  owner: string;
  /** At most 400 unique asset ids: original and re-issued ids for up to 200 notices. */
  assetIds: string[];
  /** Each asset's last active notice expiry, in epoch milliseconds (notice time + retention). */
  expiresAt: Record<string, number>;
  /** Snapshot time in epoch milliseconds; only a newer snapshot replaces the same owner's set. */
  at: number;
}

export interface SiteBridgeMessage {
  type: SiteBridgeType;
  data?: {
    platforms?: readonly string[];
    items?: { id: number | string; price?: number }[];
    /** Single-item payload for `site:get_competitors_for_item`. */
    item?: CompetitorLookupItem;
    /** Proxy request fields (site:proxy_request). */
    requestId?: string;
    platform?: string;
    request?: HttpRequest;
    /** Cookie-read fields (site:get_cookie): `url` is the origin, `name` the cookie name. */
    url?: string;
    name?: string;
    /** Rule fields (site:cancel_rule). `site:register_rule` carries the
     *  `ScheduledRule` directly as `data` — the handler casts the envelope
     *  via `data as unknown as ScheduledRule`. */
    ruleId?: string;
    /** DNR rules for site:set_dnr_rules. */
    rules?: DnrRule[];
    /** Platform catalog for site:set_platform_catalog. */
    catalog?: PlatformCatalogEntry[];
    /** site:set_operation_table: the exact signed document string and its base64 signature. */
    document?: string;
    signature?: string;
    /** site:get_platform_statuses: skip the extension's short status cache. */
    force?: boolean;
    /** site:open_connect / site:set_ui_locale: the site's interface language (validated by the extension). */
    locale?: string;
    /** site:market_feed_start: the feed's requests and share (validated by the extension). */
    config?: MarketFeedConfig;
    /** site:get_market_feed: the newest seq the page has. */
    sinceSeq?: number;
    /** site:get_market_feed_buffer: first seen at or after (epoch ms), and the sources. */
    sinceMs?: number;
    sources?: readonly string[];
  };
}

export interface ContentBridgeMessage {
  type: 'content:auth_handoff';
  auth: AuthState;
  user?: AuthUserSummary | null;
}

// Shared /auth/me shapes (QUICK-159), per-feature entitlements (QUICK-158) and first value (QUICK-116).
export type {
  Access,
  AccessFeature,
  AccessFeatures,
  AccessReason,
  AccessTier,
  AccountBanNotice,
  AuthMeResponse,
  FirstValueResponse,
  Trial,
  TrialStatus,
} from './auth';
export { DEFAULT_LISTING_MARKETS, parseAccess } from './auth';

// Pure readers of JSON answers, shared by the web and the admin app (QUICK-250).
export { isRecord, parseDate } from './wire';

// The account's preferences: the first-login wizard's choices, the hints toggle (QUICK-194) and page tours (QUICK-258).
export type {
  CoefficientOverrides,
  ListingMarketId,
  ReferencePlatformId,
  TourId,
  UserPreferences,
  UserPreferencesUpdate,
} from './preferences';
export {
  COEFFICIENT_OVERRIDE_MAX,
  COEFFICIENT_OVERRIDE_MIN,
  LISTING_MARKET_IDS,
  REFERENCE_PLATFORM_IDS,
  TOUR_IDS,
} from './preferences';

// The account's daily coefficient snapshots: trade-history profit in a reference platform's prices.
export type {
  CoefficientMedians,
  CoefficientSnapshot,
  CoefficientSnapshotDay,
  CoefficientSnapshotsResponse,
  CoefficientSnapshotWrite,
} from './coefficient-snapshots';
export { COEFFICIENT_SNAPSHOT_MAX_AGE_MS } from './coefficient-snapshots';

// The account's auto-reprice ramps, kept on the server for every browser's extension (QUICK-304).
export type {
  AccountRepriceRule,
  AccountRepriceRulePlatform,
  AccountRepriceRulesCancel,
  AccountRepriceRulesResponse,
  AccountRepriceRulesWrite,
  AccountRepriceRuleState,
} from './account-reprice-rules';
export { ACCOUNT_REPRICE_RULE_LIMITS } from './account-reprice-rules';

// The account's working browser: one browser does the background marketplace work (QUICK-305).
export type {
  ActiveBrowserClaim,
  ActiveBrowserClaimResult,
  ActiveBrowserHolder,
  ActiveBrowserPush,
  ActiveBrowserRenew,
  ActiveBrowserRenewResult,
  ActiveBrowserStatus,
  ActiveBrowserView,
} from './active-browser';
export {
  ACTIVE_BROWSER_DEVICE_ID_PATTERN,
  ACTIVE_BROWSER_DEVICE_LABEL_MAX,
  ACTIVE_BROWSER_DEVICE_RETENTION_MS,
  ACTIVE_BROWSER_LEASE_TTL_MS,
  ACTIVE_BROWSER_MAX_DEVICES,
  ACTIVE_BROWSER_RENEW_MS,
  ACTIVE_BROWSER_STANDBY_MS,
  ACTIVE_BROWSER_TAB_SEEN_MS,
  ACTIVE_BROWSER_TAKEOVER_HOLD_MS,
  ACTIVE_BROWSER_TOKEN_PATTERN,
  cleanActiveBrowserLabel,
  isActiveBrowserDeviceId,
  parseActiveBrowserClaimResult,
  parseActiveBrowserPush,
  parseActiveBrowserRenewResult,
  parseActiveBrowserStatus,
  parseActiveBrowserView,
} from './active-browser';

// The account's settings, sold-elsewhere notices and ask sightings, stored on the server (QUICK-210).
export type {
  AccountCurrency,
  AccountSettings,
  AccountSettingsImport,
  AccountSettingsState,
  AccountSettingsUpdate,
  AskSighting,
  AskSightingsResult,
  AskSightingsUpdate,
  LiveAsk,
  MarketSyncFormId,
  NotificationsSeenUpdate,
  SoldElsewhereClaimResult,
  SoldElsewhereMarket,
  SoldElsewhereNotice,
  SoldElsewhereNoticePatch,
  SoldElsewhereNoticeUpdate,
  SoldElsewhereNoticesResult,
  SoldElsewhereStatus,
  SoldElsewhereToastsResult,
} from './account-settings';
export {
  ACCOUNT_CURRENCIES,
  ACCOUNT_SETTINGS_BOUNDS,
  ACCOUNT_SETTINGS_DEFAULTS,
  ASK_SIGHTING_PLATFORMS,
  ASK_SIGHTING_SAME_PRICE,
  MARKET_SYNC_FORM_IDS,
  SOLD_ELSEWHERE_STATUSES,
  SOLD_ELSEWHERE_TTL_MS,
  STEAM_TRADE_URL_PATTERN,
  isMarketSyncFormId,
  isSteamTradeUrl,
  marketSyncTargets,
  parseSteamId64,
} from './account-settings';

// The Market page's saved filters (QUICK-224), kept with the account's settings.
export type {
  MarketCategory,
  MarketFilters,
  MarketPhase,
  MarketSort,
  MarketSource,
  MarketView,
  MarketViews,
  MarketWear,
} from './market-views';
export type {
  MarketFeedAnswer,
  MarketFeedBudgetView,
  MarketFeedBufferRequest,
  MarketFeedBufferResponse,
  MarketFeedConfig,
  MarketFeedIssue,
  MarketFeedIssueKind,
  MarketFeedLatencyView,
  MarketFeedListing,
  MarketFeedPlatform,
  MarketFeedPlatformState,
  MarketFeedPlatformStatus,
  MarketFeedRequest,
  MarketFeedRow,
  MarketFeedRowFields,
  MarketFeedSourceState,
  MarketFeedStartError,
  MarketFeedState,
  MarketFeedStateResponse,
  MarketFeedSticker,
  MarketFeedUpdate,
} from './market-feed';
export {
  detectMarketFeedIssue,
  isMarketFeedCoverageAtRisk,
  MARKET_FEED_BACKOFF_MS,
  MARKET_FEED_BUFFER_MAX,
  MARKET_FEED_BUFFER_MS,
  MARKET_FEED_COVERAGE_MS,
  MARKET_FEED_ERROR_BACKOFF_MS,
  MARKET_FEED_LEASE_MS,
  MARKET_FEED_OPERATION_IDS,
  MARKET_FEED_PAGE_MAX,
  MARKET_FEED_PLATFORMS,
  MARKET_FEED_RESET_MARGIN_MS,
  MARKET_FEED_SEEN_GRACE_MS,
  MARKET_FEED_SOURCE_PLATFORM,
  marketFeedBackoffMs,
  marketFeedPercentile,
  marketFeedRetryAt,
  parseMarketFeedRows,
} from './market-feed';
export type { CsfloatFeedContext, CsfloatFeedDecision, CsfloatFeedLedger } from './market-feed-budget';
export {
  clampCsfloatFeedShare,
  CSFLOAT_BUDGET_STALE_MS,
  CSFLOAT_FEED_DEFAULT_SHARE,
  CSFLOAT_FEED_FALLBACK_INTERVAL_MS,
  CSFLOAT_FEED_MAX_SHARE,
  CSFLOAT_FEED_MIN_INTERVAL_MS,
  CSFLOAT_FEED_MIN_SHARE,
  csfloatFeedAllowance,
  csfloatFeedHeadroom,
  csfloatFeedIntervalMs,
  decideCsfloatFeed,
  EMPTY_CSFLOAT_FEED_LEDGER,
  FEED_FOREGROUND_YIELD_MS,
  isCsfloatListingsBucket,
  observeCsfloatListingsAnswer,
} from './market-feed-budget';
export type { CsfloatRateLimit } from './csfloat-rate-limit';
export { csfloatRateLimitResetAt, isLowCsfloatBudget, parseCsfloatRateLimit } from './csfloat-rate-limit';
export {
  MARKET_CATEGORIES,
  MARKET_FILTERS_DEFAULTS,
  MARKET_PHASES,
  MARKET_SORTS,
  MARKET_SOURCES,
  MARKET_VIEWS_BOUNDS,
  MARKET_VIEWS_DEFAULTS,
  MARKET_WEARS,
} from './market-views';

// QTS buy orders (QUICK-232): the account's rules that buy from the live feed, and the pure matcher the preview and the
// engine share.
export type {
  BuyOrderMode,
  BuyOrderRule,
  BuyOrderRuleCreate,
  BuyOrderRuleFields,
  BuyOrderRuleToggle,
  BuyOrderRuleUpdate,
  BuyOrdersBudgetUpdate,
  BuyOrdersReorder,
  BuyOrdersSetResult,
  BuyOrdersSnapshot,
  BuyOrdersState,
} from './buy-orders';
export {
  BUY_ORDER_BOUNDS,
  BUY_ORDER_ERRORS,
  BUY_ORDER_MODES,
  isHundredthPercent,
  isTenthPercent,
  parseBuyOrderRule,
  parseBuyOrderRuleFields,
  parseBuyOrdersSnapshot,
  parseBuyOrdersState,
} from './buy-orders';
export type {
  BuyOrderListing,
  BuyOrderListingSticker,
  BuyOrderMatch,
  BuyOrderMatchContext,
  BuyOrderMismatch,
  BuyOrderMismatchCode,
  ParsedItemName,
} from './buy-order-match';
export {
  BUY_ORDER_IDENTITY_MISMATCHES,
  isNearMiss,
  itemMatches,
  matchBuyOrderRule,
  parseItemName,
  wearOfFloatValue,
} from './buy-order-match';
// The buy-order engine (QUICK-233): lease, spend, guards, the page ↔ extension relay and the activity log.
export type {
  BuyOrderActivity,
  BuyOrderActivityKind,
  BuyOrderActivityListing,
  BuyOrderActivityValues,
  BuyOrderAttemptOpenRequest,
  BuyOrderAttemptOpenResponse,
  BuyOrderEngineErrorCode,
  BuyOrderGuardCode,
  BuyOrderGuardInput,
  BuyOrderGuardRefusal,
  BuyOrderRuleRuntime,
  BuyOrderRuleSpend,
  BuyOrdersEngineAnswer,
  BuyOrdersEngineLease,
  BuyOrdersEnginePush,
  BuyOrdersEngineRequest,
  BuyOrdersEngineRequestKind,
  BuyOrdersEngineState,
  BuyOrdersEngineStatus,
  BuyOrdersEngineView,
  BuyOrdersLeasePush,
  BuyOrdersLeaseRelease,
  BuyOrdersLeaseRequest,
  BuyOrdersSpend,
} from './buy-order-engine';
export {
  BUY_ORDER_ACCOUNT_REFRESH_MS,
  BUY_ORDER_ACCOUNT_TTL_MS,
  BUY_ORDER_ACTIVITY_KINDS,
  BUY_ORDER_ACTIVITY_MAX,
  BUY_ORDER_DEVICE_LABEL_MAX,
  BUY_ORDER_ENGINE_ERRORS,
  BUY_ORDER_ENGINE_STATES,
  BUY_ORDER_ESTIMATE_HIT_TTL_MS,
  BUY_ORDER_ESTIMATE_MISS_TTL_MS,
  BUY_ORDER_ESTIMATE_REASONS,
  BUY_ORDER_FAILURE_LIMIT,
  BUY_ORDER_FAILURE_OUTCOMES,
  BUY_ORDER_LEASE_MARGIN_MS,
  BUY_ORDER_LEASE_RENEW_MS,
  BUY_ORDER_LEASE_TTL_MS,
  BUY_ORDER_OWN_TIME_MS,
  BUY_ORDER_PHASE_BY_PAINT_INDEX,
  BUY_ORDER_SPENT_STATES,
  addToSpend,
  buyOrderActivityKindOf,
  buyOrderFailureEffect,
  buyOrderListingFromFeedEntry,
  buyOrderListingKey,
  buyOrderNeedsEstimate,
  checkBuyOrderGuards,
  cleanDeviceLabel,
  guardActivityValues,
  isBuyOrderDeviceId,
  isBuyOrderEngineErrorCode,
  isBuyOrderEstimateCandidate,
  localLeaseUntil,
  parseBuyOrderActivity,
  parseBuyOrderAttemptOpenResponse,
  parseBuyOrdersEngineAnswer,
  parseBuyOrdersEngineStatus,
  parseBuyOrdersEngineView,
  parseBuyOrdersLeasePush,
  parseBuyOrdersSpend,
  ruleSpendOf,
  serverClockOffset,
  utcDayOf,
  utcDayStart,
} from './buy-order-engine';

// Prepaid billing (QUICK-134): operator grants and on-chain invoices.
export type {
  BillingClaimRequest,
  BillingClaimResponse,
  BillingInvoicePayment,
  BillingInvoiceRequest,
  BillingInvoiceStatus,
  BillingInvoiceView,
  BillingNetwork,
  BillingPaymentErrorCode,
  BillingPaymentErrorDetails,
  BillingPaymentInfo,
  BillingPaymentOption,
  BillingPaymentSource,
  BillingPaymentView,
  BillingPlan,
  BillingResponse,
  BillingStatus,
  BillingToken,
} from './billing';
export { BILLING_NETWORK_NAMES, BILLING_TOKENS, isBillingNetwork, isBillingToken } from './billing';

// The admin panel: users, limits, moderation and ban (QUICK-165).
export type {
  AccountBan,
  AdminAction,
  AdminActionResponse,
  AdminAuditDetails,
  AdminAuditEntry,
  AdminAuditListResponse,
  AdminAuditOutcome,
  AdminBillingPayment,
  AdminBillingRevocation,
  AdminExtendTrialRequest,
  AdminGrantPaidDaysRequest,
  AdminMeResponse,
  AdminReasonRequest,
  AdminRevokePaymentRequest,
  AdminRevokePreview,
  AdminSaleHistoryThrottle,
  AdminSaleHistoryView,
  AdminSetLimitsRequest,
  AdminUserDetail,
  AdminUserListItem,
  AdminUserListResponse,
  SaleHistoryDayUsage,
  SaleHistoryLimits,
  UserFlag,
} from './admin';
export {
  ACCOUNT_BANNED,
  ADMIN_PAGE_SIZE,
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
  ADMIN_REQUIRED,
  ADMIN_ORIGIN_REQUIRED,
  ADMIN_TRIAL_EXTENSION_MAX_DAYS,
  SALE_HISTORY_LIMIT_MAX_ITEMS_PER_DAY,
  SALE_HISTORY_LIMIT_MAX_REQUESTS_PER_DAY,
} from './admin';


export type { BlueGemColours, BlueGemResponse, BlueGemSale, MarketConfigResponse } from './market-data';
export { BLUE_GEM_MAX_SALES, PAINT_SEED_MAX } from './market-data';
// Public Steam profiles (name, avatar) for trade-history counterparties; display only.
export type { SteamProfile, SteamProfilesRequest, SteamProfilesResponse } from './steam-profiles';
export { STEAM_ID64_PATTERN, STEAM_ID64_PATTERN_SOURCE, STEAM_PROFILES_MAX_IDS } from './steam-profiles';
// The user's own listing changes no inventory fetch has read yet, kept on the account (QUICK-191, QUICK-210).
export type {
  ListingUpdate,
  ListingUpdateRecord,
  ListingUpdatesAppend,
  ListingUpdatesForget,
  ListingUpdatesImport,
  ListingUpdatesState,
} from './listing-updates';
export { LISTING_UPDATES_LIMITS } from './listing-updates';
// The sell-mode panel caches kept on the account (QUICK-210).
export type { PanelCacheEntry, PanelCacheKind, PanelCacheReadResponse, PanelCacheWriteRequest } from './panel-cache';
export {
  PANEL_CACHE_KINDS,
  PANEL_CACHE_MAX_PAYLOAD_BYTES,
  PANEL_CACHE_MAX_SCOPE_LENGTH,
  PANEL_CACHE_RETAIN_MS,
} from './panel-cache';

// Buying on the Market page (QUICK-226): the page → extension request, the executor's result, the pure request builders,
// re-read checks and answer classifiers of the money path, and the server's buy-attempt journal.
export type {
  CsMoneyHoldVerdict,
  MarketAccountCheck,
  MarketBuyAnswer,
  MarketBuyHttpRequest,
  MarketBuyNext,
  MarketBuyOrigin,
  MarketBuyOutcome,
  MarketBuyRaw,
  MarketBuyRequest,
  MarketBuyResult,
  MarketBuyVerdict,
  MarketListingCheck,
} from './market-buy';
export {
  MARKET_BUY_BOTS_ENABLED,
  MARKET_BUY_BOUGHT_HOLD_MS,
  MARKET_BUY_BRIDGE_TIMEOUT_MS,
  MARKET_BUY_CHECK_URLS,
  MARKET_BUY_CSMONEY_MARKET_ENABLED,
  MARKET_BUY_DIGEST_MAX_LENGTH,
  MARKET_BUY_LISTING_READ_TIMEOUT_MS,
  MARKET_BUY_MAX_PRICE_CENTS,
  MARKET_BUY_OUTCOMES,
  MARKET_BUY_READ_TIMEOUT_MS,
  MARKET_BUY_REQUEST_TIMEOUT_MS,
  MARKET_BUY_TOP_UP_URLS,
  MARKET_BUY_UNKNOWN_HOLD_MS,
  buyAnswerDigest,
  centsToUsd,
  checkCsMoneyAccount,
  checkCsMoneyBotRow,
  checkCsMoneySellOrder,
  checkCsfloatAccount,
  checkCsfloatListing,
  classifyCsMoneyConfirmAnswer,
  classifyCsMoneyHoldAnswer,
  classifyCsMoneyPurchaseAnswer,
  classifyCsfloatBuyAnswer,
  csMoneyAccountReadRequest,
  csMoneyAnswerCode,
  csMoneyBotConfirmRequest,
  csMoneyBotDeclineRequest,
  csMoneyBotHoldRequest,
  csMoneyBotReadRequest,
  csMoneyPurchaseRequest,
  csMoneySellOrderReadRequest,
  csfloatAccountReadRequest,
  csfloatBuyRequest,
  csfloatListingReadRequest,
  isMarketBuyOutcome,
  isMarketBuyPriceCents,
  jsonObjectAfterKey,
  marketBuyRetryAt,
  parseMarketBuyRequest,
  parseMarketBuyResult,
  usdToWholeCents,
} from './market-buy';
export type {
  MarketBuyAttemptOpen,
  MarketBuyAttemptOpenResponse,
  MarketBuyAttemptRow,
  MarketBuyAttemptSettle,
  MarketBuyAttemptState,
  MarketBuyAttemptsResponse,
} from './market-buy-journal';
export {
  MARKET_BUY_ATTEMPT_RETAIN_MS,
  MARKET_BUY_ATTEMPTS_READ_LIMIT,
  MARKET_BUY_PENDING_STALE_MS,
} from './market-buy-journal';

// Interface languages (QUICK-189): the locale list, native names, the NEXT_LOCALE cookie and the language-tag matcher,
// shared by the web app, the landing and the extension.
export type { Locale } from './i18n';
export {
  LOCALES,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  LOCALE_COOKIE_NAME,
  LOCALE_NATIVE_NAMES,
  SOURCE_LOCALE,
  canonicalLocale,
  isLocale,
  localeCookieDomain,
  matchLocale,
  parseAcceptLanguage,
  parseEnabledLocales,
  resolveLocale,
  serializeLocaleCookie,
} from './i18n';

export type {
  AdminDiagnosticsResponse,
  AdminDiagnosticsFilter,
  ApiDiagnostic,
  ClientErrorDiagnostic,
  DiagnosticEvent,
  DiagnosticEventCommon,
  DiagnosticEventsRequest,
  DiagnosticEventsResponse,
  DiagnosticKind,
  DiagnosticUsageDay,
  ExtensionDiagnostic,
  ExtensionDiagnosticEvent,
  ExtensionJournalEntry,
  InventoryDiagnostic,
  InventoryDiagnosticStep,
  InventoryReadStop,
  ProxyDiagnostic,
  SchedulerDiagnostic,
  SchedulerDiagnosticDraft,
  SchedulerDiagnosticOutcome,
  StoredDiagnosticEvent,
} from './diagnostics';
export {
  DIAGNOSTIC_KINDS,
  DIAGNOSTICS_LIMITS,
  EXTENSION_DIAGNOSTIC_EVENTS,
  EXTENSION_JOURNAL_LIMITS,
  INVENTORY_DIAGNOSTIC_STEPS,
  isJournalOwner,
  diagnosticCode,
  INVENTORY_READ_STOPS,
  NO_ANALYTICS_HEADER,
  redactDiagnosticPath,
  parseExtensionJournalEntries,
  redactDiagnosticRoute,
  redactQuotedValues,
  sanitizeDiagnosticText,
  SCHEDULER_DIAGNOSTIC_OUTCOMES,
} from './diagnostics';
export type {
  AdminMfaStatusResponse,
  AdminMfaSetupResponse,
  AdminMfaBackupCodesResponse,
  AdminMfaSuccessResponse,
  AdminMfaCodeRequest,
  AdminMfaVerifyRequest,
  AdminMfaErrorCode,
  AdminMfaError,
} from './admin-mfa';
export {
  ADMIN_MFA_ERROR_CODES,
  parseAdminMfaStatus,
  parseAdminMfaSetup,
  parseAdminMfaBackupCodes,
  parseAdminMfaSuccess,
  parseAdminMfaError,
} from './admin-mfa';

// Referrals (QUICK-264): invite codes and day rewards.
export * from './referrals';
export * from './support';
export * from './support-stream';
