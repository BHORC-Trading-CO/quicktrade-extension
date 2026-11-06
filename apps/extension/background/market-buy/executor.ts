// apps/extension/background/market-buy/executor.ts
//
// QUICK-226 (epic QUICK-216 R-C1–R-C4, R-N1): the one buy executor. Every purchase (the Market page's dialog now, buy-order
// rules later) runs through `executeMarketBuy`, in the extension's background, so a listing cannot be bought twice from
// two tabs or by a rule and a click at once (AttemptRegistry). For one attempt it:
//   1. checks the page's request field by field (`parseMarketBuyRequest`) and claims the listing;
//   2. re-reads the listing and the account (R-C2): the listing still on sale at exactly the confirmed price, the
//      session of the linked Steam account, a balance that covers it; anything else stops the attempt unsent;
//   3. sends one buy request that carries exactly the confirmed price (`csfloatBuyRequest` / `csMoneyPurchaseRequest`);
//   4. classifies the answer (R-C3). A request whose answer is unknown is never sent again, here or later: the listing is
//      held (`unknown_hold`) and the user checks on the marketplace.
// Endpoints and codes: spike S1 (QUICK-220). Nothing here reads or returns a cookie.
//
// QUICK-233 (buy orders) only narrows this: a `buy_order` attempt must name the linked Steam account; it may use a
// confirmation of that account at most BUY_ORDER_ACCOUNT_TTL_MS old instead of reading it (`account-cache.ts`), and the
// engine's `beforeSend` gate (the server's journal row, opened while the re-read runs) can stop it unsent right before
// the buy request. Nothing else changes: the same re-read of the listing, the same request, the same price.
import type { MarketAccountCheck, MarketBuyAnswer, MarketBuyNext, MarketBuyRaw, MarketBuyRequest, MarketBuyResult, MarketBuyVerdict, OperationRequest } from '@qts/contracts';
import {
  buyAnswerDigest,
  checkCsfloatAccount,
  checkCsfloatListing,
  checkCsMoneyAccount,
  checkCsMoneyBotRow,
  checkCsMoneySellOrder,
  classifyCsfloatBuyAnswer,
  classifyCsMoneyConfirmAnswer,
  classifyCsMoneyHoldAnswer,
  classifyCsMoneyPurchaseAnswer,
  csfloatAccountReadRequest,
  csfloatBuyRequest,
  csfloatListingReadRequest,
  csMoneyAccountReadRequest,
  csMoneyBotConfirmRequest,
  csMoneyBotDeclineRequest,
  csMoneyBotHoldRequest,
  csMoneyBotReadRequest,
  csMoneyPurchaseRequest,
  csMoneySellOrderReadRequest,
  MARKET_BUY_LISTING_READ_TIMEOUT_MS,
  MARKET_BUY_READ_TIMEOUT_MS,
  MARKET_BUY_REQUEST_TIMEOUT_MS,
  parseMarketBuyRequest,
} from '@qts/contracts';

import { MARKET_BUY_BOTS_ENABLED, MARKET_BUY_CSMONEY_MARKET_ENABLED } from '@/shared/market-buy-config';

import { beginForegroundRequest, reserveCsfloatBudget } from '../market-feed/feed-priority';
import { proxyRequest } from '../proxy';
import { type AccountPlatform, MarketAccountCache } from './account-cache';
import { AttemptRegistry, type BusyReason, type SessionArea } from './attempt-registry';
import { sendBuyRequest } from './buy-request';

type MarketPlatformId = 'csfloat.com' | 'cs.money';

export interface MarketBuyDeps {
  /** A re-read: an ordinary page operation, sent like a page's proxy request. */
  read: (platform: MarketPlatformId, request: OperationRequest, timeoutMs: number) => Promise<MarketBuyAnswer>;
  /** The buy request itself (internal buy operations only). */
  send: (platform: MarketPlatformId, request: OperationRequest, timeoutMs: number) => Promise<MarketBuyAnswer>;
  registry: AttemptRegistry;
  /** Holds CSFloat requests ahead of the live feed (QUICK-231) for the attempt; returns the release. */
  reserveCsfloat: (requests: number, ttlMs: number) => () => void;
  now: () => number;
  botsEnabled: boolean;
  csmoneyMarketEnabled: boolean;
  readTimeoutMs: number;
  /** The listing's re-read, right before the buy request. */
  listingReadTimeoutMs: number;
  buyTimeoutMs: number;
  /** QUICK-233: the confirmed marketplace accounts (a buy-order attempt may use a recent one instead of a read). */
  accounts?: MarketAccountCache;
}

