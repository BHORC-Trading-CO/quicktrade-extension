/**
 * Buying on the Market page (QUICK-226, epic QUICK-216 R-C1–R-C5, R-N1): what the web asks the extension's buy
 * executor, what the executor answers, and the pure pieces of the money path both sides share. The executor
 * (`apps/extension/background/market-buy/`) is the only code that sends a buy request; everything here is data and
 * pure functions, so the requests and their answers can be tested without a browser.
 *
 * Money rules (R-N1): every amount is integer USD cents. The buy request carries exactly the price the user confirmed
 * (`priceCents`): CSFloat takes it as `total_price` in cents; cs.money takes USD, which is `priceCents / 100` and is
 * sent only after the re-read shows the market quotes exactly that number. A request whose outcome is unknown is
 * never sent again by QTS.
 *
 * Endpoints, bodies and answer codes follow spike S1 (QUICK-220, `spikes/S1-QUICK-220-buy-flows.md`). What S1 marks as
 * inferred is classified conservatively: an answer QTS cannot read as a definite refusal is `unknown`.
 */
import { MARKET_SOURCES, type MarketSource } from './market-views';
import type { OperationRequest } from './operation-types';

// ─── Outcomes ──────────────────────────────────────────────────────────────────────────────────────

/**
 * How one buy attempt ended (R-C3):
 *  - `bought`: the marketplace accepted the purchase;
 *  - `sold`: the listing is gone (sold, delisted, reserved, or its seller cannot deliver it now);
 *  - `price_changed`: the market's price is not the confirmed one (`newPriceCents` when known); nothing bought;
 *  - `insufficient_balance`: the balance does not cover the price (`shortCents` when known);
 *  - `captcha`: a captcha or a Cloudflare challenge stands in front of the market;
 *  - `rate_limited`: HTTP 429 (`retryAt` when the market names it);
 *  - `two_factor_required`: CSFloat asks for its 2FA code (code 123); a new attempt with the code may follow;
 *  - `cannot_trade`: the marketplace account cannot trade now (Steam Guard, trade link, bans, temporary caps);
 *  - `signed_out`: no marketplace session;
 *  - `busy`: QTS refused before sending: another attempt on this listing runs, or an earlier one may have bought it;
 *  - `refused`: the market refused for another reason, nothing bought (`reason` names it);
 *  - `not_sent`: QTS did not send the buy request (the extension refused it, no access, a failed re-read, …);
 *  - `unknown`: the buy request may have gone through (timeout, network failure, 5xx, an answer QTS cannot read).
 *    Never retried by QTS; the user checks on the marketplace.
 */
export const MARKET_BUY_OUTCOMES = [
  'bought',
  'sold',
  'price_changed',
  'insufficient_balance',
  'captcha',
  'rate_limited',
  'two_factor_required',
  'cannot_trade',
  'signed_out',
  'busy',
  'refused',
  'not_sent',
  'unknown',
] as const;
export type MarketBuyOutcome = (typeof MARKET_BUY_OUTCOMES)[number];

/** Who asked: the user from the dialog, or a buy-order rule (T11) by its id. */
export type MarketBuyOrigin = { kind: 'manual' } | { kind: 'buy_order'; ruleId: string };

/**
 * What happens after `bought`: the seller sends a Steam trade offer (CSFloat; cs.money's user market, within 12 h),
 * a cs.money bot delivers at once, the item waits in the cs.money inventory, or the user confirms a Steam offer.
 */
export type MarketBuyNext = 'seller_sends_offer' | 'instant_delivery' | 'cs_money_inventory' | 'steam_confirmation';

/** The buy request's answer as the journal keeps it: no cookies, no personal data (R-C5). */
export interface MarketBuyRaw {
  /** HTTP status of the buy request's answer; 0 = no answer (network failure or timeout). */
  status: number;
  /** The marketplace's own error code, when its answer named one. */
  code?: string;
  /** `buyAnswerDigest` of the answer body: allow-listed fields and the top-level key names, ≤ 2 KiB. */
  body?: string;
}

// ─── The page → extension request ─────────────────────────────────────────────────────────────────

/** The most a single Market purchase may cost (USD cents); a larger confirmed price is refused as invalid. */
export const MARKET_BUY_MAX_PRICE_CENTS = 10_000_000;

export interface MarketBuyRequest {
  /** The page's correlation id for this message, echoed in the result. */
  requestId: string;
  /** The attempt's id (a UUID): the journal row on the server, and the executor's replay key. */
  attemptId: string;
  source: MarketSource;
  /** CSFloat's listing id, cs.money's sell-order id (market) or item id (bots). */
  listingId: string;
  /** The price the user confirmed, integer USD cents. The buy request carries exactly this. */
  priceCents: number;
  origin: MarketBuyOrigin;
  /** The item's name and float: cs.money's bot inventory has no single-item read, so the executor searches by them. */
  item?: { name: string; float?: number };
  /** The Steam account linked to QTS; the marketplace session must belong to it (epic §4). */
  steamId?: string;
  /** CSFloat's 2FA code, only on the attempt after `two_factor_required`. Never stored or logged. */
  twoFactorCode?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** CSFloat ids: the `{listingId:id}` path parameter of its operations. cs.money ids: digits (`{orderId:int}`). */
const LISTING_ID: Readonly<Record<MarketSource, RegExp>> = {
  csfloat: /^[A-Za-z0-9_-]{1,64}$/,
  'csmoney-market': /^[0-9]{1,20}$/,
  'csmoney-bots': /^[0-9]{1,20}$/,
};
const RULE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STEAM_ID = /^7656119\d{10}$/;
const TWO_FACTOR_CODE = /^R?\d{6}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSource(value: unknown): value is MarketSource {
  return typeof value === 'string' && (MARKET_SOURCES as readonly string[]).includes(value);
}

export function isMarketBuyOutcome(value: unknown): value is MarketBuyOutcome {
  return typeof value === 'string' && (MARKET_BUY_OUTCOMES as readonly string[]).includes(value);
}

/** A whole, positive number of cents a single purchase may cost. */
export function isMarketBuyPriceCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MARKET_BUY_MAX_PRICE_CENTS;
}

function parseOrigin(value: unknown): MarketBuyOrigin | null {
  if (!isRecord(value)) return null;
  if (value['kind'] === 'manual') return { kind: 'manual' };
  if (value['kind'] === 'buy_order' && typeof value['ruleId'] === 'string' && RULE_ID.test(value['ruleId']))
    return { kind: 'buy_order', ruleId: value['ruleId'] };
  return null;
}

