/**
 * The Market live feed (QUICK-216 / QUICK-231, R-E1–R-E6): the extension's background reads the newest listings of
 * CSFloat (buy now) and cs.money (market and bots), keeps each listing once, and holds the last hour of them in a
 * compact buffer the web reads (the Market page's Live mode, the buy-order preview of QUICK-232, the buy-order engine
 * of QUICK-233 later). Pure and browser-API free: the extension and the web share these types and readers.
 *
 * Requests are built by the web (`apps/web/src/lib/market/market-feed-requests.ts`) and must match the source's own
 * `schedule: 'check'` operation (`MARKET_FEED_OPERATION_IDS`), so the feed can later run without a tab (QUICK-235).
 */
import type { MarketSource } from './market-views';

export type MarketFeedPlatform = 'csfloat.com' | 'cs.money';

export const MARKET_FEED_PLATFORMS: readonly MarketFeedPlatform[] = ['csfloat.com', 'cs.money'];

export const MARKET_FEED_SOURCE_PLATFORM: Readonly<Record<MarketSource, MarketFeedPlatform>> = {
  csfloat: 'csfloat.com',
  'csmoney-market': 'cs.money',
  'csmoney-bots': 'cs.money',
};

/** The one operation each source's feed request must match (`PLATFORM_OPERATIONS`, `schedule: 'check'`). */
export const MARKET_FEED_OPERATION_IDS: Readonly<Record<MarketSource, string>> = {
  csfloat: 'csfloat.listings.newest',
  'csmoney-market': 'csmoney.market.newest',
  'csmoney-bots': 'csmoney.bots.newest',
};

/** How long the buffer keeps a listing after it was first seen (R-F6: "the last hour of the feed"). */
export const MARKET_FEED_BUFFER_MS = 60 * 60_000;
/** A listing still in the answers stays in the buffer this long after it was last seen, so it is never "new" twice. */
export const MARKET_FEED_SEEN_GRACE_MS = 10 * 60_000;
/** At most this many listings in the buffer (the oldest first seen leave first). */
export const MARKET_FEED_BUFFER_MAX = 10_000;
/** The page's grid keeps at most this many feed cards (R-A6). */
export const MARKET_FEED_PAGE_MAX = 500;

export const MARKET_FEED_COVERAGE_MS = 40_000;
/** A page keeps the feed running by renewing this lease; a closed tab drops it at once, a silent one when it ends. */
export const MARKET_FEED_LEASE_MS = 3 * 60_000;

/** The waits after the 1st, 2nd and every later captcha, limit or block in a row (R-E5: 1 → 5 → 15 min, then every 15). */
export const MARKET_FEED_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
/** The waits after other failures in a row (a 5xx, no answer, an unreadable page): a live feed retries sooner. */
export const MARKET_FEED_ERROR_BACKOFF_MS = [15_000, 60_000, 5 * 60_000] as const;
/** After a named reset, one more moment: the reset is in whole seconds (QUICK-204). */
export const MARKET_FEED_RESET_MARGIN_MS = 2_000;

/** One feed request: a GET the web built, newest first and unfiltered (one feed serves the page and every rule). */
export interface MarketFeedRequest {
  url: string;
  method: 'GET';
}

/** What the page asks the extension to read (`market_feed_start`). */
export interface MarketFeedConfig {
  sources: Array<{ source: MarketSource; request: MarketFeedRequest }>;
  /**
   * The share of what is left of CSFloat's `/listings` window the feed may spend (R-E2): the user's choice on the Market
   * page, 0.1–0.9 in steps of 0.1. Omitted or unreadable = `CSFLOAT_FEED_DEFAULT_SHARE` (0.6); the extension clamps
   * any other number to `CSFLOAT_FEED_MIN_SHARE`–`CSFLOAT_FEED_MAX_SHARE`, so selling, Competitors and buying keep the rest.
   */
  csfloatShare?: number;
}

/** A sticker as the buffer keeps it: what a buy-order rule reads (name, slot, scrape, the marketplace's price). */
export interface MarketFeedSticker {
  name: string;
  slot?: number;
  /** Scrape: CSFloat 0–1, cs.money 0–100 (as each marketplace sends it). */
  wear?: number;
  /** The marketplace's own price of the sticker, USD cents. */
  priceCents?: number;
}

