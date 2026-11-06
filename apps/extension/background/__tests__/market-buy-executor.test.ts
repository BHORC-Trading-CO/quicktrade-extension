// QUICK-226: the buy executor against fixture answers (no marketplace is ever called). Every R-C3 state, "one attempt per
// listing", "an unknown outcome is never retried" and, per market, "the price in the request body is the confirmed price"
// (R-N1).
import type { MarketBuyAnswer, MarketBuyRequest, MarketBuyResult, OperationRequest } from '@qts/contracts';
import { MARKET_BUY_UNKNOWN_HOLD_MS } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttemptRegistry, ATTEMPTS_SESSION_KEY, IN_FLIGHT_STALE_MS, type SessionArea } from '../market-buy/attempt-registry';
import { executeMarketBuy, type MarketBuyDeps } from '../market-buy/executor';

const NOW = 1_800_000_000_000;
const STEAM_ID = '76561198000000001';

let clock = NOW;
let session: Record<string, unknown>;
let reads: Array<{ platform: string; request: OperationRequest }>;
let sends: Array<{ platform: string; request: OperationRequest }>;
let readAnswers: Array<[RegExp, MarketBuyAnswer | (() => Promise<MarketBuyAnswer>)]>;
let sendAnswers: Array<MarketBuyAnswer | (() => Promise<MarketBuyAnswer>)>;
let registry: AttemptRegistry;
let reservations: Array<{ requests: number; ttlMs: number; released: boolean }>;

function json(status: number, data: unknown, headers: Record<string, string> = {}): MarketBuyAnswer {
  return { ok: status >= 200 && status < 300, status, data, headers: { 'content-type': 'application/json', ...headers } };
}

function html(page: string): MarketBuyAnswer {
  return { ok: true, status: 200, data: page, headers: { 'content-type': 'text/html' } };
}

const area: SessionArea = {
  get: async (key) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
  set: async (items) => void Object.assign(session, structuredClone(items)),
};

function deps(overrides: Partial<MarketBuyDeps> = {}): MarketBuyDeps {
  return {
    read: async (platform, built) => {
      reads.push({ platform, request: built });
      const found = readAnswers.find(([pattern]) => pattern.test(built.url));
      if (!found) throw new Error(`no fixture for ${built.url}`);
      const answer = found[1];
      return typeof answer === 'function' ? answer() : answer;
    },
    send: async (platform, built) => {
      sends.push({ platform, request: built });
      const answer = sendAnswers.shift();
      if (!answer) throw new Error(`no fixture for ${built.method} ${built.url}`);
      return typeof answer === 'function' ? answer() : answer;
    },
    registry,
    reserveCsfloat: (requests, ttlMs) => {
      const reservation = { requests, ttlMs, released: false };
      reservations.push(reservation);
      return () => {
        reservation.released = true;
      };
    },
    now: () => clock,
    botsEnabled: false,
    // The cs.money market path is tested as it runs once switched on; the switch itself has its own case.
    csmoneyMarketEnabled: true,
    readTimeoutMs: 1_000,
    listingReadTimeoutMs: 1_000,
    buyTimeoutMs: 1_000,
    ...overrides,
  };
}

let attemptCounter = 0;
function attemptId(): string {
  attemptCounter += 1;
  return `00000000-0000-4000-8000-${String(attemptCounter).padStart(12, '0')}`;
}

function request(overrides: Partial<MarketBuyRequest> = {}): MarketBuyRequest {
  return {
    requestId: `r${attemptCounter}`,
    attemptId: attemptId(),
    source: 'csfloat',
    listingId: '813296748293324890',
    priceCents: 26_800,
    origin: { kind: 'manual' },
    steamId: STEAM_ID,
    ...overrides,
  };
}

function csfloatListing(overrides: Record<string, unknown> = {}): MarketBuyAnswer {
  return json(200, { id: '813296748293324890', state: 'listed', type: 'buy_now', price: 26_800, seller: { away: false, steam_id: '76561198000000999' }, ...overrides });
}

function csfloatMe(balance = 124_050, steamId = STEAM_ID): MarketBuyAnswer {
  return json(200, { user: { steam_id: steamId, balance, pending_balance: 0 } });
}

const LISTING_URL = /^https:\/\/csfloat\.com\/api\/v1\/listings\/813296748293324890$/;
const ME_URL = /^https:\/\/csfloat\.com\/api\/v1\/me$/;
const ORDER_URL = /^https:\/\/cs\.money\/2\.0\/market\/sell-orders\/555000111$/;
const PAGE_URL = /^https:\/\/cs\.money\/market\/buy\/$/;
const BOTS_URL = /^https:\/\/cs\.money\/6\.0\/load_bots_inventory\/730\?/;