function parseItem(value: unknown): MarketBuyRequest['item'] | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const name = value['name'];
  const float = value['float'];
  if (typeof name !== 'string' || !name.trim() || name.length > 256 || CONTROL.test(name)) return null;
  if (float === undefined) return { name };
  if (typeof float !== 'number' || !Number.isFinite(float) || float < 0 || float > 1) return null;
  return { name, float };
}

/**
 * The page's buy request, checked field by field and rebuilt from the known fields only; null when any field is
 * missing or outside its shape. The executor sends nothing for a null.
 */
export function parseMarketBuyRequest(value: unknown): MarketBuyRequest | null {
  if (!isRecord(value)) return null;
  const { requestId, attemptId, source, listingId, priceCents, steamId, twoFactorCode } = value;
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return null;
  if (typeof attemptId !== 'string' || !UUID.test(attemptId)) return null;
  if (!isSource(source)) return null;
  if (typeof listingId !== 'string' || !LISTING_ID[source].test(listingId)) return null;
  if (!isMarketBuyPriceCents(priceCents)) return null;
  const origin = parseOrigin(value['origin']);
  if (!origin) return null;
  const item = parseItem(value['item']);
  if (item === null) return null;
  if (steamId !== undefined && (typeof steamId !== 'string' || !STEAM_ID.test(steamId))) return null;
  if (
    twoFactorCode !== undefined &&
    (source !== 'csfloat' || typeof twoFactorCode !== 'string' || !TWO_FACTOR_CODE.test(twoFactorCode))
  )
    return null;
  return {
    requestId,
    attemptId: attemptId.toLowerCase(),
    source,
    listingId,
    priceCents,
    origin,
    ...(item ? { item } : {}),
    ...(typeof steamId === 'string' ? { steamId } : {}),
    ...(typeof twoFactorCode === 'string' ? { twoFactorCode } : {}),
  };
}

// ─── The extension → page result ──────────────────────────────────────────────────────────────────

export interface MarketBuyResult {
  requestId: string;
  attemptId: string;
  source: MarketSource;
  listingId: string;
  /** The confirmed price (USD cents): what the buy request carried, when it was sent. */
  priceCents: number;
  outcome: MarketBuyOutcome;
  /** True once the buy request itself was handed to the network; false = the marketplace's buy endpoint got nothing. */
  sent: boolean;
  /** A short machine code for the outcome (`listing_sold`, `code_220`, `timeout`, `in_flight`, …); never free text. */
  reason?: string;
  /** `price_changed`: the market's current price, when known (USD cents). */
  newPriceCents?: number;
  /** The balance the executor read before buying (USD cents), when it read one. */
  balanceCents?: number;
  /** `insufficient_balance`: how much is missing (USD cents), when known. */
  shortCents?: number;
  /** `rate_limited`: when the market's limit ends (epoch ms); `busy` after an unknown outcome: when the hold ends. */
  retryAt?: number;
  /** `bought`: what happens next. */
  next?: MarketBuyNext;
  raw?: MarketBuyRaw;
  /** When the buy request was handed to the network (epoch ms, this computer's clock). */
  requestedAt?: number;
  settledAt: number;
}

const REASON = /^[a-z0-9_:.-]{1,64}$/;
const NEXT: readonly MarketBuyNext[] = [
  'seller_sends_offer',
  'instant_delivery',
  'cs_money_inventory',
  'steam_confirmation',
];

function optionalCents(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalTime(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseRaw(value: unknown): MarketBuyRaw | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const { status, code, body } = value;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 999) return null;
  if (code !== undefined && (typeof code !== 'string' || code.length > 32)) return null;
  if (body !== undefined && (typeof body !== 'string' || body.length > MARKET_BUY_DIGEST_MAX_LENGTH)) return null;
  return { status, ...(typeof code === 'string' ? { code } : {}), ...(typeof body === 'string' ? { body } : {}) };
}

/** The extension's answer as the page reads it; null when it is not a result of this shape. */
export function parseMarketBuyResult(value: unknown): MarketBuyResult | null {
  if (!isRecord(value)) return null;
  const { requestId, attemptId, source, listingId, priceCents, outcome, sent, reason, next } = value;
  if (
    typeof requestId !== 'string' ||
    typeof attemptId !== 'string' ||
    !isSource(source) ||
    typeof listingId !== 'string'
  )
    return null;
  if (
    typeof priceCents !== 'number' ||
    !Number.isSafeInteger(priceCents) ||
    !isMarketBuyOutcome(outcome) ||
    typeof sent !== 'boolean'
  )
    return null;
  if (reason !== undefined && (typeof reason !== 'string' || !REASON.test(reason))) return null;
  if (next !== undefined && !(NEXT as readonly unknown[]).includes(next)) return null;
  const newPriceCents = optionalCents(value['newPriceCents']);
  const balanceCents = optionalCents(value['balanceCents']);
  const shortCents = optionalCents(value['shortCents']);
  const retryAt = optionalTime(value['retryAt']);
  const requestedAt = optionalTime(value['requestedAt']);
  const settledAt = optionalTime(value['settledAt']);
  const raw = parseRaw(value['raw']);
  if ([newPriceCents, balanceCents, shortCents, retryAt, requestedAt, raw].includes(null) || !settledAt) return null;
  return {
    requestId,
    attemptId,
    source,
    listingId,
    priceCents,
    outcome,
    sent,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(newPriceCents !== undefined && newPriceCents !== null ? { newPriceCents } : {}),
    ...(balanceCents !== undefined && balanceCents !== null ? { balanceCents } : {}),
    ...(shortCents !== undefined && shortCents !== null ? { shortCents } : {}),
    ...(retryAt !== undefined && retryAt !== null ? { retryAt } : {}),
    ...(next !== undefined ? { next: next as MarketBuyNext } : {}),
    ...(raw ? { raw } : {}),
    ...(requestedAt !== undefined && requestedAt !== null ? { requestedAt } : {}),
    settledAt,
  };
}

// ─── Timing and holds (the executor's, shared so the page can wait long enough) ───────────────────

/** One re-read (the account, a price after code 15) before buying. A re-read that does not answer in time stops the attempt unsent. */
export const MARKET_BUY_READ_TIMEOUT_MS = 10_000;
/**
 * The listing's re-read, the last step before the buy request: the price the request carries is at most this old when it
 * leaves (the account is read before it, not alongside).
 */
