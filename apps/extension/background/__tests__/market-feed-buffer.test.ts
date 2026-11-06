import { MARKET_FEED_BUFFER_MAX, MARKET_FEED_BUFFER_MS, MARKET_FEED_PAGE_MAX, MARKET_FEED_SEEN_GRACE_MS, parseMarketFeedRows } from '@qts/contracts';
import { describe, expect, it } from 'vitest';

import { MarketFeedBuffer, type MarketFeedBufferSnapshot } from '../market-feed/feed-buffer';
import { csfloatRow, csMoneyBotRow, csMoneyMarketRow } from './market-feed-fixtures';

const T0 = 1_800_000_000_000;
const SEC = 1_000;

function csfloatRows(rows: unknown[]) {
  const parsed = parseMarketFeedRows('csfloat', { ok: true, status: 200, data: { data: rows, cursor: 'c' } });
  if (!parsed) throw new Error('not a page');
  return parsed;
}

describe('compact feed rows (contracts parseMarketFeedRows)', () => {
  it('reads CSFloat rows: cents, created_at, float, seed, indices, stickers', () => {
    const [row] = csfloatRows([csfloatRow('111', T0 - 5 * SEC, { item: { market_hash_name: 'StatTrak™ AK-47 | Case Hardened (Field-Tested)' } })]);
    expect(row?.fields).toEqual({
      key: 'csfloat:111',
      source: 'csfloat',
      listingId: '111',
      marketHashName: 'StatTrak™ AK-47 | Case Hardened (Field-Tested)',
      priceCents: 118_500,
      float: 0.218734,
      paintSeed: 661,
      paintIndex: 44,
      defIndex: 7,
      isStatTrak: true,
      isSouvenir: false,
      stickers: [{ name: 'Sticker | iBUYPOWER | Katowice 2014', slot: 0, wear: 0.1, priceCents: 250_000 }],
      image: 'icon',
      listedAt: T0 - 5 * SEC,
    });
  });

  it('reads cs.money market and bot rows in USD cents; "nothing matches" is an empty page; a captcha is no page', () => {
    const market = parseMarketFeedRows('csmoney-market', { ok: true, status: 200, data: { items: [csMoneyMarketRow(1, 12.34)] } });
    expect(market?.[0]?.fields).toMatchObject({
      key: 'csmoney-market:1',
      priceCents: 1234,
      marketHashName: 'AWP | Asiimov (Field-Tested)',
      paintSeed: 12,
      stickers: [{ name: 'Sticker | Natus Vincere | Katowice 2015', slot: 1, wear: 20, priceCents: 150 }],
      listedAt: null,
    });
    const bots = parseMarketFeedRows('csmoney-bots', { ok: true, status: 200, data: { items: [csMoneyBotRow(2, 5.5)], nextCursor: 'n' } });
    expect(bots?.[0]?.fields).toMatchObject({ key: 'csmoney-bots:2', priceCents: 550, float: 0.15, paintSeed: 18, isStatTrak: true });
    expect(parseMarketFeedRows('csmoney-bots', { ok: true, status: 200, data: { error: 2 } })).toEqual([]);
    expect(parseMarketFeedRows('csmoney-bots', { ok: true, status: 200, data: { error: 4030 } })).toBeNull();
    expect(parseMarketFeedRows('csfloat', { ok: false, status: 429, data: null })).toBeNull();
  });
});