/** QUICK-233: what a caller adds to one attempt; the page's purchases pass nothing. */
export interface MarketBuyOptions {
  /**
   * Right before the buy request leaves, after every re-read passed: a reason stops the attempt unsent (`not_sent`
   * with that reason); null lets it go. The buy-order engine waits here for the server's journal row.
   */
  beforeSend?: (request: MarketBuyRequest) => Promise<string | null>;
}

function sessionArea(): SessionArea | null {
  try {
    const area = browser.storage?.session;
    return area ? { get: (key) => area.get(key), set: (items) => area.set(items) } : null;
  } catch {
    return null;
  }
}

/** The background's one registry: every tab and every rule claims listings here. */
export const marketBuyRegistry = new AttemptRegistry(sessionArea, () => Date.now());

/** The background's one account cache (QUICK-233): every purchase updates it, buy-order attempts may read it. */
export const marketAccountCache = new MarketAccountCache(() => Date.now());

/**
 * Runs one of the attempt's requests ahead of the Market live feed (QUICK-231): the feed of that marketplace waits while
 * it runs and a moment after, and a captcha or limit it meets holds the feed back. The mark ends with the answer, or when
 * the executor stops waiting for it (`releaseAfterMs`, its own timeout): a request that never answers cannot keep the
 * feed paused. The request itself is not aborted, so a late buy answer still settles the attempt's hold.
 */
function foreground(platform: MarketPlatformId, request: OperationRequest, releaseAfterMs: number, run: () => Promise<MarketBuyAnswer>): Promise<MarketBuyAnswer> {
  const mark = beginForegroundRequest(platform, request);
  const timer = setTimeout(() => mark.end(), releaseAfterMs);
  return run().then(
    (answer) => {
      clearTimeout(timer);
      mark.end(answer);
      return answer;
    },
    (error: unknown) => {
      clearTimeout(timer);
      mark.end();
      throw error;
    }
  );
}

export function defaultMarketBuyDeps(): MarketBuyDeps {
  return {
    // Each live-feed mark ends with its request's answer or at the executor's timeout for that request.
    read: (platform, request, timeoutMs) =>
      foreground(platform, request, timeoutMs, () => proxyRequest(request.url, { platform, purpose: 'page', method: request.method, ...(request.headers ? { headers: { ...request.headers } } : {}) })),
    send: (platform, request, timeoutMs) => foreground(platform, request, timeoutMs, () => sendBuyRequest(platform, request)),
    registry: marketBuyRegistry,
    reserveCsfloat: reserveCsfloatBudget,
    now: () => Date.now(),
    botsEnabled: MARKET_BUY_BOTS_ENABLED,
    csmoneyMarketEnabled: MARKET_BUY_CSMONEY_MARKET_ENABLED,
    readTimeoutMs: MARKET_BUY_READ_TIMEOUT_MS,
    listingReadTimeoutMs: MARKET_BUY_LISTING_READ_TIMEOUT_MS,
    buyTimeoutMs: MARKET_BUY_REQUEST_TIMEOUT_MS,
    accounts: marketAccountCache,
  };
}

const TIMEOUT: MarketBuyAnswer = { ok: false, status: 0, data: null, error: 'timeout' };

/**
 * The answer, or a timeout answer after `ms`. The request is not aborted: a late answer still reaches `onLate` (the buy
 * request's late answer releases or confirms the unknown hold).
 */