function csMoneyPage(balanceCents: number | null = 50_000, steamId = STEAM_ID): MarketBuyAnswer {
  const balance = balanceCents === null ? '' : `,"marketBalance":{"balance":${balanceCents},"currency":"USD"}`;
  return html(`<html><script>window.__STATE__={"userInfo":{"steamId64":"${steamId}","username":"fixture"}${balance}}</script></html>`);
}

function sellOrder(computed: number, extra: Record<string, unknown> = {}): MarketBuyAnswer {
  return json(200, { item: { id: 555000111, pricing: { computed, default: computed }, asset: { names: { full: 'AK-47 | Redline (Field-Tested)' } }, ...extra } });
}

beforeEach(() => {
  clock = NOW;
  session = {};
  reads = [];
  sends = [];
  readAnswers = [
    [LISTING_URL, csfloatListing()],
    [ME_URL, csfloatMe()],
    [ORDER_URL, sellOrder(12.34)],
    [PAGE_URL, csMoneyPage()],
  ];
  sendAnswers = [];
  reservations = [];
  registry = new AttemptRegistry(
    () => area,
    () => clock
  );
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function sentBody(index = 0): unknown {
  const sent = sends[index];
  if (!sent?.request.body) throw new Error('no buy request body');
  return JSON.parse(sent.request.body);
}

describe('CSFloat buy now', () => {
  it('re-reads the listing and the balance, then sends one buy with exactly the confirmed cents', async () => {
    sendAnswers = [json(200, { message: 'success', trade: { id: 'T1', buyer_id: STEAM_ID, trade_token: 'secret-token' } })];
    const result = await executeMarketBuy(request(), deps());

    // The account first, the listing last, right before the buy.
    expect(reads.map((read) => read.request.url)).toEqual(['https://csfloat.com/api/v1/me', 'https://csfloat.com/api/v1/listings/813296748293324890']);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ platform: 'csfloat.com', request: { url: 'https://csfloat.com/api/v1/listings/buy', method: 'POST', headers: { 'Content-Type': 'application/json' } } });
    expect(sends[0]?.request.body).toBe('{"total_price":26800,"contract_ids":["813296748293324890"]}');
    expect(result).toMatchObject({ outcome: 'bought', sent: true, priceCents: 26_800, next: 'seller_sends_offer', balanceCents: 124_050, requestedAt: NOW });
    // The journal copy keeps the shape and the message, never the buyer's id or the trade token.
    expect(result.raw?.status).toBe(200);
    expect(result.raw?.body).toContain('"message":"success"');
    expect(result.raw?.body).not.toContain('secret-token');
    expect(result.raw?.body).not.toContain(STEAM_ID);
    // The live feed (QUICK-231) left CSFloat requests to the attempt, released when it ended.
    // TTL: account read + listing read + buy + one more read + 5 s, so it cannot lapse before the read after code 15.
    expect(reservations).toEqual([{ requests: 3, ttlMs: 9_000, released: true }]);
  });

  it.each([1, 99, 100, 1_234, 26_800, 999_999, 9_999_999])('R-N1: the request carries total_price = %i, the price the user confirmed', async (cents) => {
    readAnswers.unshift([LISTING_URL, csfloatListing({ price: cents })], [ME_URL, csfloatMe(10_000_000)]);
    sendAnswers = [json(200, {})];
    const result = await executeMarketBuy(request({ priceCents: cents }), deps());
    expect(sentBody()).toEqual({ total_price: cents, contract_ids: ['813296748293324890'] });
    expect(result).toMatchObject({ outcome: 'bought', priceCents: cents });
  });

  it.each([
    ['the price rose', csfloatListing({ price: 27_900 }), { outcome: 'price_changed', reason: 'price_rose', newPriceCents: 27_900 }],
    ['the price fell', csfloatListing({ price: 25_000 }), { outcome: 'price_changed', reason: 'price_fell', newPriceCents: 25_000 }],
    ['it was sold', csfloatListing({ state: 'sold' }), { outcome: 'sold', reason: 'listing_sold' }],
    ['it was delisted', csfloatListing({ state: 'delisted' }), { outcome: 'sold', reason: 'listing_not_listed' }],
    ['its id is dead (404)', json(404, { code: 2, message: 'unknown resource' }), { outcome: 'sold', reason: 'listing_gone' }],
    ['its id is dead (400 code 2)', json(400, { code: 2, message: 'unknown resource' }), { outcome: 'sold', reason: 'listing_gone' }],
    ['it is an auction', csfloatListing({ type: 'auction' }), { outcome: 'refused', reason: 'not_buy_now' }],
    ['the seller is away', csfloatListing({ seller: { away: true } }), { outcome: 'refused', reason: 'seller_away' }],
    ['Cloudflare challenges the read', json(403, '<html>', { 'cf-mitigated': 'challenge' }), { outcome: 'captcha', reason: 'reread_captcha' }],
    ['the read is rate limited', json(429, { code: 429 }, { 'retry-after': '120' }), { outcome: 'rate_limited', reason: 'reread_429', retryAt: NOW + 120_000 }],
    ['the read fails', json(500, { message: 'oops' }), { outcome: 'not_sent', reason: 'reread_http_500' }],
    ['the extension refuses the read', { ok: false, status: 403, data: null, error: 'operation_refused:path' }, { outcome: 'not_sent', reason: 'operation_refused:path' }],
  ])('R-C2: buys nothing when %s', async (_name, listing, expected) => {
    readAnswers.unshift([LISTING_URL, listing]);
    const result = await executeMarketBuy(request(), deps());
    expect(sends).toEqual([]);
    expect(result).toMatchObject({ ...expected, sent: false });
  });

  it.each([
    ['the balance does not cover it', csfloatMe(26_799), { outcome: 'insufficient_balance', shortCents: 1, balanceCents: 26_799 }],
    ['CSFloat is signed out (401)', json(401, { code: 1, message: 'unauthorized' }), { outcome: 'signed_out' }],
    ['the session is another Steam account', csfloatMe(124_050, '76561198000000002'), { outcome: 'refused', reason: 'steam_account_mismatch' }],
  ])('R-C2: buys nothing when %s', async (_name, me, expected) => {
    readAnswers.unshift([ME_URL, me]);
    const result = await executeMarketBuy(request(), deps());
    expect(sends).toEqual([]);
    expect(result).toMatchObject({ ...expected, sent: false });
  });

  it.each([
    ['a 5xx', json(503, {})],
    ['an HTML page', json(200, '<html>maintenance</html>')],
    ['no answer', { ok: false, status: 0, data: null, error: 'network' } satisfies MarketBuyAnswer],
    ['a profile without a Steam id', json(200, { user: { balance: 124_050 } })],
  ])('the linked account must be confirmed: %s on /me buys nothing (account_unconfirmed)', async (_name, me) => {
    readAnswers.unshift([ME_URL, me]);
    const result = await executeMarketBuy(request(), deps());
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'account_unconfirmed', sent: false });
    expect(sends).toEqual([]);
    // Nothing more is read once the account is unconfirmed: the listing read comes after.
    expect(reads.map((read) => read.request.url)).toEqual(['https://csfloat.com/api/v1/me']);
  });

  it.each([
    ['csfloat', ME_URL, 'https://csfloat.com/*'],
    ['csmoney-market', PAGE_URL, 'https://cs.money/*'],
  ] as const)('%s: no access to the marketplace on the account read says so (permission_denied), not "try again"', async (source, url, origin) => {
    readAnswers.unshift([url, { ok: false, status: 403, data: null, error: `permission_denied: ${origin}` }]);
    const attempt = source === 'csfloat' ? request() : request({ source, listingId: '555000111', priceCents: 1_234 });
    expect(await executeMarketBuy(attempt, deps())).toMatchObject({ outcome: 'not_sent', reason: 'permission_denied', sent: false });
    expect(sends).toEqual([]);
  });

  it('a profile read that fails while the read times out is unconfirmed too', async () => {
    readAnswers.unshift([ME_URL, () => new Promise<MarketBuyAnswer>(() => undefined)]);
    const result = await executeMarketBuy(request(), deps({ readTimeoutMs: 5 }));
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'account_unconfirmed' });
    expect(sends).toEqual([]);
  });

  it('without a linked Steam account to match, a failed profile read does not stop the buy (CSFloat checks the balance)', async () => {
    readAnswers.unshift([ME_URL, json(503, {})]);
    sendAnswers = [json(200, {})];
    const result = await executeMarketBuy(request({ steamId: undefined }), deps());
    expect(result).toMatchObject({ outcome: 'bought' });
    expect(result.balanceCents).toBeUndefined();
  });

  it.each([
    ['already sold (code 4)', json(400, { code: 4, message: 'listing sold' }), { outcome: 'sold', reason: 'code_4' }],
    ['invalid purchase state (422 code 6)', json(422, { code: 6, message: 'invalid purchase state' }), { outcome: 'sold', reason: 'code_6' }],
    ['cannot trade on Steam (code 125)', json(400, { code: 125, message: "Can't trade" }), { outcome: 'cannot_trade', reason: 'code_125' }],
    ['another refusal with a code', json(400, { code: 77, message: 'nope' }), { outcome: 'refused', reason: 'code_77' }],
    ['a 2xx with an HTML page (not CSFloat’s answer)', json(200, '<html>proxy</html>'), { outcome: 'unknown', reason: 'ok_not_json' }],
    ['a 2xx with an empty body', { ok: true, status: 200, data: null, headers: {} } satisfies MarketBuyAnswer, { outcome: 'unknown', reason: 'ok_not_json' }],
    ['signed out on the buy (401)', json(401, {}), { outcome: 'signed_out' }],
    ['Cloudflare challenge on the buy', json(403, '<html>', { 'cf-mitigated': 'challenge' }), { outcome: 'captcha' }],
  ])('R-C3: %s', async (_name, answer, expected) => {
    sendAnswers = [answer];
    const result = await executeMarketBuy(request(), deps());
    expect(sends).toHaveLength(1);
    expect(result).toMatchObject({ ...expected, sent: true });
  });

  it('R-C3: a price change on the buy (code 15) offers the new price from one more read', async () => {
    sendAnswers = [json(400, { code: 15, message: 'price changed' })];
    readAnswers = [
      [LISTING_URL, csfloatListing()],
      [ME_URL, csfloatMe()],
    ];
    const first = deps();
    let listingReads = 0;
    first.read = async (platform, built) => {
      reads.push({ platform, request: built });
      if (ME_URL.test(built.url)) return csfloatMe();
      listingReads += 1;
      return listingReads === 1 ? csfloatListing() : csfloatListing({ price: 27_900 });
    };
    const result = await executeMarketBuy(request(), first);
    expect(sends).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'price_changed', reason: 'code_15', newPriceCents: 27_900, sent: true });
  });

  it('R-C3: 429 on the buy counts down to CSFloat’s reset', async () => {
    const reset = String(Math.floor((NOW + 252_000) / 1000));
    sendAnswers = [json(429, { code: 429 }, { 'x-ratelimit-reset': reset, date: new Date(NOW).toUTCString() })];
    const result = await executeMarketBuy(request(), deps());
    expect(result).toMatchObject({ outcome: 'rate_limited', sent: true, retryAt: NOW + 252_000 });
  });

  it('2FA: code 123 asks for the code; the next attempt sends it as Two-Factor, never stored in the result', async () => {
    sendAnswers = [json(400, { code: 123, message: '2fa required' }), json(200, {})];
    const first = await executeMarketBuy(request(), deps());
    expect(first).toMatchObject({ outcome: 'two_factor_required', sent: true });

    const second = await executeMarketBuy(request({ twoFactorCode: '123456' }), deps());
    expect(sends[1]?.request.headers).toEqual({ 'Content-Type': 'application/json', 'Two-Factor': '123456' });
    expect(second).toMatchObject({ outcome: 'bought' });
    expect(JSON.stringify(second)).not.toContain('123456');
    expect(JSON.stringify(session)).not.toContain('123456');
  });

  it.each([
    ['a 5xx', json(502, '<html>bad gateway</html>'), 'http_502'],
    ['a 4xx without a CSFloat code', json(400, '<html>'), 'http_400'],
    ['no answer (network failure)', { ok: false, status: 0, data: null, error: 'network' }, 'network'],
  ])('R-C3: %s is unknown and never retried', async (_name, answer, reason) => {
    sendAnswers = [answer];
    const result = await executeMarketBuy(request(), deps());
    expect(result).toMatchObject({ outcome: 'unknown', reason, sent: true });

    // A new attempt on the same listing, from any tab or rule, is refused before any request.
    const readsBefore = reads.length;
    const again = await executeMarketBuy(request(), deps());
    expect(again).toMatchObject({ outcome: 'busy', reason: 'unknown_hold', sent: false, retryAt: NOW + MARKET_BUY_UNKNOWN_HOLD_MS });
    expect(sends).toHaveLength(1);
    expect(reads).toHaveLength(readsBefore);
  });

  it('R-C3: a timeout is unknown; the late answer settles the hold without a second request', async () => {
    let answerLate!: (answer: MarketBuyAnswer) => void;
    sendAnswers = [() => new Promise<MarketBuyAnswer>((resolve) => (answerLate = resolve))];
    const result = await executeMarketBuy(request(), deps({ buyTimeoutMs: 5 }));
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'timeout', sent: true, raw: { status: 0 } });
    expect(await executeMarketBuy(request(), deps())).toMatchObject({ outcome: 'busy', reason: 'unknown_hold' });

    // CSFloat answers after all: sold to someone else. The hold is released; a new attempt re-reads first.
    answerLate(json(400, { code: 4 }));
    await vi.waitFor(() => expect(registry.snapshot()[0]?.outcome).toBe('sold'));
    sendAnswers = [json(200, {})];
    expect(await executeMarketBuy(request(), deps())).toMatchObject({ outcome: 'bought' });
    expect(sends).toHaveLength(2);
  });

  it('a late purchase holds the listing as bought', async () => {
    let answerLate!: (answer: MarketBuyAnswer) => void;
    sendAnswers = [() => new Promise<MarketBuyAnswer>((resolve) => (answerLate = resolve))];
    await executeMarketBuy(request(), deps({ buyTimeoutMs: 5 }));
    answerLate(json(200, {}));
    await vi.waitFor(() => expect(registry.snapshot()[0]?.outcome).toBe('bought'));
    expect(await executeMarketBuy(request(), deps())).toMatchObject({ outcome: 'busy', reason: 'already_bought' });
    expect(sends).toHaveLength(1);
  });
});