describe('MarketFeedBuffer (QUICK-231)', () => {
  it('keeps a listing once across polls: only the new ones are added, the rest refresh their last-seen time', () => {
    const buffer = new MarketFeedBuffer();
    const first = buffer.ingest('csfloat', csfloatRows([csfloatRow('2', T0 - 2 * SEC), csfloatRow('1', T0 - 9 * SEC)]), T0, { baseline: true, continuous: false });
    expect(first.added.map((row) => row.listing.key)).toEqual(['csfloat:2', 'csfloat:1']);
    expect(first.added.every((row) => row.listing.baseline && row.listing.latencyMs === null)).toBe(true);
    const second = buffer.ingest('csfloat', csfloatRows([csfloatRow('3', T0 + 10 * SEC), csfloatRow('2', T0 - 2 * SEC, { price: 99_000 }), csfloatRow('1', T0 - 9 * SEC)]), T0 + 21 * SEC, {
      baseline: false,
      continuous: true,
      serverAt: T0 + 20 * SEC,
    });
    expect(second.added.map((row) => [row.listing.key, row.listing.seq, row.listing.baseline, row.listing.latencyMs])).toEqual([['csfloat:3', 3, false, 10 * SEC]]);
    expect(second.overlapped).toBe(true);
    expect(buffer.size).toBe(3);
    const two = buffer.read({ sinceMs: T0 }).find((entry) => entry.key === 'csfloat:2');
    expect(two).toMatchObject({ firstSeenAt: T0, lastSeenAt: T0 + 21 * SEC, priceCents: 99_000 });
    // The same listing twice in one answer counts once.
    const third = buffer.ingest('csfloat', csfloatRows([csfloatRow('4', T0 + 30 * SEC), csfloatRow('4', T0 + 30 * SEC)]), T0 + 42 * SEC, { baseline: false, continuous: false });
    expect(third.added).toHaveLength(1);
    expect(third.added[0]?.listing.latencyMs).toBeNull();
    expect(third.overlapped).toBe(false);
  });

  it('marks a CSFloat listing gone when a later page spans its time but lacks it', () => {
    const buffer = new MarketFeedBuffer();
    buffer.ingest('csfloat', csfloatRows([csfloatRow('3', T0 - 1 * SEC), csfloatRow('2', T0 - 5 * SEC), csfloatRow('1', T0 - 30 * SEC)]), T0, { baseline: true, continuous: false });
    const next = buffer.ingest('csfloat', csfloatRows([csfloatRow('4', T0 + 15 * SEC), csfloatRow('3', T0 - 1 * SEC), csfloatRow('1', T0 - 30 * SEC)]), T0 + 20 * SEC, {
      baseline: false,
      continuous: true,
    });
    expect(next.gone).toEqual(['csfloat:2']);
    // Older than the page's span: not judged (it scrolled off, it was not sold).
    const later = buffer.ingest('csfloat', csfloatRows([csfloatRow('5', T0 + 30 * SEC), csfloatRow('4', T0 + 15 * SEC)]), T0 + 40 * SEC, { baseline: false, continuous: true });
    expect(later.gone).toEqual([]);
    expect(buffer.recentGone(T0 + 40 * SEC)).toEqual(['csfloat:2']);
  });

  it('expires a listing an hour after it was first seen unless the answers still carry it', () => {
    const buffer = new MarketFeedBuffer();
    buffer.ingest('csfloat', csfloatRows([csfloatRow('old', T0)]), T0, { baseline: true, continuous: false });
    const bots = parseMarketFeedRows('csmoney-bots', { ok: true, status: 200, data: { items: [csMoneyBotRow(1, 2)] } }) ?? [];
    buffer.ingest('csmoney-bots', bots, T0, { baseline: true, continuous: false });
    // The bot row is still in the newest answer 59 minutes later; the CSFloat one is not.
    buffer.ingest('csmoney-bots', bots, T0 + 59 * 60 * SEC, { baseline: false, continuous: true });
    buffer.prune(T0 + MARKET_FEED_BUFFER_MS + SEC);
    expect(buffer.read().map((entry) => entry.key)).toEqual(['csmoney-bots:1']);
    buffer.prune(T0 + 59 * 60 * SEC + MARKET_FEED_SEEN_GRACE_MS + SEC);
    expect(buffer.size).toBe(0);
    expect(buffer.coveredSince()).toBeNull();
  });

  it('holds at most the cap (oldest first seen leave) and rows for the newest page cards only', () => {
    const buffer = new MarketFeedBuffer();
    const many = Array.from({ length: MARKET_FEED_BUFFER_MAX + 50 }, (_, index) => csfloatRow(String(index), T0 + index));
    buffer.ingest('csfloat', csfloatRows(many), T0, { baseline: true, continuous: false });
    expect(buffer.size).toBe(MARKET_FEED_BUFFER_MAX);
    const rows = buffer.rowsSince(0);
    expect(rows).toHaveLength(MARKET_FEED_PAGE_MAX);
    expect(rows.at(-1)?.listing.seq).toBe(MARKET_FEED_BUFFER_MAX + 50);
    expect(buffer.rowsSince(MARKET_FEED_BUFFER_MAX + 49).map((row) => row.listing.key)).toEqual([`csfloat:${MARKET_FEED_BUFFER_MAX + 49}`]);
  });

  it('reads the compact buffer by first-seen time and source, oldest first; survives a snapshot', () => {
    const buffer = new MarketFeedBuffer();
    buffer.ingest('csfloat', csfloatRows([csfloatRow('a', T0)]), T0, { baseline: true, continuous: false });
    buffer.ingest('csmoney-market', parseMarketFeedRows('csmoney-market', { ok: true, status: 200, data: { items: [csMoneyMarketRow(1, 3)] } }) ?? [], T0 + 5 * SEC, {
      baseline: true,
      continuous: false,
    });
    expect(buffer.read({ sinceMs: T0 + SEC }).map((entry) => entry.key)).toEqual(['csmoney-market:1']);
    expect(buffer.read({ sources: new Set(['csfloat'] as const) }).map((entry) => entry.key)).toEqual(['csfloat:a']);
    const copy = new MarketFeedBuffer(JSON.parse(JSON.stringify(buffer.snapshot())) as MarketFeedBufferSnapshot);
    expect(copy.read()).toEqual(buffer.read());
    expect(copy.seq).toBe(2);
    expect(copy.coveredSince()).toBe(T0);
  });

  it('reports latency over recent continuous listings only', () => {
    const buffer = new MarketFeedBuffer();
    buffer.ingest('csfloat', csfloatRows([csfloatRow('base', T0 - 30 * SEC)]), T0, { baseline: true, continuous: false });
    expect(buffer.latency('csfloat', T0)).toBeNull();
    const rows = [4, 8, 12, 20].map((lag, index) => csfloatRow(`n${index}`, T0 + 60 * SEC - lag * SEC));
    buffer.ingest('csfloat', csfloatRows(rows), T0 + 60 * SEC, { baseline: false, continuous: true });
    expect(buffer.latency('csfloat', T0 + 60 * SEC)).toEqual({ samples: 4, p50Ms: 8 * SEC, p90Ms: 20 * SEC });
    expect(buffer.latency('csmoney-bots', T0 + 60 * SEC)).toBeNull();
  });
});
