// apps/extension/background/market-feed/feed-buffer.ts
//
// QUICK-231 (R-A6, R-E4, R-E6, R-F6): every listing the feed read, once. A listing seen again only refreshes when it was
// last seen (and its price), so the page and the buy-order rules hear of it once. The buffer keeps the compact entries an
// hour after they were first seen (longer while the answers still carry them, so none is ever "new" twice), at most
// MARKET_FEED_BUFFER_MAX; the marketplace's rows of the newest MARKET_FEED_PAGE_MAX are kept for the page's cards only.
import type { MarketFeedLatencyView, MarketFeedListing, MarketFeedRow, MarketFeedRowFields, MarketSource } from '@qts/contracts';
import { MARKET_FEED_BUFFER_MAX, MARKET_FEED_BUFFER_MS, MARKET_FEED_PAGE_MAX, MARKET_FEED_SEEN_GRACE_MS, marketFeedPercentile } from '@qts/contracts';

/** Latency (R-E6) is reported over this many recent samples per source, from the last half hour. */
const LATENCY_SAMPLES = 300;
const LATENCY_WINDOW_MS = 30 * 60_000;
/** A gone listing is told to a page that reads (not one that was pushed) for this long. */
const GONE_RECENT_MS = 5 * 60_000;
/** Only listings seen this recently are judged gone (a CSFloat answer covers ~40 s). */
const GONE_LOOKBACK_MS = 10 * 60_000;

export interface IngestOptions {
  /** The run's first answer of this source: its listings were on the market before the feed looked. */
  baseline: boolean;
  /** The source read without a pause just before: first-seen times measure latency. */
  continuous: boolean;
  /** The marketplace's clock at the answer (its `date` header), for latency; the extension's clock without. */
  serverAt?: number;
}

export interface IngestResult {
  added: MarketFeedRow[];
  gone: string[];
  /** The answer carried at least one listing the buffer already had: nothing was missed in between. */
  overlapped: boolean;
}

export interface MarketFeedBufferSnapshot {
  seq: number;
  entries: MarketFeedListing[];
}

export class MarketFeedBuffer {
  private readonly entries = new Map<string, MarketFeedListing>();
  private readonly raws = new Map<string, unknown>();
  private seqCounter = 0;

  constructor(saved?: MarketFeedBufferSnapshot | null) {
    if (!saved || !Array.isArray(saved.entries)) return;
    for (const entry of [...saved.entries].sort((a, b) => a.seq - b.seq)) if (entry && typeof entry.key === 'string') this.entries.set(entry.key, entry);
    this.seqCounter = Math.max(Number.isSafeInteger(saved.seq) ? saved.seq : 0, ...[...this.entries.values()].map((entry) => entry.seq));
  }

  get seq(): number {
    return this.seqCounter;
  }

  get size(): number {
    return this.entries.size;
  }

  /** One answer of `source`, read at `at`: the listings it brings for the first time, and those found gone. */
  ingest(source: MarketSource, rows: ReadonlyArray<{ fields: MarketFeedRowFields; raw: unknown }>, at: number, options: IngestOptions): IngestResult {
    const added: MarketFeedRow[] = [];
    const present = new Set<string>();
    let overlapped = false;
    const serverAt = options.serverAt ?? at;
    for (const { fields, raw } of rows) {
      if (present.has(fields.key)) continue;
      present.add(fields.key);
      const known = this.entries.get(fields.key);
      if (known) {
        overlapped = true;
        this.entries.set(fields.key, { ...known, lastSeenAt: at, priceCents: fields.priceCents, goneAt: null });
        continue;
      }
      this.seqCounter += 1;
      const listing: MarketFeedListing = {
        ...fields,
        firstSeenAt: at,
        lastSeenAt: at,
        latencyMs: options.continuous && !options.baseline && fields.listedAt !== null ? Math.max(0, serverAt - fields.listedAt) : null,
        baseline: options.baseline,
        goneAt: null,
        seq: this.seqCounter,
      };
      this.entries.set(listing.key, listing);
      this.raws.set(listing.key, raw);
      added.push({ listing, raw });
    }
    const gone = source === 'csfloat' ? this.markCsfloatGone(rows, present, at) : [];
    this.prune(at);
    return { added, gone, overlapped };
  }