function withTimeout(pending: Promise<MarketBuyAnswer>, ms: number, onLate?: (answer: MarketBuyAnswer) => void): Promise<MarketBuyAnswer> {
  const safe = pending.catch((): MarketBuyAnswer => ({ ok: false, status: 0, data: null, error: 'network' }));
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MarketBuyAnswer>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(TIMEOUT);
    }, ms);
  });
  void safe.then((answer) => {
    clearTimeout(timer);
    if (timedOut) onLate?.(answer);
    return undefined;
  });
  return Promise.race([safe, timeout]);
}

/** What one market's flow found, before the common fields are added. */
interface Attempt {
  verdict: MarketBuyVerdict;
  sent: boolean;
  requestedAt?: number;
  answer?: MarketBuyAnswer;
  balanceCents?: number;
  next?: MarketBuyNext;
}

function stopped(verdict: MarketBuyVerdict, balanceCents?: number | null): Attempt {
  return { verdict, sent: false, ...(typeof balanceCents === 'number' ? { balanceCents } : {}) };
}

function rawOf(answer: MarketBuyAnswer | undefined, verdict: MarketBuyVerdict): MarketBuyRaw | undefined {
  if (!answer) return undefined;
  const body = buyAnswerDigest(answer.data);
  return { status: answer.status, ...(verdict.code ? { code: verdict.code } : {}), ...(body ? { body } : {}) };
}

/** Hands the buy request to the network: persisted as sent first, so a worker that stops now leaves an unknown, not a free listing. */
async function sendOnce(
  request: MarketBuyRequest,
  platform: MarketPlatformId,
  built: OperationRequest,
  deps: MarketBuyDeps,
  classifyLate: (answer: MarketBuyAnswer) => MarketBuyVerdict
): Promise<{ answer: MarketBuyAnswer; requestedAt: number }> {
  await deps.registry.markSent(request.attemptId);
  const requestedAt = deps.now();
  const answer = await withTimeout(deps.send(platform, built, deps.buyTimeoutMs), deps.buyTimeoutMs, (late) => {
    void deps.registry.settleLate(request.attemptId, classifyLate(late).outcome);
  });
  return { answer, requestedAt };
}

function account(check: MarketAccountCheck): number | undefined {
  return check.ok ? (check.balanceCents ?? undefined) : check.balanceCents;
}

/**
 * The account step (R-C2): a read of the marketplace account, checked against the linked Steam account and the price.
 * QUICK-233: a buy-order attempt with a confirmation of that Steam account younger than the cache's TTL uses it (its
 * balance, minus buys since, is checked against the price the same way) and sends no read; every read the executor
 * makes refreshes the confirmation, or drops it when the read did not confirm the account.
 */
async function accountStep(
  platform: AccountPlatform,
  request: MarketBuyRequest,
  deps: MarketBuyDeps,
  read: () => Promise<MarketBuyAnswer>,
  check: (answer: MarketBuyAnswer) => MarketAccountCheck
): Promise<MarketAccountCheck> {
  const { steamId, priceCents } = request;
  const cached = request.origin.kind === 'buy_order' && steamId ? deps.accounts?.get(platform, steamId) : null;
  if (cached) {
    if (cached.balanceCents !== null && cached.balanceCents < priceCents)
      return {
        ok: false,
        verdict: { outcome: 'insufficient_balance', reason: 'balance_short', shortCents: priceCents - cached.balanceCents },
        balanceCents: cached.balanceCents,
      };
    return { ok: true, balanceCents: cached.balanceCents };
  }
  const result = check(await read());
  // A confirmation only with the linked Steam account to compare: without one the read proves nothing about it.
  if (steamId) {
    if (result.ok) deps.accounts?.put(platform, steamId, result.balanceCents);
    else deps.accounts?.invalidate(platform);
  }
  return result;
}

/** QUICK-233: the caller's last word before the buy request (`MarketBuyOptions.beforeSend`); a failure stops it. */
async function gate(request: MarketBuyRequest, options: MarketBuyOptions): Promise<string | null> {
  if (!options.beforeSend) return null;
  try {
    return await options.beforeSend(request);
  } catch {
    return 'gate_failed';
  }
}

const ACCOUNT_REASONS: ReadonlySet<string> = new Set(['steam_account_mismatch', 'account_unconfirmed', 'account_401', 'account_no_user', 'balance_short']);