export const MARKET_BUY_LISTING_READ_TIMEOUT_MS = 5_000;
/** The buy request itself; no answer by then = `unknown`. */
export const MARKET_BUY_REQUEST_TIMEOUT_MS = 30_000;


export const MARKET_BUY_BOTS_ENABLED = false;

/**
 * Buying from cs.money's market (other users' sell orders, `1.0/market/purchase`): off in this build (owner, 27.10). The
 * request and its answers are known from cs.money's site bundle only and no purchase has run it yet (spike S1 §2), so
 * the first live one comes before it is switched on. While it is off the extension does not announce
 * `market_buy_csmoney_market`, the web keeps "Open on cs.money" on cs.money market cards, the buy-order engine skips
 * those listings and the executor refuses such an attempt before any request.
 */
export const MARKET_BUY_CSMONEY_MARKET_ENABLED = false;
/** The page's wait for the executor's answer: the re-reads, the buy request and a cs.money bot confirmation. */
export const MARKET_BUY_BRIDGE_TIMEOUT_MS = 90_000;
/** After `unknown`, the listing is held: no new attempt on it from any tab or rule for this long. */
export const MARKET_BUY_UNKNOWN_HOLD_MS = 10 * 60_000;
/** After `bought`, a new attempt on the same listing is refused for this long. */
export const MARKET_BUY_BOUGHT_HOLD_MS = 30 * 60_000;

// ─── Prices ────────────────────────────────────────────────────────────────────────────────────────

/**
 * USD for a whole number of cents, the one cents → USD conversion of the money path (cs.money's purchase and hold).
 * IEEE division by 100 is correctly rounded, so `1234 / 100` is the same double as the decimal literal `12.34` that
 * cs.money's JSON carries: `JSON.stringify` writes `12.34` and the market reads back the same price.
 */
export function centsToUsd(cents: number): number {
  return cents / 100;
}

/** The cents of a USD price that is a whole number of cents, else null (a price QTS could not have shown exactly). */
export function usdToWholeCents(usd: unknown): number | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  const cents = Math.round(usd * 100);
  return centsToUsd(cents) === usd ? cents : null;
}

/** A request of the money path: one of the GET re-reads or POST buys below, as an operation request. */
export interface MarketBuyHttpRequest extends OperationRequest {
  method: 'GET' | 'POST';
}

// ─── Answers: the extension's proxy result shape ──────────────────────────────────────────────────

/** One answer as the extension relays it (`ProxyResult`): status 0 + `error` when the fetch threw or was refused. */
export interface MarketBuyAnswer {
  ok: boolean;
  status: number;
  data: unknown;
  headers?: Record<string, string>;
  error?: string;
}

/** What one answer means; `retryAt` for a rate limit, the rest for the result. */
export interface MarketBuyVerdict {
  outcome: MarketBuyOutcome;
  reason: string;
  code?: string;
  newPriceCents?: number;
  shortCents?: number;
  retryAt?: number;
}

function header(answer: MarketBuyAnswer, name: string): string | undefined {
  const headers = answer.headers;
  if (!headers) return undefined;
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found === undefined ? undefined : headers[found];
}

/**
 * When a 429 ends, on this computer's clock: CSFloat's `x-ratelimit-reset` (UNIX seconds, measured against the
 * answer's `date`) and `retry-after` (seconds or an HTTP date), the later one; undefined when neither names a future
 * time.
 */
export function marketBuyRetryAt(headers: Record<string, string> | undefined, now: number): number | undefined {
  const answer: MarketBuyAnswer = { ok: false, status: 429, data: null, ...(headers ? { headers } : {}) };
  const serverNow = Date.parse(header(answer, 'date') ?? '');
  const onOurClock = (serverTime: number) => (Number.isFinite(serverNow) ? now + serverTime - serverNow : serverTime);
  const candidates: number[] = [];
  const reset = header(answer, 'x-ratelimit-reset')?.trim();
  if (reset && /^\d{10}$/.test(reset)) candidates.push(onOurClock(Number(reset) * 1000));
  const retryAfter = header(answer, 'retry-after')?.trim();
  if (retryAfter && /^\d{1,6}$/.test(retryAfter)) candidates.push(now + Number(retryAfter) * 1000);
  else if (retryAfter && /[a-z]/i.test(retryAfter) && Number.isFinite(Date.parse(retryAfter)))
    candidates.push(onOurClock(Date.parse(retryAfter)));
  const at = candidates.length ? Math.max(...candidates) : undefined;
  return at !== undefined && at > now ? Math.ceil(at) : undefined;
}

function isChallenge(answer: MarketBuyAnswer): boolean {
  return header(answer, 'cf-mitigated')?.toLowerCase() === 'challenge';
}

function numericCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value)) return Number(value);
  return null;
}


export function csMoneyAnswerCode(data: unknown): number | null {
  if (!isRecord(data)) return null;
  const top = numericCode(data['error']);
  if (top !== null) return top;
  const errors = data['errors'];
  const first = Array.isArray(errors) && isRecord(errors[0]) ? errors[0] : null;
  if (first) return numericCode(first['code']) ?? numericCode(first['error']);
  return numericCode(data['code']);
}

function csMoneyDetails(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  const errors = data['errors'];
  const first = Array.isArray(errors) && isRecord(errors[0]) ? errors[0] : data;
  return isRecord(first['details']) ? first['details'] : null;
}

/** CSFloat's error code (`{code, message}`). */
function csfloatAnswerCode(data: unknown): number | null {
  return isRecord(data) ? numericCode(data['code']) : null;
}

/** The extension refused or could not run the request: nothing reached the marketplace. */
function refusedByExtension(answer: MarketBuyAnswer): MarketBuyVerdict | null {
  const error = answer.error ?? '';
  if (error.startsWith('operation_refused')) return { outcome: 'not_sent', reason: error.slice(0, 64) };
  if (error.startsWith('permission_denied')) return { outcome: 'not_sent', reason: 'permission_denied' };
  return null;
}

/**
 * A re-read before buying that cannot be used: the attempt stops and nothing is bought. A captcha or a rate limit is
 * said as such; anything else is `not_sent` with the read's status. Null when the read answered and can be checked.
 */
