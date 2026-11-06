import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleSiteMessage } from '../handlers/site';
import { csfloatFeedLedger, foregroundActivity, resetFeedPriorityForTests } from '../market-feed/feed-priority';
import { marketFeed } from '../market-feed/service';
import { proxyRequest } from '../proxy';
import { csfloatHeaders } from './market-feed-fixtures';

vi.mock('../proxy', () => ({ proxyRequest: vi.fn(), getCookie: vi.fn() }));
const feed = {
  start: vi.fn(async () => ({ requestId: 's', state: null })),
  stop: vi.fn(async () => ({ requestId: 't', state: null })),
  retry: vi.fn(async () => ({ requestId: 'r', state: null })),
  read: vi.fn(async () => ({ requestId: 'g', state: null, rows: [], gone: [] })),
  readBuffer: vi.fn(async () => ({ requestId: 'b', now: 0, running: false, coveredSince: null, listings: [] })),
};
vi.mock('../market-feed/service', () => ({ marketFeed: () => feed }));

const NOW = Date.UTC(2026, 9, 25, 12);
const proxy = vi.mocked(proxyRequest);

beforeEach(() => {
  vi.clearAllMocks();
  resetFeedPriorityForTests(() => NOW);
});
afterEach(() => vi.restoreAllMocks());

describe('site handler ↔ Market live feed (QUICK-231)', () => {
  it('a page CSFloat /listings request holds the feed while it runs and feeds the shared window', async () => {
    let inFlightDuringCall = -1;
    proxy.mockImplementation(async () => {
      inFlightDuringCall = foregroundActivity('csfloat.com').inFlight;
      return { ok: true, status: 200, data: { data: [] }, headers: csfloatHeaders(150, NOW + 30 * 60_000, NOW) };
    });
    const answer = await handleSiteMessage({
      type: 'site:proxy_request',
      data: { requestId: 'q1', platform: 'csfloat.com', request: { url: 'https://csfloat.com/api/v1/listings?limit=50&paint_seed=661', method: 'GET' } },
    });
    expect(answer).toMatchObject({ ok: true, data: { requestId: 'q1', status: 200 } });
    expect(inFlightDuringCall).toBe(1);
    expect(foregroundActivity('csfloat.com')).toEqual({ inFlight: 0, lastAt: NOW, blockedUntil: null });
    expect(csfloatFeedLedger().budget).toEqual({ limit: 200, remaining: 150, resetAt: NOW + 30 * 60_000 });
    expect(csfloatFeedLedger().feedSpent).toBe(0);
  });

  it('a page request that throws still ends its hold; other platforms are not tracked', async () => {
    proxy.mockRejectedValueOnce(new Error('boom'));
    const answer = await handleSiteMessage({
      type: 'site:proxy_request',
      data: { requestId: 'q2', platform: 'cs.money', request: { url: 'https://cs.money/1.0/market/user-inventory', method: 'GET' } },
    });
    expect(answer).toEqual({ ok: false, error: 'boom' });
    expect(foregroundActivity('cs.money').inFlight).toBe(0);
    proxy.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
    await handleSiteMessage({ type: 'site:proxy_request', data: { requestId: 'q3', platform: 'white.market', request: { url: 'https://api.white.market/x', method: 'GET' } } });
    expect(foregroundActivity('csfloat.com').lastAt).toBeNull();
  });

  it('routes the feed commands to the background feed with the asking tab', async () => {
    const config = { sources: [] };
    await handleSiteMessage({ type: 'site:market_feed_start', data: { requestId: 's', config } }, { tabId: 4 });
    await handleSiteMessage({ type: 'site:get_market_feed', data: { requestId: 'g', sinceSeq: 3 } }, { tabId: 4 });
    await handleSiteMessage({ type: 'site:market_feed_retry', data: { requestId: 'r', platform: 'cs.money' } }, { tabId: 4 });
    await handleSiteMessage({ type: 'site:get_market_feed_buffer', data: { requestId: 'b', sinceMs: 1 } }, { tabId: 4 });
    const stopped = await handleSiteMessage({ type: 'site:market_feed_stop', data: { requestId: 't' } }, { tabId: 4 });
    expect(feed.start).toHaveBeenCalledWith({ requestId: 's', config }, 4);
    expect(feed.read).toHaveBeenCalledWith({ requestId: 'g', sinceSeq: 3 }, 4);
    expect(feed.retry).toHaveBeenCalledWith({ requestId: 'r', platform: 'cs.money' });
    expect(feed.readBuffer).toHaveBeenCalledWith({ requestId: 'b', sinceMs: 1 });
    expect(feed.stop).toHaveBeenCalledWith({ requestId: 't' }, 4);
    expect(stopped).toEqual({ ok: true, data: { requestId: 't', state: null } });
    expect(marketFeed()).toBe(feed);
  });
});