  /**
   * CSFloat's newest page holds every buy-now listing created inside its time span: one the buffer saw in that span and
   * the page lacks was sold or delisted. cs.money's answers carry no time, so its listings are never judged.
   */
  private markCsfloatGone(rows: ReadonlyArray<{ fields: MarketFeedRowFields }>, present: ReadonlySet<string>, at: number): string[] {
    const times = rows.flatMap(({ fields }) => (fields.listedAt === null ? [] : [fields.listedAt]));
    if (!times.length) return [];
    const low = Math.min(...times);
    const high = Math.max(...times);
    const gone: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.source !== 'csfloat' || entry.goneAt !== null || present.has(entry.key) || entry.listedAt === null) continue;
      if (at - entry.lastSeenAt > GONE_LOOKBACK_MS || entry.listedAt < low || entry.listedAt > high) continue;
      this.entries.set(entry.key, { ...entry, goneAt: at });
      gone.push(entry.key);
    }
    return gone;
  }

  /** Drops what is older than the buffer keeps, then the oldest first seen above the cap; rows only for the newest. */
  prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.firstSeenAt > MARKET_FEED_BUFFER_MS && now - entry.lastSeenAt > MARKET_FEED_SEEN_GRACE_MS) {
        this.entries.delete(key);
        this.raws.delete(key);
      }
    }
    if (this.entries.size > MARKET_FEED_BUFFER_MAX) {
      const oldest = [...this.entries.values()].sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.seq - b.seq);
      for (const entry of oldest.slice(0, this.entries.size - MARKET_FEED_BUFFER_MAX)) {
        this.entries.delete(entry.key);
        this.raws.delete(entry.key);
      }
    }
    // Rows were added in seq order: the first ones are the oldest.
    for (const key of this.raws.keys()) {
      if (this.raws.size <= MARKET_FEED_PAGE_MAX) break;
      this.raws.delete(key);
    }
  }

  /** New listings after `sinceSeq` that still have their row, oldest first (for a page catching up). */
  rowsSince(sinceSeq: number): MarketFeedRow[] {
    const rows: MarketFeedRow[] = [];
    for (const [key, raw] of this.raws) {
      const listing = this.entries.get(key);
      if (listing && listing.seq > sinceSeq) rows.push({ listing, raw });
    }
    return rows.sort((a, b) => a.listing.seq - b.listing.seq);
  }

  /** Listings found gone in the last minutes. */
  recentGone(now: number): string[] {
    return [...this.entries.values()].filter((entry) => entry.goneAt !== null && now - entry.goneAt <= GONE_RECENT_MS).map((entry) => entry.key);
  }

  /** The compact listings first seen at or after `sinceMs` (all when omitted), of `sources` (all when omitted), oldest first. */
  read({ sinceMs, sources }: { sinceMs?: number; sources?: ReadonlySet<MarketSource> } = {}): MarketFeedListing[] {
    return [...this.entries.values()]
      .filter((entry) => (sinceMs === undefined || entry.firstSeenAt >= sinceMs) && (!sources || sources.has(entry.source)))
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.seq - b.seq);
  }

  coveredSince(): number | null {
    let oldest: number | null = null;
    for (const entry of this.entries.values()) if (oldest === null || entry.firstSeenAt < oldest) oldest = entry.firstSeenAt;
    return oldest;
  }

  /** Listing creation → first seen (R-E6) over the source's recent new listings; null without samples. */
  latency(source: MarketSource, now: number): MarketFeedLatencyView | null {
    const samples = [...this.entries.values()]
      .filter((entry) => entry.source === source && entry.latencyMs !== null && now - entry.firstSeenAt <= LATENCY_WINDOW_MS)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, LATENCY_SAMPLES)
      .map((entry) => entry.latencyMs ?? 0);
    const p50 = marketFeedPercentile(samples, 0.5);
    const p90 = marketFeedPercentile(samples, 0.9);
    return p50 === null || p90 === null ? null : { samples: samples.length, p50Ms: p50, p90Ms: p90 };
  }

  snapshot(): MarketFeedBufferSnapshot {
    return { seq: this.seqCounter, entries: [...this.entries.values()] };
  }
}