function failedRead(answer: MarketBuyAnswer, now: number, csMoney: boolean): MarketBuyVerdict | null {
  const refused = refusedByExtension(answer);
  if (refused) return refused;
  if (isChallenge(answer) || (csMoney && csMoneyAnswerCode(answer.data) === 4030))
    return { outcome: 'captcha', reason: 'reread_captcha' };
  if (answer.status === 429) {
    const retryAt = marketBuyRetryAt(answer.headers, now);
    return { outcome: 'rate_limited', reason: 'reread_429', ...(retryAt ? { retryAt } : {}) };
  }
  if (answer.status === 0)
    return { outcome: 'not_sent', reason: answer.error === 'timeout' ? 'reread_timeout' : 'reread_network' };
  return null;
}

// ─── Re-reads before buying (R-C2) ─────────────────────────────────────────────────────────────────

/** A listing that may be bought at the confirmed price (`row`: the cs.money bot row the hold sends back). */
export type MarketListingCheck =
  | { ok: true; next: MarketBuyNext; row?: Record<string, unknown> }
  | { ok: false; verdict: MarketBuyVerdict };

function stop(outcome: MarketBuyOutcome, reason: string, extra: Partial<MarketBuyVerdict> = {}): MarketListingCheck {
  return { ok: false, verdict: { outcome, reason, ...extra } };
}

function priceVerdict(currentCents: number, confirmedCents: number): MarketListingCheck | null {
  if (currentCents === confirmedCents) return null;
  return stop('price_changed', currentCents > confirmedCents ? 'price_rose' : 'price_fell', {
    newPriceCents: currentCents,
  });
}

const CHECK_HEADERS = { 'Cache-Control': 'no-cache' } as const;

/** CSFloat's listing, read fresh (`csfloat.listing.get`). */
export function csfloatListingReadRequest(listingId: string): MarketBuyHttpRequest {
  return {
    url: `https://csfloat.com/api/v1/listings/${encodeURIComponent(listingId)}`,
    method: 'GET',
    headers: { ...CHECK_HEADERS },
  };
}

/**
 * CSFloat's listing may be bought: it is this listing, still `listed` as `buy_now`, at exactly the confirmed price, and
 * its seller is not away (the site disables Buy then). S1 §1.2, §5.
 */
export function checkCsfloatListing(
  answer: MarketBuyAnswer,
  listingId: string,
  priceCents: number,
  now: number
): MarketListingCheck {
  const failed = failedRead(answer, now, false);
  if (failed) return { ok: false, verdict: failed };
  const data = isRecord(answer.data) ? answer.data : null;
  // A dead id: 404, or 400 `{code: 2, "unknown resource"}` (vault csfloat-api, measured).
  if (answer.status === 404 || (answer.status === 400 && csfloatAnswerCode(data) === 2))
    return stop('sold', 'listing_gone');
  if (!answer.ok || !data) return stop('not_sent', `reread_http_${answer.status}`);
  if (String(data['id']) !== listingId) return stop('not_sent', 'reread_mismatch');
  if (data['state'] !== 'listed') return stop('sold', data['state'] === 'sold' ? 'listing_sold' : 'listing_not_listed');
  if (data['type'] !== 'buy_now') return stop('refused', 'not_buy_now');
  const price = data['price'];
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price <= 0)
    return stop('not_sent', 'reread_unreadable');
  const changed = priceVerdict(price, priceCents);
  if (changed) return changed;
  if (isRecord(data['seller']) && data['seller']['away'] === true) return stop('refused', 'seller_away');
  return { ok: true, next: 'seller_sends_offer' };
}

/** cs.money's sell order, read fresh (`csmoney.market.sell-order.get`): `{item}` (S1 §2.4). */
export function csMoneySellOrderReadRequest(orderId: string): MarketBuyHttpRequest {
  return {
    url: `https://cs.money/2.0/market/sell-orders/${encodeURIComponent(orderId)}`,
    method: 'GET',
    headers: { ...CHECK_HEADERS },
  };
}

/** cs.money codes that mean the item cannot be bought now: nothing matches, seller problems, not on sale, reserved, gone. */
const CSMONEY_UNAVAILABLE = new Set([2, 200, 201, 202, 203, 204, 205, 210, 211, 212, 214]);

/**
 * cs.money's sell order may be bought: it is this order, and `pricing.computed` (USD) is exactly the confirmed cents.
 * A price that is not a whole number of cents is refused: QTS could not have shown it exactly.
 */
export function checkCsMoneySellOrder(
  answer: MarketBuyAnswer,
  orderId: string,
  priceCents: number,
  now: number
): MarketListingCheck {
  const failed = failedRead(answer, now, true);
  if (failed) return { ok: false, verdict: failed };
  const code = csMoneyAnswerCode(answer.data);
  if (answer.status === 404 || (code !== null && CSMONEY_UNAVAILABLE.has(code)))
    return stop('sold', code === null ? 'listing_gone' : `code_${code}`);
  if (code === 6) return stop('signed_out', 'code_6');
  const root = isRecord(answer.data) ? answer.data : null;
  const item = root && isRecord(root['item']) ? root['item'] : root && isRecord(root['pricing']) ? root : null;
  if (!answer.ok) return stop('not_sent', `reread_http_${answer.status}`);
  if (!item)
    return stop(
      root && root['item'] === null ? 'sold' : 'not_sent',
      root && root['item'] === null ? 'listing_gone' : 'reread_unreadable'
    );
  if (String(item['id']) !== orderId) return stop('not_sent', 'reread_mismatch');
  const pricing = isRecord(item['pricing']) ? item['pricing'] : null;
  const computed = pricing?.['computed'];
  if (typeof computed !== 'number' || !Number.isFinite(computed) || computed <= 0)
    return stop('not_sent', 'reread_unreadable');
  const cents = usdToWholeCents(computed);
  if (cents === null) return stop('not_sent', 'price_not_whole_cents');
  const changed = priceVerdict(cents, priceCents);
  if (changed) return changed;
  const owner = isRecord(item['owner']) ? item['owner'] : isRecord(item['seller']) ? item['seller'] : null;
  return { ok: true, next: owner?.['isBot'] === true ? 'instant_delivery' : 'seller_sends_offer' };
}

/**
 * cs.money's bot inventory narrowed to one item (`csmoney.bots.feed`): there is no single-item read, so the name and,
 * when known, a float window of ±0.000001 around the item's float.
 */