describe('one attempt per listing (R-C4)', () => {
  it('a second concurrent request for the same listing is refused; one buy request is sent', async () => {
    let release!: () => void;
    readAnswers.unshift([LISTING_URL, () => new Promise<MarketBuyAnswer>((resolve) => (release = () => resolve(csfloatListing())))]);
    sendAnswers = [json(200, {})];
    const first = executeMarketBuy(request(), deps());
    const second = await executeMarketBuy(request(), deps());
    expect(second).toMatchObject({ outcome: 'busy', reason: 'in_flight', sent: false });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect(await first).toMatchObject({ outcome: 'bought' });
    expect(sends).toHaveLength(1);
  });

  it('a double click (the same attempt twice) is answered once and sent once', async () => {
    sendAnswers = [json(200, {})];
    const twice = request();
    const [a, b] = await Promise.all([executeMarketBuy(twice, deps()), executeMarketBuy({ ...twice, requestId: 'r-again' }, deps())]);
    // The repeat waits for the running attempt and answers its result (never "busy" / not sent), with its own request id.
    expect(a).toMatchObject({ outcome: 'bought', requestId: twice.requestId });
    expect(b).toMatchObject({ outcome: 'bought', requestId: 'r-again', attemptId: twice.attemptId });
    expect(sends).toHaveLength(1);
    // Replayed later: the same result, nothing sent again.
    const replay = await executeMarketBuy({ ...twice, requestId: 'r-third' }, deps());
    expect(replay).toMatchObject({ outcome: 'bought', requestId: 'r-third', attemptId: twice.attemptId });
    expect(sends).toHaveLength(1);
  });

  it('after a worker restart, a repeat of an attempt that still runs is "attempt_running", not a refusal of a new one', async () => {
    const running = request();
    session[ATTEMPTS_SESSION_KEY] = [{ key: 'csfloat:813296748293324890', attemptId: running.attemptId, state: 'in_flight', startedAt: NOW - 1_000, sent: true }];
    expect(await executeMarketBuy(running, deps())).toMatchObject({ outcome: 'busy', reason: 'attempt_running', sent: false });
    expect(await executeMarketBuy(request(), deps())).toMatchObject({ outcome: 'busy', reason: 'in_flight' });
    expect(reads).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('other listings are not held', async () => {
    readAnswers.unshift([/listings\/999$/, json(200, { id: '999', state: 'listed', type: 'buy_now', price: 26_800 })]);
    sendAnswers = [json(502, ''), json(200, {})];
    expect(await executeMarketBuy(request(), deps())).toMatchObject({ outcome: 'unknown' });
    expect(await executeMarketBuy(request({ listingId: '999' }), deps())).toMatchObject({ outcome: 'bought' });
  });

  it('a refusal releases the listing: "buy at the new price" is a new attempt that re-reads', async () => {
    readAnswers.unshift([LISTING_URL, csfloatListing({ price: 27_900 })]);
    expect(await executeMarketBuy(request(), deps())).toMatchObject({ outcome: 'price_changed', newPriceCents: 27_900 });
    sendAnswers = [json(200, {})];
    expect(await executeMarketBuy(request({ priceCents: 27_900 }), deps())).toMatchObject({ outcome: 'bought', priceCents: 27_900 });
    expect(sentBody()).toEqual({ total_price: 27_900, contract_ids: ['813296748293324890'] });
  });

  it('survives a worker restart: an attempt that never settled after its buy was sent holds the listing as unknown', async () => {
    session[ATTEMPTS_SESSION_KEY] = [{ key: 'csfloat:813296748293324890', attemptId: '00000000-0000-4000-8000-999999999999', state: 'in_flight', startedAt: NOW - IN_FLIGHT_STALE_MS - 1, sent: true }];
    const result = await executeMarketBuy(request(), deps());
    expect(result).toMatchObject({ outcome: 'busy', reason: 'unknown_hold' });
    expect(reads).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('an attempt that stopped before its buy was sent frees the listing', async () => {
    session[ATTEMPTS_SESSION_KEY] = [
      { key: 'csfloat:813296748293324890', attemptId: '00000000-0000-4000-8000-999999999999', state: 'in_flight', startedAt: NOW - IN_FLIGHT_STALE_MS - 1, sent: false },
    ];
    sendAnswers = [json(200, {})];
    expect(await executeMarketBuy(request(), deps())).toMatchObject({ outcome: 'bought' });
  });

  it('the unknown hold ends after MARKET_BUY_UNKNOWN_HOLD_MS', async () => {
    sendAnswers = [json(503, '')];
    await executeMarketBuy(request(), deps());
    clock = NOW + MARKET_BUY_UNKNOWN_HOLD_MS + 1;
    sendAnswers = [json(200, {})];
    expect(await executeMarketBuy(request(), deps())).toMatchObject({ outcome: 'bought' });
  });
});

describe('cs.money market purchase', () => {
  const order = (overrides: Partial<MarketBuyRequest> = {}) => request({ source: 'csmoney-market', listingId: '555000111', priceCents: 1_234, ...overrides });

  it('is refused before any request while the switch is off (the build default until the first live purchase)', async () => {
    const result = await executeMarketBuy(order(), deps({ csmoneyMarketEnabled: false }));
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'source_disabled', sent: false });
    expect(reads).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('re-reads the sell order and the page, then sends the confirmed price in USD', async () => {
    sendAnswers = [json(200, {})];
    const result = await executeMarketBuy(order(), deps());
    expect(reads.map((read) => read.request.url)).toEqual(['https://cs.money/market/buy/', 'https://cs.money/2.0/market/sell-orders/555000111']);
    expect(sends[0]).toMatchObject({ platform: 'cs.money', request: { url: 'https://cs.money/1.0/market/purchase', method: 'POST', headers: { 'Content-Type': 'application/json' } } });
    expect(sends[0]?.request.body).toBe('{"items":[{"id":"555000111","price":12.34}]}');
    expect(result).toMatchObject({ outcome: 'bought', sent: true, next: 'seller_sends_offer', balanceCents: 50_000 });
  });

  it.each([1, 5, 10, 99, 100, 101, 1_234, 1_999, 26_800, 100_001, 123_456_7])('R-N1: %i cents go out as the very number cs.money quotes (pricing.computed)', async (cents) => {
    const quoted = Number((cents / 100).toFixed(2));
    readAnswers.unshift([ORDER_URL, sellOrder(quoted)], [PAGE_URL, csMoneyPage(100_000_000)]);
    sendAnswers = [json(200, {})];
    const result = await executeMarketBuy(order({ priceCents: cents }), deps());
    expect(result.outcome).toBe('bought');
    const sentPrice = (sentBody() as { items: Array<{ price: number }> }).items[0]?.price;
    expect(sentPrice).toBe(quoted);
    expect(sends[0]?.request.body).toBe(`{"items":[{"id":"555000111","price":${JSON.stringify(quoted)}}]}`);
    expect(Math.round((sentPrice ?? 0) * 100)).toBe(cents);
  });

  it('a bot-owned sell order is instant delivery', async () => {
    readAnswers.unshift([ORDER_URL, sellOrder(12.34, { owner: { isBot: true } })]);
    sendAnswers = [json(200, {})];
    expect(await executeMarketBuy(order(), deps())).toMatchObject({ outcome: 'bought', next: 'instant_delivery' });
  });

  it.each([
    ['the price rose', sellOrder(12.99), { outcome: 'price_changed', newPriceCents: 1_299 }],
    ['the price is not a whole number of cents', sellOrder(12.345), { outcome: 'not_sent', reason: 'price_not_whole_cents' }],
    ['the order is gone (404)', json(404, {}), { outcome: 'sold', reason: 'listing_gone' }],
    ['the order is reserved (code 211)', json(400, { errors: [{ code: 211, error: 'ITEM_RESERVED' }] }), { outcome: 'sold', reason: 'code_211' }],
    ['the answer has no item', json(200, { item: null }), { outcome: 'sold', reason: 'listing_gone' }],
    ['the answer is unreadable', json(200, { something: 'else' }), { outcome: 'not_sent', reason: 'reread_unreadable' }],
    ['a captcha (4030)', json(200, { error: 4030 }), { outcome: 'captcha' }],
  ])('R-C2: buys nothing when %s', async (_name, answer, expected) => {
    readAnswers.unshift([ORDER_URL, answer]);
    const result = await executeMarketBuy(order(), deps());
    expect(sends).toEqual([]);
    expect(result).toMatchObject({ ...expected, sent: false });
  });

  it.each([
    ['the market balance is short', csMoneyPage(1_000), { outcome: 'insufficient_balance', shortCents: 234, balanceCents: 1_000 }],
    ['cs.money is signed out', html('<html>no state</html>'), { outcome: 'signed_out' }],
    ['the session is another Steam account', csMoneyPage(50_000, '76561198000000002'), { outcome: 'refused', reason: 'steam_account_mismatch' }],
    ['the page answers 5xx (account not confirmed)', json(502, '<html>bad gateway</html>'), { outcome: 'not_sent', reason: 'account_unconfirmed' }],
    ['the page does not answer (account not confirmed)', { ok: false, status: 0, data: null, error: 'timeout' } satisfies MarketBuyAnswer, { outcome: 'not_sent', reason: 'account_unconfirmed' }],
    ['the page is JSON, not the HTML state (account not confirmed)', json(200, { unexpected: true }), { outcome: 'not_sent', reason: 'account_unconfirmed' }],
  ])('R-C2: buys nothing when %s', async (_name, page, expected) => {
    readAnswers.unshift([PAGE_URL, page]);
    expect(await executeMarketBuy(order(), deps())).toMatchObject({ ...expected, sent: false });
    expect(sends).toEqual([]);
  });

  it.each([
    [
      'not enough balance (107)',
      json(400, { errors: [{ code: 107, error: 'NOT_ENOUGH_BALANCE', details: { amountToDeposit: 18.4 } }] }),
      { outcome: 'insufficient_balance', shortCents: 1_840, raw: { code: '107' } },
    ],
    ['the price changed (220)', json(400, { errors: [{ code: 220, details: { orders: [{ id: 555000111, oldPrice: 12.34, newPrice: 12.79 }] } }] }), { outcome: 'price_changed', newPriceCents: 1_279 }],
    ['not on sale (210)', json(400, { errors: [{ code: 210, details: { unavailableOrders: [555000111] } }] }), { outcome: 'sold', reason: 'code_210' }],
    ['seller cannot deliver (203)', json(400, { errors: [{ code: 203 }] }), { outcome: 'sold' }],
    ['Steam Guard is off (102)', json(400, { errors: [{ code: 102 }] }), { outcome: 'cannot_trade' }],
    ['signed out (6)', json(400, { errors: [{ code: 6 }] }), { outcome: 'signed_out' }],
    ['a captcha (4030)', json(400, { errors: [{ code: 4030 }] }), { outcome: 'captcha' }],
    ['a captcha as HTTP 200', json(200, { error: 4030 }), { outcome: 'captcha' }],
    ['429', json(429, {}, { 'retry-after': '30' }), { outcome: 'rate_limited', retryAt: NOW + 30_000 }],
    ['the cart limit (603)', json(400, { errors: [{ code: 603 }] }), { outcome: 'refused', reason: 'code_603' }],
  ])('R-C3: %s', async (_name, answer, expected) => {
    sendAnswers = [answer];
    const result = await executeMarketBuy(order(), deps());
    expect(sends).toHaveLength(1);
    expect(result).toMatchObject({ ...expected, sent: true });
  });

  it.each([
    ['a 5xx', json(500, {})],
    ['cs.money’s unknown error (9999)', json(400, { errors: [{ code: 9999 }] })],
    ['a 2xx that carries errors', json(200, { errors: [{ code: 212 }] })],
    ['a 2xx with an HTML page', json(200, '<html>ok</html>')],
    ['a 2xx with an empty body', { ok: true, status: 200, data: null, headers: {} } satisfies MarketBuyAnswer],
    ['a 403 without a code', json(403, '<html>')],
    ['no answer', { ok: false, status: 0, data: null, error: 'network' } satisfies MarketBuyAnswer],
  ])('R-C3: %s is unknown and never retried', async (_name, answer) => {
    sendAnswers = [answer];
    expect(await executeMarketBuy(order(), deps())).toMatchObject({ outcome: 'unknown', sent: true });
    expect(await executeMarketBuy(order(), deps())).toMatchObject({ outcome: 'busy', reason: 'unknown_hold' });
    expect(sends).toHaveLength(1);
  });
});

describe('cs.money bots (off by default)', () => {
  const bot = (overrides: Partial<MarketBuyRequest> = {}) =>
    request({ source: 'csmoney-bots', listingId: '30001', priceCents: 1_234, item: { name: 'AK-47 | Redline (Field-Tested)', float: 0.2512 }, ...overrides });
  const row = { id: 30001, price: 12.34, fullName: 'AK-47 | Redline (Field-Tested)', float: 0.2512, botId: 7 };

  it('is refused before any request while the switch is off', async () => {
    const result = await executeMarketBuy(bot(), deps());
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'source_disabled', sent: false });
    expect(reads).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('switched on: holds with balance = −price, confirms only a hold that moved exactly that', async () => {
    readAnswers.unshift([BOTS_URL, json(200, { items: [row], nextCursor: null })]);
    sendAnswers = [json(200, { requestId: 91, balance: -12.34, offers: [{ id: 4401, type: 'virtual', status: 0 }] }), json(200, { status: true })];
    const result = await executeMarketBuy(bot(), deps({ botsEnabled: true }));
    expect(sends.map((sent) => sent.request.url)).toEqual(['https://cs.money/2.0/send-offer', 'https://cs.money/confirm_virtual_offer']);
    expect(sentBody(0)).toEqual({ skins: { bot: [row], user: [] }, balance: -12.34, games: {}, isVirtual: true });
    expect(sentBody(1)).toEqual({ offer_id: '4401', action: 'confirm' });
    expect(result).toMatchObject({ outcome: 'bought', next: 'cs_money_inventory' });
  });

  it('switched on: a confirmation cs.money refuses ({status: false}) releases the hold at once', async () => {
    readAnswers.unshift([BOTS_URL, json(200, { items: [row] })]);
    sendAnswers = [json(200, { requestId: 91, balance: -12.34, offers: [{ id: 4401, type: 'virtual', status: 0 }] }), json(200, { status: false }), json(200, { status: true })];
    const result = await executeMarketBuy(bot(), deps({ botsEnabled: true }));
    expect(sends.map((sent) => sent.request.url)).toEqual([
      'https://cs.money/2.0/send-offer',
      'https://cs.money/confirm_virtual_offer',
      'https://cs.money/api/public/v1/trade/requests/virtual/4401/decline',
    ]);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'confirm_refused_declined', sent: true });
  });

  it('switched on: a hold at another amount is declined and never confirmed', async () => {
    readAnswers.unshift([BOTS_URL, json(200, { items: [row] })]);
    sendAnswers = [json(200, { requestId: 91, balance: -12.99, offers: [{ id: 4401, type: 'virtual', status: 0 }] }), json(200, { status: true })];
    const result = await executeMarketBuy(bot(), deps({ botsEnabled: true }));
    expect(sends.map((sent) => sent.request.url)).toEqual(['https://cs.money/2.0/send-offer', 'https://cs.money/api/public/v1/trade/requests/virtual/4401/decline']);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'hold_mismatch_declined' });
  });

  it.each([
    ['someone else trades it (15)', json(400, { errors: [{ error: 15 }] }), 'sold'],
    ['the bot changed prices (16)', json(400, { errors: [{ error: 16, details: { skins: [{ skinId: 30001, price: 12.99 }] } }] }), 'price_changed'],
    ['not enough trade balance (19)', json(400, { errors: [{ error: 19 }] }), 'insufficient_balance'],
    ['a temporary cap (37)', json(400, { code: 37, details: { is_valid_to_trade: false } }), 'cannot_trade'],
  ])('switched on: %s on the hold', async (_name, answer, outcome) => {
    readAnswers.unshift([BOTS_URL, json(200, { items: [row] })]);
    sendAnswers = [answer];
    expect(await executeMarketBuy(bot(), deps({ botsEnabled: true }))).toMatchObject({ outcome, sent: true });
    expect(sends).toHaveLength(1);
  });
});

describe('requests the executor refuses outright', () => {
  it.each([
    ['no attempt id', { attemptId: undefined }],
    ['a price that is not whole cents', { priceCents: 12.5 }],
    ['a zero price', { priceCents: 0 }],
    ['an unknown source', { source: 'steam' }],
    ['a cs.money id that is not digits', { source: 'csmoney-market', listingId: 'abc' }],
    ['a 2FA code for cs.money', { source: 'csmoney-market', listingId: '1', twoFactorCode: '123456' }],
    ['a malformed 2FA code', { twoFactorCode: '12345' }],
    ['a malformed Steam id', { steamId: '123' }],
    ['an unknown origin', { origin: { kind: 'robot' } }],
  ])('sends and reads nothing for %s', async (_name, patch) => {
    const result: MarketBuyResult = await executeMarketBuy({ ...request(), ...patch }, deps());
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'invalid_request', sent: false });
    expect(reads).toEqual([]);
    expect(sends).toEqual([]);
  });
});