/**
 * After any purchase (manual too): a buy that may have spent lowers the cached balance; an account error drops it, and
 * so does any answer that refused the session (401/403).
 */
function updateAccountCache(accounts: MarketAccountCache | undefined, request: MarketBuyRequest, result: MarketBuyResult): void {
  if (!accounts) return;
  const platform: AccountPlatform = request.source === 'csfloat' ? 'csfloat.com' : 'cs.money';
  if (result.sent && (result.outcome === 'bought' || result.outcome === 'unknown')) accounts.spend(platform, request.priceCents);
  if (
    result.outcome === 'insufficient_balance' ||
    result.outcome === 'signed_out' ||
    result.outcome === 'cannot_trade' ||
    result.outcome === 'two_factor_required' ||
    ACCOUNT_REASONS.has(result.reason ?? '') ||
    result.raw?.status === 401 ||
    result.raw?.status === 403
  )
    accounts.invalidate(platform);
}

// ─── CSFloat ───────────────────────────────────────────────────────────────────────────────────────

async function buyOnCsfloat(request: MarketBuyRequest, deps: MarketBuyDeps, options: MarketBuyOptions): Promise<Attempt> {
  const { listingId, priceCents } = request;
  // The account first, the listing last: the price the request carries was read at most a few seconds before it leaves.
  const profile = await accountStep(
    'csfloat.com',
    request,
    deps,
    () => withTimeout(deps.read('csfloat.com', csfloatAccountReadRequest(), deps.readTimeoutMs), deps.readTimeoutMs),
    (answer) => checkCsfloatAccount(answer, priceCents, request.steamId)
  );
  if (!profile.ok) return stopped(profile.verdict, profile.balanceCents);
  const listingAnswer = await withTimeout(deps.read('csfloat.com', csfloatListingReadRequest(listingId), deps.listingReadTimeoutMs), deps.listingReadTimeoutMs);
  const listing = checkCsfloatListing(listingAnswer, listingId, priceCents, deps.now());
  if (!listing.ok) return stopped(listing.verdict, account(profile));
  const refusal = await gate(request, options);
  if (refusal) return stopped({ outcome: 'not_sent', reason: refusal }, account(profile));

  // R-N1: `total_price` is the confirmed `priceCents`, which the re-read just showed is CSFloat's current price.
  const built = csfloatBuyRequest(listingId, priceCents, request.twoFactorCode);
  const { answer, requestedAt } = await sendOnce(request, 'csfloat.com', built, deps, (late) => classifyCsfloatBuyAnswer(late, deps.now()));
  let verdict = classifyCsfloatBuyAnswer(answer, deps.now());
  if (verdict.outcome === 'price_changed' && verdict.newPriceCents === undefined) {
    // Code 15 names no price: one more read for the "buy at the new price" offer (a GET, never the purchase).
    const again = checkCsfloatListing(await withTimeout(deps.read('csfloat.com', csfloatListingReadRequest(listingId), deps.readTimeoutMs), deps.readTimeoutMs), listingId, priceCents, deps.now());
    if (!again.ok && again.verdict.newPriceCents !== undefined) verdict = { ...verdict, newPriceCents: again.verdict.newPriceCents };
  }
  const balanceCents = account(profile);
  return { verdict, sent: true, requestedAt, answer, next: listing.next, ...(balanceCents !== undefined ? { balanceCents } : {}) };
}

// ─── cs.money market ───────────────────────────────────────────────────────────────────────────────