export function csMoneyBotReadRequest(name: string, float: number | undefined): MarketBuyHttpRequest {
  const params = new URLSearchParams({ limit: '60', sort: 'price', order: 'asc', name });
  if (float !== undefined) {
    params.set('minFloat', String(Math.max(0, Math.floor((float - 0.000001) * 1e7) / 1e7)));
    params.set('maxFloat', String(Math.min(1, Math.ceil((float + 0.000001) * 1e7) / 1e7)));
  }
  return { url: `https://cs.money/6.0/load_bots_inventory/730?${params.toString()}`, method: 'GET' };
}

/**
 * A bot row's price as the Market card read it (the web's `normalizeInventory`: the first positive of
 * `pricing.computed`, `sellPrice`, `botPrice`, `price`), USD.
 */
function botRowPrice(row: Record<string, unknown>): unknown {
  const pricing = isRecord(row['pricing']) ? row['pricing'] : null;
  const candidates = [pricing?.['computed'], row['sellPrice'], row['botPrice'], row['price']];
  return candidates.find((value) => typeof value === 'number' && value > 0);
}

/** The bot item is still in cs.money's bot inventory at exactly the confirmed price; its row is what the hold sends. */
export function checkCsMoneyBotRow(
  answer: MarketBuyAnswer,
  itemId: string,
  priceCents: number,
  now: number
): MarketListingCheck {
  const failed = failedRead(answer, now, true);
  if (failed) return { ok: false, verdict: failed };
  const code = csMoneyAnswerCode(answer.data);
  // cs.money answers "nothing matches" as `{error: 2}` (HTTP 200) or 400 `{errors: [{code: 2}]}`.
  if (code === 2) return stop('sold', 'listing_gone');
  if (!answer.ok) return stop('not_sent', `reread_http_${answer.status}`);
  const root = answer.data;
  const rows = Array.isArray(root) ? root : isRecord(root) && Array.isArray(root['items']) ? root['items'] : null;
  if (!rows) return stop('not_sent', 'reread_unreadable');
  const row = rows.find(
    (candidate): candidate is Record<string, unknown> => isRecord(candidate) && String(candidate['id']) === itemId
  );
  if (!row) return stop('sold', 'listing_gone');
  const cents = usdToWholeCents(botRowPrice(row));
  if (cents === null) return stop('not_sent', 'price_not_whole_cents');
  const changed = priceVerdict(cents, priceCents);
  if (changed) return changed;
  return { ok: true, next: 'cs_money_inventory', row };
}

/** The marketplace account the attempt would buy with: logged in, the linked Steam account, the balance if known. */
export type MarketAccountCheck =
  | { ok: true; balanceCents: number | null }
  | { ok: false; verdict: MarketBuyVerdict; balanceCents?: number };

/**
 * The read could not tell which account is logged in (timeout, 5xx, refused, unreadable, no Steam id). With a linked
 * Steam account to match, the attempt stops unsent: QTS never buys on an account it could not confirm.
 */
function unconfirmed(expectedSteamId: string | undefined, refused?: MarketBuyVerdict | null): MarketAccountCheck {
  if (!expectedSteamId) return { ok: true, balanceCents: null };
  // The extension's own refusal (no access to the marketplace, an operation it refuses) says why, e.g. "connect it".
  return { ok: false, verdict: refused ?? { outcome: 'not_sent', reason: 'account_unconfirmed' } };
}

function accountVerdict(
  steamId: string | null,
  balanceCents: number | null,
  priceCents: number,
  expectedSteamId: string | undefined
): MarketAccountCheck {
  if (expectedSteamId && !steamId) return unconfirmed(expectedSteamId);
  if (expectedSteamId && steamId && steamId !== expectedSteamId)
    return { ok: false, verdict: { outcome: 'refused', reason: 'steam_account_mismatch' } };
  if (balanceCents !== null && balanceCents < priceCents)
    return {
      ok: false,
      verdict: { outcome: 'insufficient_balance', reason: 'balance_short', shortCents: priceCents - balanceCents },
      balanceCents,
    };
  return { ok: true, balanceCents };
}

/** CSFloat's profile (`csfloat.me`). */
export function csfloatAccountReadRequest(): MarketBuyHttpRequest {
  return { url: 'https://csfloat.com/api/v1/me', method: 'GET' };
}

const wholeCents = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * CSFloat's `/me`: signed out (401, or no `user`), another Steam account, or a balance (cents) below the price stop the
 * attempt. A read that failed otherwise (timeout, 5xx, unreadable) stops it unsent when a linked Steam account has to be
 * confirmed (`account_unconfirmed`); without one the attempt goes on with the balance unknown (CSFloat checks it).
 */
export function checkCsfloatAccount(
  answer: MarketBuyAnswer,
  priceCents: number,
  expectedSteamId?: string
): MarketAccountCheck {
  const refused = refusedByExtension(answer);
  if (refused) return unconfirmed(expectedSteamId, refused);
  if (answer.status === 401) return { ok: false, verdict: { outcome: 'signed_out', reason: 'account_401' } };
  const user = isRecord(answer.data) && isRecord(answer.data['user']) ? answer.data['user'] : null;
  if (answer.ok && isRecord(answer.data) && !user)
    return { ok: false, verdict: { outcome: 'signed_out', reason: 'account_no_user' } };
  if (!answer.ok || !user) return unconfirmed(expectedSteamId);
  const steamId = typeof user['steam_id'] === 'string' ? user['steam_id'] : null;
  return accountVerdict(steamId, wholeCents(user['balance']), priceCents, expectedSteamId);
}

/** cs.money's market page (`csmoney.page.market`): its HTML carries `userInfo` and `marketBalance`. */
export function csMoneyAccountReadRequest(): MarketBuyHttpRequest {
  return { url: 'https://cs.money/market/buy/', method: 'GET' };
}