/**
 * One listing the feed saw, compact: what a buy-order rule needs to decide (QUICK-232 preview, QUICK-233 matching),
 * never the seller or the raw answer. Prices in USD cents.
 */
export interface MarketFeedListing {
  /** `<source>:<listing id>`, the same key the Market page's cards use. */
  key: string;
  source: MarketSource;
  /** CSFloat's listing id, cs.money's sell-order id (market) or item id (bots). */
  listingId: string;
  marketHashName: string;
  priceCents: number;
  float: number | null;
  paintSeed: number | null;
  /** CSFloat's paint index and def index (cs.money does not send them). */
  paintIndex: number | null;
  defIndex: number | null;
  isStatTrak: boolean;
  isSouvenir: boolean;
  stickers: MarketFeedSticker[];
  /** The Steam image path or URL the marketplace sent, for a preview row. */
  image: string | null;
  /** When the listing went up on the marketplace (epoch ms); only CSFloat says. */
  listedAt: number | null;
  /** When the answer that first carried it arrived (epoch ms, the extension's clock). */
  firstSeenAt: number;
  /** When an answer last carried it. */
  lastSeenAt: number;
  /** firstSeenAt − listedAt when the feed read without a pause before (R-E6); null otherwise. */
  latencyMs: number | null;
  /** In the first answer after the feed started or resumed: on the market before the feed looked, not a new arrival. */
  baseline: boolean;
  /** Missing from a later answer where it would have been (CSFloat: inside the answer's time span): sold or delisted. */
  goneAt: number | null;
  /** Increases by one per new listing in this extension session: the page asks for what came after the last one it has. */
  seq: number;
}

/** A new listing for the page: the compact entry plus the marketplace's row, which the web reads into a card. */
export interface MarketFeedRow {
  listing: MarketFeedListing;
  raw: unknown;
}

/**
 * captcha: cs.money's 4030 (HTTP 403 or 200) or Cloudflare's challenge (`cf-mitigated`); rate-limited: 429; blocked: 403
 * without a limit (Cloudflare or a proxy in front); no-access: the user has not granted the marketplace; refused: the
 * extension's allowlist refused the request; error: anything else (5xx, no answer, an unreadable page).
 */
export type MarketFeedIssueKind = 'captcha' | 'rate-limited' | 'blocked' | 'no-access' | 'refused' | 'error';

export interface MarketFeedIssue {
  kind: MarketFeedIssueKind;
  status?: number;
  /** When the marketplace said its limit ends (epoch ms), if it did. */
  resetAt?: number;
}

/**
 * running: polls on its interval; held: CSFloat waits for its budget, the page's own requests or a reservation;
 * paused: an issue, asks again at `retryAt` (never a permanent stop); off: not in the page's config.
 */
export type MarketFeedPlatformStatus = 'running' | 'held' | 'paused' | 'off';

export interface MarketFeedPlatformState {
  status: MarketFeedPlatformStatus;
  issue?: MarketFeedIssue;
  /** Failures in a row: the backoff step. */
  attempts: number;
  retryAt?: number;
  /** Why CSFloat is held. */
  heldBy?: 'budget' | 'foreground';
  /** The interval it polls each source at now (ms); null while unknown. */
  intervalMs: number | null;
  /** When it asks next (epoch ms). */
  nextAt: number | null;
  lastPollAt: number | null;
}

export interface MarketFeedSourceState {
  polls: number;
  lastPollAt: number | null;
  lastOkAt: number | null;
  /** New listings it brought. */
  newListings: number;
  /** Answers that shared no listing with the one before: the feed may have missed some in between (R-E3). */
  gaps: number;
}

/** CSFloat's `/listings` window as the extension sees it from every answer it relays (the page's and the feed's). */
export interface MarketFeedBudgetView {
  limit: number;
  remaining: number;
  resetAt: number;
  observedAt: number;
  /** What was left of the window when the feed first saw it: the share is taken of this. */
  windowBudget: number;
  /** Requests the feed sent in this window. */
  feedSpent: number;
  /** Requests the feed may still send in this window. */
  feedAllowance: number;
  /** Requests higher-priority work (a buy) holds. */
  reserved: number;
}

/** Listing creation → first seen in a feed answer (R-E6), over recent new listings. */
export interface MarketFeedLatencyView {
  samples: number;
  p50Ms: number;
  p90Ms: number;
}

