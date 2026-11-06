// QUICK-226: the pure money-path pieces of @qts/contracts the executor relies on: the one cents → USD conversion, the
// exact request bodies, the journal digest (no personal data) and the 429 reset.
import {
  buyAnswerDigest,
  centsToUsd,
  csfloatBuyRequest,
  csMoneyBotHoldRequest,
  csMoneyPurchaseRequest,
  MARKET_BUY_DIGEST_MAX_LENGTH,
  marketBuyRetryAt,
  parseMarketBuyResult,
  usdToWholeCents,
} from '@qts/contracts';
import { describe, expect, it } from 'vitest';

/** `1234` → `"12.34"`, `1230` → `"12.3"`, `1200` → `"12"`: how cs.money's JSON writes a whole-cent USD price. */
function decimal(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

describe('cents ↔ USD (R-N1)', () => {
  it('every whole-cent price from $0.01 to $10,000.00 goes out as its own decimal and reads back to the same cents', () => {
    for (let cents = 1; cents <= 1_000_000; cents++) {
      const usd = centsToUsd(cents);
      const text = JSON.stringify(usd);
      if (text !== decimal(cents)) throw new Error(`${cents} cents → ${text}`);
      if (usdToWholeCents(JSON.parse(text)) !== cents) throw new Error(`${text} → not ${cents}`);
    }
  });

  it('a price that is not a whole number of cents is not taken for one', () => {
    expect(usdToWholeCents(12.345)).toBeNull();
    expect(usdToWholeCents(0)).toBeNull();
    expect(usdToWholeCents(-1)).toBeNull();
    expect(usdToWholeCents('12.34')).toBeNull();
    expect(usdToWholeCents(12.34)).toBe(1_234);
  });

  it('the bodies carry the confirmed price and nothing else that could change it', () => {
    expect(JSON.parse(csfloatBuyRequest('1', 26_800).body ?? '')).toEqual({ total_price: 26_800, contract_ids: ['1'] });
    expect(csMoneyPurchaseRequest('555', 1_999).body).toBe('{"items":[{"id":"555","price":19.99}]}');
    expect(JSON.parse(csMoneyBotHoldRequest({ id: 7, price: 19.99 }, 1_999).body ?? '')).toEqual({
      skins: { bot: [{ id: 7, price: 19.99 }], user: [] },
      balance: -19.99,
      games: {},
      isVirtual: true,
    });
  });
});

describe('buyAnswerDigest (R-C5: no cookies, no personal data)', () => {
  it('keeps the shape and the codes, masks ids and drops identity', () => {
    const digest = buyAnswerDigest({
      message: 'Purchased by 76561198000000001, mail a@b.co, see https://csfloat.com/x',
      code: 4,
      trade: { id: 'T1', buyer: { steam_id: '76561198000000001' }, trade_url: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=SECRET' },
      errors: [{ code: 220, details: { orders: [{ id: 5, oldPrice: 1.5, newPrice: 1.7 }], amountToDeposit: 3 } }],
      session_token: 'SECRET',
      user: { name: 'Albert', balance: 100 },
    });
    expect(digest).toBeDefined();
    const parsed = JSON.parse(digest ?? '{}') as Record<string, unknown>;
    expect(parsed.keys).toEqual(['message', 'code', 'trade', 'errors', 'session_token', 'user']);
    expect(parsed.code).toBe(4);
    expect(parsed.message).toBe('Purchased by <steamid>, mail <email>, see <url>');
    expect(parsed.errors).toEqual([{ code: 220, details: { orders: [{ id: 5, oldPrice: 1.5, newPrice: 1.7 }], amountToDeposit: 3 } }]);
    for (const secret of ['SECRET', '76561198000000001', 'Albert', 'a@b.co', 'tradeoffer']) expect(digest).not.toContain(secret);
  });

  it('masks trade links and their tokens in every kept string, with or without a scheme', () => {
    const digest = buyAnswerDigest({
      message: 'Send to tradeoffer/new/?partner=40265463&token=AbC123 now',
      error: 'see https://steamcommunity.com/tradeoffer/new/?partner=1&token=AbC123 or steamcommunity.com/tradeoffer/new/?partner=2&token=AbC123',
      errors: [{ code: 9, error: 'link token=AbC123&partner=7' }],
    });
    expect(digest).not.toContain('AbC123');
    expect(digest).not.toContain('40265463');
    expect(digest).not.toMatch(/tradeoffer\/new/);
    expect(digest).toContain('<tradeoffer>');
  });

  it('an HTML or text body is only its length; the digest stays within the journal’s cap', () => {
    expect(buyAnswerDigest('<html>Attention Required! | Cloudflare</html>')).toBe('{"text":true,"length":45}');
    expect(buyAnswerDigest(null)).toBeUndefined();
    const huge = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key_${i}_${'x'.repeat(30)}`, i]));
    expect((buyAnswerDigest(huge) ?? '').length).toBeLessThanOrEqual(MARKET_BUY_DIGEST_MAX_LENGTH);
  });
});

describe('marketBuyRetryAt', () => {
  const NOW = 1_800_000_000_000;
  it('reads CSFloat’s reset against its own clock, or retry-after, the later one', () => {
    const reset = String(NOW / 1000 + 120);
    // CSFloat's clock runs 10 s ahead of ours: its reset is 110 s from our now.
    expect(marketBuyRetryAt({ 'x-ratelimit-reset': reset, date: new Date(NOW + 10_000).toUTCString() }, NOW)).toBe(NOW + 110_000);
    expect(marketBuyRetryAt({ 'retry-after': '30' }, NOW)).toBe(NOW + 30_000);
    expect(marketBuyRetryAt({ 'retry-after': '30', 'x-ratelimit-reset': String(NOW / 1000 + 60) }, NOW)).toBe(NOW + 60_000);
    expect(marketBuyRetryAt({ 'x-ratelimit-reset': '15' }, NOW)).toBeUndefined();
    expect(marketBuyRetryAt(undefined, NOW)).toBeUndefined();
  });
});

describe('parseMarketBuyResult', () => {
  const RESULT = {
    requestId: 'r1',
    attemptId: '00000000-0000-4000-8000-000000000001',
    source: 'csfloat',
    listingId: '1',
    priceCents: 100,
    outcome: 'bought',
    sent: true,
    settledAt: 5,
  };
  it('reads a result and refuses anything outside its shape', () => {
    expect(parseMarketBuyResult(RESULT)).toEqual(RESULT);
    expect(parseMarketBuyResult({ ...RESULT, outcome: 'maybe' })).toBeNull();
    expect(parseMarketBuyResult({ ...RESULT, reason: 'Free text!' })).toBeNull();
    expect(parseMarketBuyResult({ ...RESULT, newPriceCents: 1.5 })).toBeNull();
    expect(parseMarketBuyResult({ ...RESULT, settledAt: undefined })).toBeNull();
    expect(parseMarketBuyResult({ ...RESULT, cookie: 'x' })).toEqual(RESULT);
  });
});