/** The first JSON object after `"key":` in an HTML page (the cs.money page state), or null. */
export function jsonObjectAfterKey(html: string, key: string): Record<string, unknown> | null {
  const needle = `"${key}":`;
  const start = html.indexOf(needle);
  if (start === -1) return null;
  let i = start + needle.length;
  while (i < html.length && /\s/.test(html[i] ?? '')) i++;
  if (html[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (escaped) escaped = false;
    else if (c === '\\') escaped = true;
    else if (c === '"') inString = !inString;
    else if (!inString && c === '{') depth++;
    else if (!inString && c === '}' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(html.slice(i, j + 1));
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * cs.money's market page: no `userInfo` with a Steam id = signed out; another Steam account or `marketBalance.balance`
 * (cents, as the Market header reads it) below the price stop the attempt. A page that could not be read stops it unsent
 * when a linked Steam account has to be confirmed (`account_unconfirmed`); without one it goes on (cs.money checks the
 * balance itself: code 107).
 */
export function checkCsMoneyAccount(
  answer: MarketBuyAnswer,
  priceCents: number,
  expectedSteamId?: string
): MarketAccountCheck {
  const refused = refusedByExtension(answer);
  if (refused || !answer.ok || typeof answer.data !== 'string') return unconfirmed(expectedSteamId, refused);
  const userInfo = jsonObjectAfterKey(answer.data, 'userInfo');
  const steamIdValue = userInfo?.['steamId64'] ?? userInfo?.['steamId'] ?? userInfo?.['steam_id'];
  const steamId = typeof steamIdValue === 'string' && steamIdValue ? steamIdValue : null;
  if (!userInfo || !steamId) return { ok: false, verdict: { outcome: 'signed_out', reason: 'account_no_user' } };
  const marketBalance = jsonObjectAfterKey(answer.data, 'marketBalance');
  return accountVerdict(steamId, wholeCents(marketBalance?.['balance']), priceCents, expectedSteamId);
}

// ─── The buy requests (R-N1: the body carries exactly `priceCents`) ───────────────────────────────

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * CSFloat buy now (`csfloat.listings.buy`, S1 §1.1): `{total_price, contract_ids}`, `total_price` = the confirmed
 * integer cents, one listing per request. `Two-Factor` only on the attempt after code 123.
 */
export function csfloatBuyRequest(listingId: string, priceCents: number, twoFactorCode?: string): MarketBuyHttpRequest {
  return {
    url: 'https://csfloat.com/api/v1/listings/buy',
    method: 'POST',
    headers: { ...JSON_HEADERS, ...(twoFactorCode ? { 'Two-Factor': twoFactorCode } : {}) },
    body: JSON.stringify({ total_price: priceCents, contract_ids: [listingId] }),
  };
}

/**
 * cs.money market purchase (`csmoney.market.purchase`, S1 §2.1): `{"items":[{"id":"<sell order>","price":<USD>}]}`,
 * one item per request, the price = `centsToUsd(priceCents)` (the re-read showed cs.money quotes exactly that).
 */
export function csMoneyPurchaseRequest(orderId: string, priceCents: number): MarketBuyHttpRequest {
  return {
    url: 'https://cs.money/1.0/market/purchase',
    method: 'POST',
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ items: [{ id: orderId, price: centsToUsd(priceCents) }] }),
  };
}


export function csMoneyBotHoldRequest(row: Record<string, unknown>, priceCents: number): MarketBuyHttpRequest {
  return {
    url: 'https://cs.money/2.0/send-offer',
    method: 'POST',
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({
      skins: { bot: [row], user: [] },
      balance: -centsToUsd(priceCents),
      games: {},
      isVirtual: true,
    }),
  };
}

/** Confirms a verified hold (`csmoney.trade.confirm-virtual`): `{offer_id, action: 'confirm'}` → `{status}`. */
export function csMoneyBotConfirmRequest(offerId: number): MarketBuyHttpRequest {
  return {
    url: 'https://cs.money/confirm_virtual_offer',
    method: 'POST',
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ offer_id: String(offerId), action: 'confirm' }),
  };
}


export function csMoneyBotDeclineRequest(offerId: number): MarketBuyHttpRequest {
  return { url: `https://cs.money/api/public/v1/trade/requests/virtual/${offerId}/decline`, method: 'POST' };
}

// ─── Classifying the buy request's answer (R-C3) ──────────────────────────────────────────────────

/**
 * The answer could not be read as a definite result: the request may have bought the item. Status 0 (the fetch threw,
 * or no answer within the timeout), 5xx, and anything else QTS cannot read.
 */
function maybeBought(answer: MarketBuyAnswer, reason?: string): MarketBuyVerdict {
  const why =
    reason ?? (answer.status === 0 ? (answer.error === 'timeout' ? 'timeout' : 'network') : `http_${answer.status}`);
  return { outcome: 'unknown', reason: why };
}

function rateLimited(answer: MarketBuyAnswer, now: number): MarketBuyVerdict {
  const retryAt = marketBuyRetryAt(answer.headers, now);
  return { outcome: 'rate_limited', reason: 'http_429', ...(retryAt ? { retryAt } : {}) };
}

/**
 * CSFloat `POST /api/v1/listings/buy` (S1 §1.3, §5): a 2xx with a JSON object bought (the site ignores the body); a 2xx
 * with HTML, text or nothing is unknown (a proxy page is not CSFloat's answer); a 4xx with CSFloat's `code` is a definite
 * refusal; everything else is unknown.
 */
export function classifyCsfloatBuyAnswer(answer: MarketBuyAnswer, now: number): MarketBuyVerdict {
  const refused = refusedByExtension(answer);
  if (refused) return refused;
  if (answer.status >= 200 && answer.status < 300)
    return isRecord(answer.data) ? { outcome: 'bought', reason: 'ok' } : maybeBought(answer, 'ok_not_json');
  if (isChallenge(answer)) return { outcome: 'captcha', reason: 'cloudflare_challenge' };
  if (answer.status === 429) return rateLimited(answer, now);
  if (answer.status === 401) return { outcome: 'signed_out', reason: 'http_401' };
  const code = csfloatAnswerCode(answer.data);
  if (answer.status < 400 || answer.status >= 500 || code === null) return maybeBought(answer);
  const coded = { code: String(code), reason: `code_${code}` };
  switch (code) {
    case 2: // unknown resource: a dead listing id
    case 4: // already sold
    case 6: // invalid purchase state (HTTP 422)
      return { outcome: 'sold', ...coded };
    case 15: // price changed
      return { outcome: 'price_changed', ...coded };
    case 123: // 2FA required: the site resends the same request with `Two-Factor`
      return { outcome: 'two_factor_required', ...coded };
    case 119: // mobile authenticator problem
    case 125: // cannot trade on Steam
      return { outcome: 'cannot_trade', ...coded };
    default:
      return { outcome: 'refused', ...coded };
  }
}