async function buyOnCsMoneyMarket(request: MarketBuyRequest, deps: MarketBuyDeps, options: MarketBuyOptions): Promise<Attempt> {
  const { listingId, priceCents } = request;
  // The account first, the sell order last: the price the request carries was read right before it leaves.
  const profile = await accountStep(
    'cs.money',
    request,
    deps,
    () => withTimeout(deps.read('cs.money', csMoneyAccountReadRequest(), deps.readTimeoutMs), deps.readTimeoutMs),
    (answer) => checkCsMoneyAccount(answer, priceCents, request.steamId)
  );
  if (!profile.ok) return stopped(profile.verdict, profile.balanceCents);
  const orderAnswer = await withTimeout(deps.read('cs.money', csMoneySellOrderReadRequest(listingId), deps.listingReadTimeoutMs), deps.listingReadTimeoutMs);
  const order = checkCsMoneySellOrder(orderAnswer, listingId, priceCents, deps.now());
  if (!order.ok) return stopped(order.verdict, account(profile));
  const refusal = await gate(request, options);
  if (refusal) return stopped({ outcome: 'not_sent', reason: refusal }, account(profile));

  // R-N1: `price` is `centsToUsd(priceCents)`; the re-read just showed `pricing.computed` is exactly that number.
  const built = csMoneyPurchaseRequest(listingId, priceCents);
  const { answer, requestedAt } = await sendOnce(request, 'cs.money', built, deps, (late) => classifyCsMoneyPurchaseAnswer(late, deps.now()));
  let verdict = classifyCsMoneyPurchaseAnswer(answer, deps.now());
  if (verdict.outcome === 'price_changed' && verdict.newPriceCents === undefined) {
    const again = checkCsMoneySellOrder(await withTimeout(deps.read('cs.money', csMoneySellOrderReadRequest(listingId), deps.readTimeoutMs), deps.readTimeoutMs), listingId, priceCents, deps.now());
    if (!again.ok && again.verdict.newPriceCents !== undefined) verdict = { ...verdict, newPriceCents: again.verdict.newPriceCents };
  }
  const balanceCents = account(profile);
  return { verdict, sent: true, requestedAt, answer, next: order.next, ...(balanceCents !== undefined ? { balanceCents } : {}) };
}

// ─── cs.money bots (MARKET_BUY_BOTS_ENABLED) ──────────────────────────────────────────────────────

async function buyFromCsMoneyBots(request: MarketBuyRequest, deps: MarketBuyDeps, options: MarketBuyOptions): Promise<Attempt> {
  const { listingId, priceCents, item } = request;
  if (!item) return stopped({ outcome: 'not_sent', reason: 'item_required' });
  // The trade balance (not the market balance the page shows) pays: cs.money checks it on the hold (code 19), before
  // anything is charged. The page still tells the login and the Steam account; the bot row is read last.
  const profile = checkCsMoneyAccount(await withTimeout(deps.read('cs.money', csMoneyAccountReadRequest(), deps.readTimeoutMs), deps.readTimeoutMs), 0, request.steamId);
  if (!profile.ok) return stopped(profile.verdict);
  const rowAnswer = await withTimeout(deps.read('cs.money', csMoneyBotReadRequest(item.name, item.float), deps.listingReadTimeoutMs), deps.listingReadTimeoutMs);
  const found = checkCsMoneyBotRow(rowAnswer, listingId, priceCents, deps.now());
  if (!found.ok) return stopped(found.verdict);
  if (!found.row) return stopped({ outcome: 'not_sent', reason: 'reread_unreadable' });
  const refusal = await gate(request, options);
  if (refusal) return stopped({ outcome: 'not_sent', reason: refusal });

  // The hold carries `balance: -centsToUsd(priceCents)`; it is confirmed only when cs.money moved exactly that.
  const hold = await sendOnce(request, 'cs.money', csMoneyBotHoldRequest(found.row, priceCents), deps, (late) => {
    const verdict = classifyCsMoneyHoldAnswer(late, priceCents, deps.now());
    // A late hold is never confirmed: it expires by itself, nothing is bought.
    return verdict.held ? { outcome: 'refused', reason: 'hold_late' } : verdict.verdict;
  });
  const held = classifyCsMoneyHoldAnswer(hold.answer, priceCents, deps.now());
  if (!held.held) {
    if (held.offerId === undefined) return { verdict: held.verdict, sent: true, requestedAt: hold.requestedAt, answer: hold.answer };
    // A hold at another price is released at once (it would expire in about 6 minutes anyway).
    const decline = await withTimeout(deps.send('cs.money', csMoneyBotDeclineRequest(held.offerId), deps.readTimeoutMs), deps.readTimeoutMs);
    const released = decline.ok && typeof decline.data === 'object' && decline.data !== null && (decline.data as { status?: unknown }).status === true;
    return { verdict: { outcome: 'refused', reason: released ? 'hold_mismatch_declined' : 'hold_mismatch_expires' }, sent: true, requestedAt: hold.requestedAt, answer: hold.answer };
  }
  const confirm = await withTimeout(deps.send('cs.money', csMoneyBotConfirmRequest(held.offerId), deps.buyTimeoutMs), deps.buyTimeoutMs, (late) => {
    void deps.registry.settleLate(request.attemptId, classifyCsMoneyConfirmAnswer(late, deps.now()).outcome);
  });
  let verdict = classifyCsMoneyConfirmAnswer(confirm, deps.now());
  if (verdict.reason === 'confirm_refused') {
    // cs.money would not confirm: release the hold now instead of leaving the money reserved until it expires.
    const decline = await withTimeout(deps.send('cs.money', csMoneyBotDeclineRequest(held.offerId), deps.readTimeoutMs), deps.readTimeoutMs);
    const released = decline.ok && typeof decline.data === 'object' && decline.data !== null && (decline.data as { status?: unknown }).status === true;
    verdict = { ...verdict, reason: released ? 'confirm_refused_declined' : 'confirm_refused' };
  }
  return { verdict, sent: true, requestedAt: hold.requestedAt, answer: confirm, ...(verdict.next ? { next: verdict.next } : {}) };
}