export interface MarketFeedState {
  running: boolean;
  startedAt: number | null;
  /** The extension's clock when the state was built. */
  now: number;
  csfloatShare: number;
  platforms: Record<MarketFeedPlatform, MarketFeedPlatformState>;
  sources: Partial<Record<MarketSource, MarketFeedSourceState>>;
  csfloatBudget: MarketFeedBudgetView | null;
  latency: Partial<Record<MarketSource, MarketFeedLatencyView>>;
  /** CSFloat polls slower than 50 newest listings cover (R-E3). */
  coverageAtRisk: boolean;
  /** The newest listing's seq. */
  seq: number;
  buffered: number;
  /** The oldest first-seen time the buffer still holds; null when empty. */
  coveredSince: number | null;
}

/** `market_feed_start` / `_stop` / `_retry` answer: the state, or why the start was refused. */
export interface MarketFeedStateResponse {
  requestId: string;
  state: MarketFeedState | null;
  error?: MarketFeedStartError;
}

export type MarketFeedStartError = 'invalid_config' | 'operation_refused' | 'no_sources';

/** `get_market_feed` answer and the `market_feed_update` push: new listings after `sinceSeq` and listings gone. */
export interface MarketFeedUpdate {
  /** Echoes `get_market_feed`; absent on a push. */
  requestId?: string;
  state: MarketFeedState;
  rows: MarketFeedRow[];
  /** Keys found sold or delisted (this poll on a push; the last minutes on a read). */
  gone: string[];
}

/** `get_market_feed_buffer` (QUICK-232 preview): the compact listings first seen at or after `sinceMs`. */
export interface MarketFeedBufferRequest {
  requestId: string;
  /** Epoch ms on the extension's clock; omitted = the whole buffer (the last hour). */
  sinceMs?: number;
  sources?: readonly MarketSource[];
}

export interface MarketFeedBufferResponse {
  requestId: string;
  now: number;
  running: boolean;
  /** The oldest first-seen time the buffer holds: the preview covers from here, not always a full hour. */
  coveredSince: number | null;
  /** Oldest first. */
  listings: MarketFeedListing[];
}

// ─── Reading an answer ──────────────────────────────────────────────────────

/** The fields of a relayed answer the feed reads (`proxy_response`, `ProxyResult`). */
export interface MarketFeedAnswer {
  ok: boolean;
  status: number;
  data: unknown;
  headers?: Record<string, string>;
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function numberOf(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOf(value: unknown): number | null {
  const parsed = numberOf(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

const usdCents = (usd: number) => Math.round(usd * 100);

/** cs.money's code inside an answer: `{error: N}` (HTTP 200) or `{errors: [{code: N}]}`. */
function csMoneyCode(data: unknown): number | null {
  if (!isRecord(data)) return null;
  if (typeof data['error'] === 'number') return data['error'];
  const errors = data['errors'];
  const first = Array.isArray(errors) ? errors[0] : undefined;
  return isRecord(first) && typeof first['code'] === 'number' ? first['code'] : null;
}

/** cs.money answers "nothing matches" as `{error: 2}` (HTTP 200) or 400 `{errors: [{code: 2}]}`: an empty page. */
function isCsMoneyEmpty(answer: MarketFeedAnswer): boolean {
  return csMoneyCode(answer.data) === 2 && (answer.status === 200 || answer.status === 400);
}

/** The listings part of a parsed row: everything but the times the buffer sets. */
export type MarketFeedRowFields = Omit<
  MarketFeedListing,
  'firstSeenAt' | 'lastSeenAt' | 'latencyMs' | 'baseline' | 'goneAt' | 'seq'
>;

function csfloatStickers(value: unknown): MarketFeedSticker[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MarketFeedSticker[] => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || !entry['name']) return [];
    const slot = integerOf(entry['slot']);
    const wear = numberOf(entry['wear']);
    const reference = isRecord(entry['reference']) ? numberOf(entry['reference']['price']) : null;
    return [
      {
        name: entry['name'],
        ...(slot !== null ? { slot } : {}),
        ...(wear !== null ? { wear } : {}),
        ...(reference !== null && reference > 0 ? { priceCents: Math.round(reference) } : {}),
      },
    ];
  });
}

function csfloatRow(raw: unknown): MarketFeedRowFields | null {
  if (!isRecord(raw) || !isRecord(raw['item'])) return null;
  const listingId = idOf(raw['id']);
  const price = numberOf(raw['price']);
  const item = raw['item'];
  const name = typeof item['market_hash_name'] === 'string' ? item['market_hash_name'] : '';
  if (!listingId || price === null || !(price > 0) || !name) return null;
  const created = typeof raw['created_at'] === 'string' ? Date.parse(raw['created_at']) : Number.NaN;
  return {
    key: `csfloat:${listingId}`,
    source: 'csfloat',
    listingId,
    marketHashName: name,
    priceCents: Math.round(price),
    float: numberOf(item['float_value']),
    paintSeed: integerOf(item['paint_seed']),
    paintIndex: integerOf(item['paint_index']),
    defIndex: integerOf(item['def_index']),
    isStatTrak: item['is_stattrak'] === true || name.startsWith('StatTrak™'),
    isSouvenir: item['is_souvenir'] === true || name.startsWith('Souvenir '),
    stickers: csfloatStickers(item['stickers']),
    image: typeof item['icon_url'] === 'string' && item['icon_url'] ? item['icon_url'] : null,
    listedAt: Number.isFinite(created) ? created : null,
  };
}

function csMoneyStickers(value: unknown): MarketFeedSticker[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, slot): MarketFeedSticker[] => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || !entry['name']) return [];
    const pricing = isRecord(entry['pricing']) ? entry['pricing'] : {};
    const price = numberOf(entry['price']) ?? numberOf(pricing['default']);
    const wear = numberOf(entry['wear']);
    return [
      {
        name: entry['name'],
        slot,
        ...(wear !== null ? { wear } : {}),
        ...(price !== null && price > 0 ? { priceCents: usdCents(price) } : {}),
      },
    ];
  });
}

