// QUICK-226 × QUICK-231: a buy goes ahead of the Market live feed. Through the executor's real dependencies (the page
// proxy for the re-reads, the buy sender, the shared feed priority) with only fetch and the browser faked: the CSFloat
// window is reserved while the attempt runs, every request of it marks the platform busy, and a 429 the buy meets
// holds the feed back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const fetchMock = vi.fn();
let session: Record<string, unknown>;

function json(status: number, data: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  session = {};
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('browser', {
    permissions: { contains: vi.fn(async () => true) },
    cookies: { get: vi.fn(async () => null) },
    storage: {
      local: { get: vi.fn(async () => ({})) },
      session: {
        get: vi.fn(async (key: string) => (key in session ? { [key]: session[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(session, structuredClone(items))),
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REQUEST = {
  requestId: 'r1',
  attemptId: '00000000-0000-4000-8000-000000000001',
  source: 'csfloat',
  listingId: '813296748293324890',
  priceCents: 26_800,
  origin: { kind: 'manual' },
};

describe('a buy and the live feed', () => {
  it('reserves CSFloat requests for the attempt and marks each of its requests as the page’s', async () => {
    const priority = await import('../market-feed/feed-priority');
    priority.resetFeedPriorityForTests(() => NOW);
    const { executeMarketBuy } = await import('../market-buy/executor');
    const reservedDuring: number[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      reservedDuring.push(priority.reservedCsfloatRequests(NOW));
      expect(priority.foregroundActivity('csfloat.com').inFlight).toBeGreaterThan(0);
      if (url.endsWith('/api/v1/me')) return json(200, { user: { steam_id: '76561198000000001', balance: 100_000 } });
      if (url.endsWith('/api/v1/listings/buy')) return json(200, {});
      return json(200, { id: REQUEST.listingId, state: 'listed', type: 'buy_now', price: 26_800 });
    });

    const result = await executeMarketBuy(REQUEST);

    expect(result).toMatchObject({ outcome: 'bought', sent: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://csfloat.com/api/v1/me', 'https://csfloat.com/api/v1/listings/813296748293324890', 'https://csfloat.com/api/v1/listings/buy']);
    expect(reservedDuring).toEqual([3, 3, 3]);
    expect(priority.reservedCsfloatRequests(NOW)).toBe(0);
    expect(priority.foregroundActivity('csfloat.com')).toMatchObject({ inFlight: 0, lastAt: NOW });
  });

  it('a request that never answers stops holding the feed when the executor stops waiting for it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const priority = await import('../market-feed/feed-priority');
      priority.resetFeedPriorityForTests(() => NOW);
      const { executeMarketBuy } = await import('../market-buy/executor');
      fetchMock.mockImplementation(() => new Promise(() => undefined));
      const pending = executeMarketBuy({ ...REQUEST, steamId: '76561198000000001' });
      await vi.advanceTimersByTimeAsync(1);
      expect(priority.foregroundActivity('csfloat.com').inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ outcome: 'not_sent', reason: 'account_unconfirmed' });
      expect(priority.foregroundActivity('csfloat.com').inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the listing read’s mark ends at the listing read’s own timeout (5 s), not the account read’s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const priority = await import('../market-feed/feed-priority');
      priority.resetFeedPriorityForTests(() => NOW);
      const { executeMarketBuy } = await import('../market-buy/executor');
      fetchMock.mockImplementation(async (url: string) => (url.endsWith('/api/v1/me') ? json(200, { user: { steam_id: '76561198000000001', balance: 100_000 } }) : new Promise(() => undefined)));
      const pending = executeMarketBuy({ ...REQUEST, steamId: '76561198000000001' });
      await vi.advanceTimersByTimeAsync(1);
      expect(priority.foregroundActivity('csfloat.com').inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toMatchObject({ outcome: 'not_sent', reason: 'reread_timeout' });
      expect(priority.foregroundActivity('csfloat.com').inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 429 on the buy holds the feed back at least a minute', async () => {
    const priority = await import('../market-feed/feed-priority');
    priority.resetFeedPriorityForTests(() => NOW);
    const { executeMarketBuy } = await import('../market-buy/executor');
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/me')) return json(200, { user: { steam_id: '76561198000000001', balance: 100_000 } });
      if (url.endsWith('/api/v1/listings/buy')) return json(429, { code: 429 });
      return json(200, { id: REQUEST.listingId, state: 'listed', type: 'buy_now', price: 26_800 });
    });

    expect(await executeMarketBuy(REQUEST)).toMatchObject({ outcome: 'rate_limited', sent: true });
    expect(priority.foregroundActivity('csfloat.com').blockedUntil).toBeGreaterThanOrEqual(NOW + priority.FOREGROUND_BLOCK_MS);
  });
});