// ─── The executor ──────────────────────────────────────────────────────────────────────────────────

function baseOf(input: unknown): Pick<MarketBuyResult, 'requestId' | 'attemptId' | 'source' | 'listingId' | 'priceCents'> {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string).slice(0, 64) : '');
  const source = value['source'] === 'csmoney-market' || value['source'] === 'csmoney-bots' ? value['source'] : 'csfloat';
  const price = value['priceCents'];
  return {
    requestId: text('requestId'),
    attemptId: text('attemptId'),
    source,
    listingId: text('listingId'),
    priceCents: typeof price === 'number' && Number.isSafeInteger(price) ? price : 0,
  };
}

/** A purchase refused before the executor (an origin that may not buy): nothing claimed, read or sent. */
export function refusedMarketBuy(input: unknown, reason: string): MarketBuyResult {
  return { ...baseOf(input), outcome: 'not_sent', sent: false, reason, settledAt: Date.now() };
}

function busyResult(request: MarketBuyRequest, reason: BusyReason, now: number, until?: number): MarketBuyResult {
  return {
    requestId: request.requestId,
    attemptId: request.attemptId,
    source: request.source,
    listingId: request.listingId,
    priceCents: request.priceCents,
    outcome: 'busy',
    sent: false,
    reason,
    ...(until ? { retryAt: until } : {}),
    settledAt: now,
  };
}

function log(result: MarketBuyResult): void {
  // Outcome codes only: no listing, price, account or answer body.
  console.info('[qts background] market buy', { source: result.source, outcome: result.outcome, reason: result.reason, sent: result.sent, status: result.raw?.status });
}

/**
 * Runs one buy attempt and answers its result; never throws. Nothing is sent for a malformed request, a source that is
 * off, or a listing another attempt holds.
 */