/** The ask as cs.money shows it to a buyer: the first positive of the market price, sell, bot and flat price. */
function csMoneyPriceUsd(raw: Record<string, unknown>): number | null {
  const pricing = isRecord(raw['pricing']) ? raw['pricing'] : {};
  for (const candidate of [pricing['computed'], raw['sellPrice'], raw['botPrice'], raw['price']]) {
    const value = numberOf(candidate);
    if (value !== null && value > 0) return value;
  }
  const fallback = numberOf(pricing['default']) ?? numberOf(raw['defaultPrice']);
  return fallback !== null && fallback > 0 ? fallback : null;
}

function csMoneyRow(source: 'csmoney-market' | 'csmoney-bots', raw: unknown): MarketFeedRowFields | null {
  if (!isRecord(raw)) return null;
  // The market row's own id is its sell order; a bot row's id is cs.money's item id (as the Market page keys them).
  const listingId = idOf(raw['id']);
  const asset = isRecord(raw['asset']) ? raw['asset'] : {};
  const names = isRecord(asset['names']) ? asset['names'] : {};
  const nameValue = names['full'] ?? raw['fullName'] ?? raw['name'];
  const name = typeof nameValue === 'string' ? nameValue : '';
  const price = csMoneyPriceUsd(raw);
  if (!listingId || !name || price === null) return null;
  const images = isRecord(asset['images']) ? asset['images'] : {};
  const imageValue = images['steam'] ?? raw['steamImg'] ?? asset['image'];
  return {
    key: `${source}:${listingId}`,
    source,
    listingId,
    marketHashName: name,
    priceCents: usdCents(price),
    float: numberOf(asset['float'] ?? raw['float']),
    paintSeed: integerOf(asset['paintseed'] ?? raw['pattern']),
    paintIndex: null,
    defIndex: null,
    isStatTrak: Boolean(asset['isStatTrak'] ?? raw['isStatTrak']) || name.startsWith('StatTrak™'),
    isSouvenir: Boolean(asset['isSouvenir'] ?? raw['isSouvenir']) || name.startsWith('Souvenir '),
    stickers: csMoneyStickers(asset['stickers'] ?? raw['stickers']),
    image: typeof imageValue === 'string' && imageValue ? imageValue : null,
    listedAt: null,
  };
}

/**
 * The rows of one feed answer of `source`, each with its compact fields; null when the answer is not a page of
 * listings at all (an error page, a captcha). An unreadable row is skipped; cs.money's "nothing matches" is an empty page.
 */