function csMoneyCodeVerdict(code: number, data: unknown, now: number, answer: MarketBuyAnswer): MarketBuyVerdict {
  const coded = { code: String(code), reason: `code_${code}` };
  const details = csMoneyDetails(data);
  if (CSMONEY_UNAVAILABLE.has(code)) return { outcome: 'sold', ...coded };
  switch (code) {
    case 107: {
      // NOT_ENOUGH_BALANCE, details.amountToDeposit in USD.
      const amount = details?.['amountToDeposit'];
      const short =
        typeof amount === 'number' && Number.isFinite(amount) && amount > 0
          ? Math.ceil(Math.round(amount * 1e6) / 1e4)
          : undefined;
      return { outcome: 'insufficient_balance', ...coded, ...(short ? { shortCents: short } : {}) };
    }
    case 220: {
      // ITEM_PRICE_CHANGED, details.orders[{id, oldPrice, newPrice}] in USD.
      const orders = details?.['orders'];
      const first = Array.isArray(orders) && isRecord(orders[0]) ? orders[0] : null;
      const newPrice = usdToWholeCents(first?.['newPrice']);
      return { outcome: 'price_changed', ...coded, ...(newPrice !== null ? { newPriceCents: newPrice } : {}) };
    }
    case 4030:
      return { outcome: 'captcha', ...coded };
    case 429:
      return { ...rateLimited(answer, now), ...coded };
    case 6:
      return { outcome: 'signed_out', ...coded };
    case 101:
    case 102:
    case 103:
    case 104:
    case 105:
      return { outcome: 'cannot_trade', ...coded };
    case 9999:
      // UnknownError: cs.money itself does not know what happened.
      return { outcome: 'unknown', ...coded };
    default:
      return { outcome: 'refused', ...coded };
  }
}

/**
 * cs.money `POST /1.0/market/purchase` (S1 §2.3): the site counts a 2xx without a top-level `error` as success; QTS
 * also needs a JSON object (the mocks answer `{}`). A 2xx with HTML, text or nothing, or one that carries `errors[]`, is
 * unknown (the dev mocks answer errors that way, the real status is unverified); a 4xx with
 * an error code is a definite refusal; everything else is unknown.
 */
export function classifyCsMoneyPurchaseAnswer(answer: MarketBuyAnswer, now: number): MarketBuyVerdict {
  const refused = refusedByExtension(answer);
  if (refused) return refused;
  const data = answer.data;
  const code = csMoneyAnswerCode(data);
  if (answer.status >= 200 && answer.status < 300) {
    if (isRecord(data) && 'error' in data)
      return code === null ? maybeBought(answer, 'ok_with_error') : csMoneyCodeVerdict(code, data, now, answer);
    if (isRecord(data) && Array.isArray(data['errors']) && data['errors'].length > 0)
      return maybeBought(answer, 'ok_with_errors');
    return isRecord(data) ? { outcome: 'bought', reason: 'ok' } : maybeBought(answer, 'ok_not_json');
  }
  if (isChallenge(answer)) return { outcome: 'captcha', reason: 'cloudflare_challenge' };
  if (answer.status === 429) return rateLimited(answer, now);
  if (answer.status >= 400 && answer.status < 500 && code !== null) return csMoneyCodeVerdict(code, data, now, answer);
  if (answer.status === 401) return { outcome: 'signed_out', reason: 'http_401' };
  if (answer.status === 404) return { outcome: 'refused', reason: 'http_404' };
  return maybeBought(answer);
}

/** cs.money trade codes on the bot hold (S1 §3.3). */
function csMoneyTradeCodeVerdict(code: number, now: number, answer: MarketBuyAnswer): MarketBuyVerdict {
  const coded = { code: String(code), reason: `code_${code}` };
  switch (code) {
    case 11: // BotLostList: out of stock
    case 40: // BotNotRelevantList
    case 15: // someone else is trading these items
    case 25: // you are already trading these items
      return { outcome: 'sold', ...coded };
    case 16: // bot changed prices
    case 17: // user changed prices
    case 32: // the trade amount changed
      return { outcome: 'price_changed', ...coded };
    case 19: // not enough balance
    case 38: // daily balance usage limit
      return { outcome: 'insufficient_balance', ...coded };
    case 9: // update the trade link
    case 10: // Steam Guard disabled
    case 37: // too many profitable skins: a temporary cap
      return { outcome: 'cannot_trade', ...coded };
    case 6:
      return { outcome: 'signed_out', ...coded };
    case 4030:
      return { outcome: 'captcha', ...coded };
    case 429:
      return { ...rateLimited(answer, now), ...coded };
    case 503:
    case 9998:
    case 9999:
      return { outcome: 'unknown', ...coded };
    default:
      return { outcome: 'refused', ...coded };
  }
}


export type CsMoneyHoldVerdict =
  | { held: true; offerId: number }
  | { held: false; verdict: MarketBuyVerdict; offerId?: number };

/**
 * cs.money `POST /2.0/send-offer` with `isVirtual: true`: a hold is good only when the answer's `balance` (the delta,
 * USD) is exactly −`priceCents`; any other 2xx is a mismatch the executor declines. A 4xx with a trade code or a 429 is a
 * definite refusal; anything else is unknown (a hold may exist and expires by itself in about 6 minutes).
 */
export function classifyCsMoneyHoldAnswer(
  answer: MarketBuyAnswer,
  priceCents: number,
  now: number
): CsMoneyHoldVerdict {
  const refused = refusedByExtension(answer);
  if (refused) return { held: false, verdict: refused };
  const data = isRecord(answer.data) ? answer.data : null;
  if (answer.status >= 200 && answer.status < 300) {
    const offers = data && Array.isArray(data['offers']) ? data['offers'] : null;
    const offer = offers && offers.length === 1 && isRecord(offers[0]) ? offers[0] : null;
    const offerId = offer?.['id'];
    const balance = data?.['balance'];
    const usableId = typeof offerId === 'number' && Number.isSafeInteger(offerId) && offerId > 0;
    if (
      usableId &&
      typeof data?.['requestId'] === 'number' &&
      Number.isSafeInteger(data['requestId']) &&
      typeof balance === 'number' &&
      Math.abs(balance * 100 + priceCents) < 0.000001
    )
      return { held: true, offerId };
    return { held: false, verdict: { outcome: 'refused', reason: 'hold_mismatch' }, ...(usableId ? { offerId } : {}) };
  }
  if (isChallenge(answer)) return { held: false, verdict: { outcome: 'captcha', reason: 'cloudflare_challenge' } };
  if (answer.status === 429) return { held: false, verdict: rateLimited(answer, now) };
  const code = csMoneyAnswerCode(data);
  if (answer.status >= 400 && answer.status < 500 && code !== null)
    return { held: false, verdict: csMoneyTradeCodeVerdict(code, now, answer) };
  if (answer.status === 401) return { held: false, verdict: { outcome: 'signed_out', reason: 'http_401' } };
  if (answer.status === 404) return { held: false, verdict: { outcome: 'refused', reason: 'http_404' } };
  return { held: false, verdict: maybeBought(answer) };
}