export async function executeMarketBuy(input: unknown, deps: MarketBuyDeps = defaultMarketBuyDeps(), options: MarketBuyOptions = {}): Promise<MarketBuyResult> {
  const request = parseMarketBuyRequest(input);
  if (!request) return { ...baseOf(input), outcome: 'not_sent', sent: false, reason: 'invalid_request', settledAt: deps.now() };
  if (request.source === 'csmoney-bots' && !deps.botsEnabled) return { ...baseOf(request), outcome: 'not_sent', sent: false, reason: 'source_disabled', settledAt: deps.now() };
  if (request.source === 'csmoney-market' && !deps.csmoneyMarketEnabled) return { ...baseOf(request), outcome: 'not_sent', sent: false, reason: 'source_disabled', settledAt: deps.now() };
  // QUICK-233: an automatic purchase always checks the marketplace session against the linked Steam account.
  if (request.origin.kind === 'buy_order' && !request.steamId) return { ...baseOf(request), outcome: 'not_sent', sent: false, reason: 'steam_link_required', settledAt: deps.now() };

  const claim = await deps.registry.claim(request);
  if (claim.kind === 'replay') return { ...claim.result, requestId: request.requestId };
  // The same attempt's message again while it runs: answer its result when it comes, never a refusal.
  if (claim.kind === 'running') return { ...(await claim.result), requestId: request.requestId };
  if (claim.kind === 'busy') {
    const busy = busyResult(request, claim.reason, deps.now(), claim.until);
    log(busy);
    return busy;
  }

  // A CSFloat attempt sends at most three CSFloat requests (the re-read, the buy, one more read after code 15): the live
  // feed leaves them to it until the attempt ends.
  // TTL: the account and listing reads, the buy and the read after code 15, each at its own timeout, plus a margin.
  const reserveMs = deps.readTimeoutMs + deps.listingReadTimeoutMs + deps.buyTimeoutMs + deps.readTimeoutMs + 5_000;
  const release = request.source === 'csfloat' ? deps.reserveCsfloat(3, reserveMs) : () => undefined;
  let attempt: Attempt;
  try {
    attempt =
      request.source === 'csfloat'
        ? await buyOnCsfloat(request, deps, options)
        : request.source === 'csmoney-market'
          ? await buyOnCsMoneyMarket(request, deps, options)
          : await buyFromCsMoneyBots(request, deps, options);
  } catch {
    // A fault in QTS's own code: unknown once the buy request may have left, else nothing was sent.
    const sent = deps.registry.snapshot().some((record) => record.attemptId === request.attemptId && record.sent);
    attempt = { verdict: { outcome: sent ? 'unknown' : 'not_sent', reason: 'executor_error' }, sent };
  } finally {
    release();
  }

  const { verdict } = attempt;
  const raw = rawOf(attempt.answer, verdict);
  const result: MarketBuyResult = {
    requestId: request.requestId,
    attemptId: request.attemptId,
    source: request.source,
    listingId: request.listingId,
    priceCents: request.priceCents,
    outcome: verdict.outcome,
    sent: attempt.sent,
    reason: verdict.reason,
    ...(verdict.newPriceCents !== undefined ? { newPriceCents: verdict.newPriceCents } : {}),
    ...(attempt.balanceCents !== undefined ? { balanceCents: attempt.balanceCents } : {}),
    ...(verdict.shortCents !== undefined ? { shortCents: verdict.shortCents } : {}),
    ...(verdict.retryAt !== undefined ? { retryAt: verdict.retryAt } : {}),
    ...(verdict.outcome === 'bought' && attempt.next ? { next: attempt.next } : {}),
    ...(raw ? { raw } : {}),
    ...(attempt.requestedAt !== undefined ? { requestedAt: attempt.requestedAt } : {}),
    settledAt: deps.now(),
  };
  await deps.registry.settle(result);
  updateAccountCache(deps.accounts, request, result);
  log(result);
  return result;
}

/**
 * QUICK-233: reads the marketplace account ahead of a buy (the buy-order engine keeps its confirmation fresh, so an
 * automatic attempt needs no account read): true when the session is the linked Steam account. The same read and check
 * as a purchase's account step, with no price.
 */
export async function confirmMarketAccount(platform: AccountPlatform, steamId: string, deps: MarketBuyDeps = defaultMarketBuyDeps()): Promise<boolean> {
  const read = platform === 'csfloat.com' ? csfloatAccountReadRequest() : csMoneyAccountReadRequest();
  const answer = await withTimeout(deps.read(platform, read, deps.readTimeoutMs), deps.readTimeoutMs);
  const check = platform === 'csfloat.com' ? checkCsfloatAccount(answer, 0, steamId) : checkCsMoneyAccount(answer, 0, steamId);
  if (check.ok) deps.accounts?.put(platform, steamId, check.balanceCents);
  else deps.accounts?.invalidate(platform);
  return check.ok;
}