export function parseMarketFeedRows(
  source: MarketSource,
  answer: MarketFeedAnswer
): Array<{ fields: MarketFeedRowFields; raw: unknown }> | null {
  if (source !== 'csfloat' && isCsMoneyEmpty(answer)) return [];
  if (!answer.ok) return null;
  const { data } = answer;
  const key = source === 'csfloat' ? 'data' : 'items';
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data[key])
      ? (data[key] as unknown[])
      : null;
  if (!rows) return null;
  return rows.flatMap((raw) => {
    const fields = source === 'csfloat' ? csfloatRow(raw) : csMoneyRow(source, raw);
    return fields ? [{ fields, raw }] : [];
  });
}

// ─── Issues and backoff (R-E5) ──────────────────────────────────────────────

/** `x-ratelimit-reset` (UNIX seconds) or `retry-after` (seconds) of a 429, on this computer's clock; undefined without. */
function namedResetAt(headers: Record<string, string> | undefined, now: number): number | undefined {
  const serverNow = Date.parse(headers?.['date'] ?? '');
  const reset = Number(headers?.['x-ratelimit-reset']);
  const candidates: number[] = [];
  if (Number.isSafeInteger(reset) && reset >= 1_000_000_000 && reset < 10_000_000_000) {
    candidates.push(Number.isFinite(serverNow) ? now + reset * 1000 - serverNow : reset * 1000);
  }
  const retryAfter = headers?.['retry-after']?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) candidates.push(now + Number(retryAfter) * 1000);
  return candidates.length ? Math.max(...candidates) : undefined;
}

/** A failed or unusable answer; null for an answer to read (cs.money's empty page included). */
export function detectMarketFeedIssue(
  platform: MarketFeedPlatform,
  answer: MarketFeedAnswer,
  now: number
): MarketFeedIssue | null {
  if (answer.error?.startsWith('operation_refused')) return { kind: 'refused', status: answer.status };
  if (answer.error?.startsWith('permission_denied')) return { kind: 'no-access', status: answer.status };
  const challenge = answer.headers?.['cf-mitigated']?.toLowerCase() === 'challenge';
  if (challenge || (platform === 'cs.money' && csMoneyCode(answer.data) === 4030)) {
    return { kind: 'captcha', status: answer.status };
  }
  if (answer.status === 429) {
    const resetAt = namedResetAt(answer.headers, now);
    return resetAt === undefined
      ? { kind: 'rate-limited', status: 429 }
      : { kind: 'rate-limited', status: 429, resetAt };
  }
  if (answer.status === 403 || answer.status === 401) return { kind: 'blocked', status: answer.status };
  if (platform === 'cs.money' && isCsMoneyEmpty(answer)) return null;
  // cs.money hides other failures in an HTTP 200 `{error: N}`.
  if (!answer.ok || (platform === 'cs.money' && csMoneyCode(answer.data) !== null)) {
    return { kind: 'error', status: answer.status };
  }
  return null;
}

/** Captcha, limits and blocks back off 1 → 5 → 15 min (R-E5); other failures retry sooner. */
export function marketFeedBackoffMs(kind: MarketFeedIssueKind, attempt: number): number {
  const steps: readonly number[] = kind === 'error' ? MARKET_FEED_ERROR_BACKOFF_MS : MARKET_FEED_BACKOFF_MS;
  const index = Math.min(Math.max(1, Math.floor(attempt)), steps.length) - 1;
  return steps[index] ?? steps[steps.length - 1] ?? MARKET_FEED_BACKOFF_MS[2];
}

/**
 * When a paused platform asks again: after a named reset (plus a margin), else after the backoff of this failure in a
 * row (`attempt` 1 = the first). Always a time: the feed never stops for good on an issue.
 */
export function marketFeedRetryAt(issue: MarketFeedIssue, attempt: number, now: number): number {
  if (issue.resetAt !== undefined && issue.resetAt > now) return issue.resetAt + MARKET_FEED_RESET_MARGIN_MS;
  return now + marketFeedBackoffMs(issue.kind, attempt);
}

/** R-E3: CSFloat polled slower than its 50 newest listings last can miss listings in between. */
export function isMarketFeedCoverageAtRisk(intervalMs: number | null): boolean {
  return intervalMs !== null && intervalMs > MARKET_FEED_COVERAGE_MS;
}

/** The p-th percentile (0–1) of `values`, nearest rank; null for none. */
export function marketFeedPercentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}