/** `confirm_virtual_offer`: `{status: true}` bought (a Steam offer id, when named, needs the user's confirmation). */
export function classifyCsMoneyConfirmAnswer(
  answer: MarketBuyAnswer,
  now: number
): MarketBuyVerdict & { next?: MarketBuyNext } {
  const refused = refusedByExtension(answer);
  if (refused) return refused;
  const data = isRecord(answer.data) ? answer.data : null;
  if (answer.status >= 200 && answer.status < 300 && data) {
    if (data['status'] === true) {
      const offer = ['tradeofferid', 'tradeOfferId', 'trade_offer_id', 'steamTradeOfferId'].some(
        (key) => data[key] !== undefined && data[key] !== null
      );
      return { outcome: 'bought', reason: 'ok', next: offer ? 'steam_confirmation' : 'cs_money_inventory' };
    }
    // `{status: false}`: cs.money refused to confirm; the hold expires by itself.
    if (data['status'] === false) return { outcome: 'refused', reason: 'confirm_refused' };
  }
  // A refused confirmation leaves the hold to expire by itself: nothing bought.
  if (answer.status === 429) return rateLimited(answer, now);
  return maybeBought(answer);
}

// ─── The journal's copy of an answer (R-C5) ───────────────────────────────────────────────────────

export const MARKET_BUY_DIGEST_MAX_LENGTH = 2048;

/** Keys whose values are kept (scalars, or the allow-listed structures below). Everything else: its name only. */
const DIGEST_SCALARS = new Set([
  'code',
  'error',
  'message',
  'status',
  'state',
  'type',
  'id',
  'requestId',
  'balance',
  'price',
  'total_price',
  'oldPrice',
  'newPrice',
  'amountToDeposit',
  'is_valid_to_trade',
  'next_valid_time',
  'skinId',
  'success',
  'ok',
  'isMain',
  'isSub',
]);
const DIGEST_NESTED = new Set(['errors', 'details', 'offers', 'orders', 'unavailableOrders', 'skins', 'contract_ids']);
/** Never kept, whatever the structure: identity, sessions, trade links, people. */
const DIGEST_SENSITIVE =
  /token|cookie|session|auth|steam|trade_?url|tradelink|email|phone|address|avatar|user|seller|buyer|owner|partner|name|ip/i;
const DIGEST_MAX_DEPTH = 6;
const DIGEST_MAX_ITEMS = 10;

function digestString(value: string): string {
  return (
    value
      // Trade links with or without a scheme, then any `token=` / `partner=` left elsewhere.
      .replace(/(?:https?:\/\/)?(?:[\w-]+\.)*steamcommunity\.com\/tradeoffer\S*/gi, '<tradeoffer>')
      .replace(/tradeoffer\/\S*/gi, '<tradeoffer>')
      .replace(/\b(token|partner)=[^&\s"']*/gi, '$1=<masked>')
      .replace(/7656119\d{10}/g, '<steamid>')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
      .replace(/https?:\/\/\S+/g, '<url>')
      .slice(0, 160)
  );
}

function digestValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return digestString(value);
  if (depth >= DIGEST_MAX_DEPTH) return Array.isArray(value) ? `[${value.length}]` : '{…}';
  if (Array.isArray(value)) return value.slice(0, DIGEST_MAX_ITEMS).map((entry) => digestValue(entry, depth + 1));
  if (isRecord(value)) return digestRecord(value, depth + 1);
  return null;
}

function digestRecord(record: Record<string, unknown>, depth: number): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record).slice(0, 40)) {
    if (DIGEST_SENSITIVE.test(key)) continue;
    const scalar = value === null || ['string', 'number', 'boolean'].includes(typeof value);
    if (DIGEST_SCALARS.has(key) && scalar) kept[key] = digestValue(value, depth);
    else if (DIGEST_NESTED.has(key)) kept[key] = digestValue(value, depth);
  }
  return kept;
}

/**
 * A buy answer's body as the journal keeps it, so the owner's first live purchase shows what the marketplace answered
 * (R-C5): the top-level key names, and only allow-listed fields (codes, messages, ids, prices, offer states) with Steam
 * ids, emails and URLs masked. Never a cookie, token, trade link or a person's name. Undefined for an empty body.
 */
export function buyAnswerDigest(data: unknown): string | undefined {
  if (data === undefined || data === null || data === '') return undefined;
  let digest: Record<string, unknown>;
  if (typeof data === 'string') digest = { text: true, length: data.length };
  else if (Array.isArray(data)) digest = { array: data.length };
  else if (isRecord(data))
    digest = {
      keys: Object.keys(data)
        .slice(0, 40)
        .map((key) => key.slice(0, 40)),
      ...digestRecord(data, 0),
    };
  else digest = { value: digestValue(data, 0) };
  let text = JSON.stringify(digest);
  if (text.length > MARKET_BUY_DIGEST_MAX_LENGTH)
    text = JSON.stringify({ keys: digest['keys'] ?? null, truncated: true });
  return text.length > MARKET_BUY_DIGEST_MAX_LENGTH ? text.slice(0, MARKET_BUY_DIGEST_MAX_LENGTH) : text;
}

// ─── Where the user checks or tops up ─────────────────────────────────────────────────────────────

/** Where a purchase shows on each marketplace: CSFloat's trades, cs.money's market history, cs.money's trade page. */
export const MARKET_BUY_CHECK_URLS: Readonly<Record<MarketSource, string>> = {
  csfloat: 'https://csfloat.com/profile/my-trades',
  'csmoney-market': 'https://cs.money/market/history/',
  'csmoney-bots': 'https://cs.money/csgo/trade/',
};

/** Where the balance is topped up. */
export const MARKET_BUY_TOP_UP_URLS: Readonly<Record<MarketSource, string>> = {
  csfloat: 'https://csfloat.com/profile/deposit',
  'csmoney-market': 'https://cs.money/market/buy/',
  'csmoney-bots': 'https://cs.money/csgo/trade/',
};
