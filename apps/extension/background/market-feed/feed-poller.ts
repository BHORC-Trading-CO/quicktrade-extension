
import type {
  MarketFeedBufferRequest,
  MarketFeedBufferResponse,
  MarketFeedIssue,
  MarketFeedPlatform,
  MarketFeedPlatformState,
  MarketFeedRequest,
  MarketFeedRow,
  MarketFeedSourceState,
  MarketFeedState,
  MarketFeedStateResponse,
  MarketFeedUpdate,
  MarketSource,
  OperationMatch,
  OperationPurpose,
  OperationRequest,
} from '@qts/contracts';
import {
  clampCsfloatFeedShare,
  csfloatFeedAllowance,
  decideCsfloatFeed,
  detectMarketFeedIssue,
  FEED_FOREGROUND_YIELD_MS,
  isMarketFeedCoverageAtRisk,
  MARKET_FEED_LEASE_MS,
  MARKET_FEED_OPERATION_IDS,
  MARKET_FEED_PLATFORMS,
  MARKET_FEED_SOURCE_PLATFORM,
  MARKET_SOURCES,
  marketFeedRetryAt,
  parseMarketFeedRows,
} from '@qts/contracts';

import type { ProxyOptions, ProxyResult } from '../proxy';
import { MarketFeedBuffer, type MarketFeedBufferSnapshot } from './feed-buffer';
import { csfloatFeedLedger, foregroundActivity, onForegroundSettled, recordFeedCsfloatAnswer, reservedCsfloatRequests, restoreCsfloatFeedLedger } from './feed-priority';

/** Each cs.money source is read this often; the two sources 5 s apart. */
export const CSMONEY_FEED_INTERVAL_MS = 10_000;
/** Between any two cs.money feed requests. */
export const CSMONEY_FEED_GAP_MS = 5_000;
/** The longest the loop sleeps: each tick makes an extension call, which keeps the MV3 worker alive (Chrome 110+). */
export const FEED_KEEPALIVE_MS = 20_000;
/** The state (with the buffer, a few MB at most) is written to storage.session at most this often. */
export const FEED_PERSIST_MS = 15_000;
/** A source read again within this (or two of its intervals) counts as read without a pause. */
const CONTINUITY_MS = 90_000;
const MAX_URL_LENGTH = 2048;
const STATE_VERSION = 1;

interface PlatformRuntime {
  attempts: number;
  issue?: MarketFeedIssue;
  retryAt?: number;
  inFlight: boolean;
  lastRequestAt: number | null;
  lastPollAt: number | null;
  intervalMs: number | null;
  nextAt: number | null;
  heldBy?: 'budget' | 'foreground';
}

interface SourceRuntime extends MarketFeedSourceState {
  nextAt: number;
  /** A pause came between this source's last answer and the next: its new listings measure no latency. */
  afterPause: boolean;
}

interface FeedConfigRuntime {
  sources: Partial<Record<MarketSource, MarketFeedRequest>>;
  csfloatShare: number;
}

interface PersistedFeed {
  v: number;
  config: FeedConfigRuntime | null;
  leases: Record<string, number>;
  /** QUICK-233: the sources each holder asked for (absent in a state saved before). */
  holders?: Record<string, MarketSource[]>;
  startedAt: number | null;
  platforms: Partial<Record<MarketFeedPlatform, Pick<PlatformRuntime, 'attempts' | 'issue' | 'retryAt' | 'lastRequestAt' | 'lastPollAt'>>>;
  sources: Partial<Record<MarketSource, SourceRuntime>>;
  ledger: ReturnType<typeof csfloatFeedLedger>;
  buffer: MarketFeedBufferSnapshot;
}

export interface MarketFeedDeps {
  proxy: (url: string, options: ProxyOptions) => Promise<ProxyResult>;
  resolve: (platform: string, request: OperationRequest, purpose: OperationPurpose) => Promise<OperationMatch>;
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  load: () => Promise<unknown>;
  save: (snapshot: PersistedFeed) => Promise<void>;
  /** Sends a push to one tab's content script; false when the tab has none. */
  push: (tabId: number, update: MarketFeedUpdate) => Promise<boolean>;
  /** Turns the 30 s watchdog alarm on or off; `keepAlive` checks it each tick (an extension call). */
  watchdog: (on: boolean) => Promise<void>;
  keepAlive: () => Promise<void>;
  /** QUICK-233: every poll's new listings (never a baseline row twice), for the buy-order engine. */
  onListings?: (rows: MarketFeedRow[], at: number) => void;
}

/** The buy-order engine's lease on the feed (QUICK-233): a holder that is no tab. */
export const BUY_ORDER_ENGINE_FEED_HOLDER = -2;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const idlePlatform = (): PlatformRuntime => ({ attempts: 0, inFlight: false, lastRequestAt: null, lastPollAt: null, intervalMs: null, nextAt: null });

function idleSource(nextAt: number): SourceRuntime {
  return { polls: 0, lastPollAt: null, lastOkAt: null, newListings: 0, gaps: 0, nextAt, afterPause: false };
}

function isMarketSource(value: unknown): value is MarketSource {
  return typeof value === 'string' && (MARKET_SOURCES as readonly string[]).includes(value);
}

/** The page's config, its shape checked; null when it is not one. */
function readConfig(value: unknown): { sources: Array<{ source: MarketSource; request: MarketFeedRequest }>; share: number } | null {
  if (!isRecord(value) || !Array.isArray(value['sources']) || value['sources'].length > MARKET_SOURCES.length) return null;
  const seen = new Set<MarketSource>();
  const sources: Array<{ source: MarketSource; request: MarketFeedRequest }> = [];
  for (const entry of value['sources']) {
    if (!isRecord(entry) || !isMarketSource(entry['source']) || seen.has(entry['source'])) return null;
    const request = entry['request'];
    if (!isRecord(request) || request['method'] !== 'GET' || typeof request['url'] !== 'string' || request['url'].length > MAX_URL_LENGTH) return null;
    seen.add(entry['source']);
    sources.push({ source: entry['source'], request: { url: request['url'], method: 'GET' } });
  }
  return { sources, share: clampCsfloatFeedShare(value['csfloatShare']) };
}

function serverTime(headers: Record<string, string> | undefined): number | undefined {
  const parsed = Date.parse(headers?.['date'] ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createMarketFeed(deps: MarketFeedDeps) {
  let config: FeedConfigRuntime | null = null;
  const leases = new Map<number, number>();
  /** QUICK-233: what each holder asked to read. */
  const holders = new Map<number, MarketSource[]>();
  let startedAt: number | null = null;
  const platforms: Record<MarketFeedPlatform, PlatformRuntime> = { 'csfloat.com': idlePlatform(), 'cs.money': idlePlatform() };
  let sources: Partial<Record<MarketSource, SourceRuntime>> = {};
  let buffer = new MarketFeedBuffer();
  let timer: unknown = null;
  let persistTimer: unknown = null;
  let running = false;
  let restored: Promise<void> | null = null;

  // ─── Persistence ────────────────────────────────────────────────────────────

  function snapshot(): PersistedFeed {
    const savedPlatforms: PersistedFeed['platforms'] = {};
    for (const platform of MARKET_FEED_PLATFORMS) {
      const { attempts, issue, retryAt, lastRequestAt, lastPollAt } = platforms[platform];
      savedPlatforms[platform] = { attempts, ...(issue ? { issue } : {}), ...(retryAt !== undefined ? { retryAt } : {}), lastRequestAt, lastPollAt };
    }
    return {
      v: STATE_VERSION,
      config,
      leases: Object.fromEntries([...leases].map(([tabId, until]) => [String(tabId), until])),
      holders: Object.fromEntries([...holders].map(([tabId, wanted]) => [String(tabId), [...wanted]])),
      startedAt,
      platforms: savedPlatforms,
      sources,
      ledger: csfloatFeedLedger(),
      buffer: buffer.snapshot(),
    };
  }

  function persistSoon(): void {
    if (persistTimer !== null) return;
    persistTimer = deps.setTimer(() => {
      persistTimer = null;
      void deps.save(snapshot()).catch(() => undefined);
    }, FEED_PERSIST_MS);
  }

  async function persistNow(): Promise<void> {
    if (persistTimer !== null) deps.clearTimer(persistTimer);
    persistTimer = null;
    await deps.save(snapshot()).catch(() => undefined);
  }

  function restore(saved: unknown): void {
    if (!isRecord(saved) || saved['v'] !== STATE_VERSION) return;
    const value = saved as unknown as PersistedFeed;
    if (isRecord(value.config) && isRecord(value.config.sources)) {
      const kept: FeedConfigRuntime['sources'] = {};
      for (const source of MARKET_SOURCES) {
        const request = value.config.sources[source];
        if (request && typeof request.url === 'string' && request.method === 'GET') kept[source] = { url: request.url, method: 'GET' };
      }
      config = { sources: kept, csfloatShare: clampCsfloatFeedShare(value.config.csfloatShare) };
    }
    if (isRecord(value.leases)) {
      for (const [tabId, until] of Object.entries(value.leases)) if (typeof until === 'number' && Number.isSafeInteger(Number(tabId))) leases.set(Number(tabId), until);
    }
    // A state saved before holders were kept: each lease wants what the feed read then.
    const configured = config ? MARKET_SOURCES.filter((source) => config?.sources[source]) : [];
    for (const tabId of leases.keys()) {
      const stored = isRecord(value.holders) ? value.holders[String(tabId)] : undefined;
      holders.set(tabId, Array.isArray(stored) ? MARKET_SOURCES.filter((source) => stored.includes(source)) : configured);
    }
    startedAt = typeof value.startedAt === 'number' ? value.startedAt : null;
    for (const platform of MARKET_FEED_PLATFORMS) {
      const stored = value.platforms?.[platform];
      if (!stored) continue;
      Object.assign(platforms[platform], {
        attempts: typeof stored.attempts === 'number' ? stored.attempts : 0,
        ...(stored.issue ? { issue: stored.issue } : {}),
        ...(typeof stored.retryAt === 'number' ? { retryAt: stored.retryAt } : {}),
        lastRequestAt: typeof stored.lastRequestAt === 'number' ? stored.lastRequestAt : null,
        lastPollAt: typeof stored.lastPollAt === 'number' ? stored.lastPollAt : null,
      });
    }
    if (isRecord(value.sources)) {
      for (const source of MARKET_SOURCES) {
        const stored = value.sources[source];
        if (isRecord(stored)) sources[source] = { ...idleSource(deps.now()), ...stored };
      }
    }
    restoreCsfloatFeedLedger(value.ledger);
    buffer = new MarketFeedBuffer(value.buffer);
  }

  function ready(): Promise<void> {
    restored ??= deps
      .load()
      .then(restore)
      .catch(() => undefined);
    return restored;
  }

  // ─── Leases ─────────────────────────────────────────────────────────────────

  /** The sources the live holders want, in the feed's order. */
  function wantedSources(): MarketSource[] {
    const wanted = new Set<MarketSource>();
    for (const tabId of leases.keys()) for (const source of holders.get(tabId) ?? []) wanted.add(source);
    return MARKET_SOURCES.filter((source) => wanted.has(source));
  }

  /** Drops the sources no live holder wants any more (a holder left); adding sources is `start`'s. */
  function dropUnwanted(): void {
    if (!config) return;
    const wanted = new Set(wantedSources());
    for (const source of MARKET_SOURCES) {
      if (!config.sources[source] || wanted.has(source)) continue;
      delete config.sources[source];
      delete sources[source];
    }
  }

  function removeHolder(tabId: number): boolean {
    holders.delete(tabId);
    if (!leases.delete(tabId)) return false;
    dropUnwanted();
    return true;
  }

  function pruneLeases(now: number): void {
    let removed = false;
    for (const [tabId, until] of leases) {
      if (until > now) continue;
      leases.delete(tabId);
      holders.delete(tabId);
      removed = true;
    }
    if (removed) dropUnwanted();
  }

  /** Whether anything wants the feed now: a QTS tab's lease. QUICK-235 adds the tabless "background mode" here. */
  function feedWanted(now: number): boolean {
    pruneLeases(now);
    return config !== null && leases.size > 0 && Object.keys(config.sources).length > 0;
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  function sourcesOf(platform: MarketFeedPlatform): MarketSource[] {
    if (!config) return [];
    return MARKET_SOURCES.filter((source) => config?.sources[source] && MARKET_FEED_SOURCE_PLATFORM[source] === platform);
  }

  function platformState(platform: MarketFeedPlatform): MarketFeedPlatformState {
    const lane = platforms[platform];
    const configured = sourcesOf(platform).length > 0;
    const paused = lane.issue !== undefined && lane.retryAt !== undefined;
    const status: MarketFeedPlatformState['status'] = !configured || !running ? 'off' : paused ? 'paused' : lane.heldBy === 'budget' ? 'held' : 'running';
    return {
      status,
      attempts: lane.attempts,
      ...(lane.issue ? { issue: lane.issue } : {}),
      ...(paused && lane.retryAt !== undefined ? { retryAt: lane.retryAt } : {}),
      ...(lane.heldBy && running ? { heldBy: lane.heldBy } : {}),
      intervalMs: platform === 'cs.money' && configured ? CSMONEY_FEED_INTERVAL_MS : lane.intervalMs,
      nextAt: running && configured ? (paused ? (lane.retryAt ?? null) : lane.nextAt) : null,
      lastPollAt: lane.lastPollAt,
    };
  }

  function state(): MarketFeedState {
    const now = deps.now();
    const share = config?.csfloatShare ?? clampCsfloatFeedShare(undefined);
    const ledger = csfloatFeedLedger();
    const reserved = reservedCsfloatRequests(now);
    const allowance = csfloatFeedAllowance(ledger, { share, reserved, now });
    const csfloat = platformState('csfloat.com');
    const latency: MarketFeedState['latency'] = {};
    const sourceStates: MarketFeedState['sources'] = {};
    for (const source of MARKET_SOURCES) {
      const view = buffer.latency(source, now);
      if (view) latency[source] = view;
      const runtime = sources[source];
      if (runtime && config?.sources[source]) {
        const { polls, lastPollAt, lastOkAt, newListings, gaps } = runtime;
        sourceStates[source] = { polls, lastPollAt, lastOkAt, newListings, gaps };
      }
    }
    return {
      running,
      startedAt,
      now,
      csfloatShare: share,
      platforms: { 'csfloat.com': csfloat, 'cs.money': platformState('cs.money') },
      sources: sourceStates,
      csfloatBudget:
        ledger.budget && ledger.observedAt !== null && ledger.windowBudget !== null
          ? {
              limit: ledger.budget.limit,
              remaining: ledger.budget.remaining,
              resetAt: ledger.budget.resetAt,
              observedAt: ledger.observedAt,
              windowBudget: ledger.windowBudget,
              feedSpent: ledger.feedSpent,
              feedAllowance: allowance ?? 0,
              reserved,
            }
          : null,
      latency,
      coverageAtRisk: running && csfloat.status !== 'off' && (csfloat.status === 'held' || isMarketFeedCoverageAtRisk(csfloat.intervalMs)),
      seq: buffer.seq,
      buffered: buffer.size,
      coveredSince: buffer.coveredSince(),
    };
  }

  function broadcast(update: Omit<MarketFeedUpdate, 'state'>): void {
    const message: MarketFeedUpdate = { state: state(), ...update };
    // A holder that is no tab (the buy-order engine) is told through `onListings`.
    for (const tabId of leases.keys()) if (tabId >= 0) void deps.push(tabId, message).catch(() => false);
  }

  // ─── Loop ───────────────────────────────────────────────────────────────────

  function schedule(delayMs: number): void {
    if (timer !== null) deps.clearTimer(timer);
    timer = deps.setTimer(
      () => {
        timer = null;
        void tick();
      },
      Math.min(FEED_KEEPALIVE_MS, Math.max(250, delayMs))
    );
  }

  function halt(): void {
    if (!running) return;
    running = false;
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    void deps.watchdog(false).catch(() => undefined);
    void persistNow();
  }

  /** Plans one marketplace: starts its poll when due, else returns when it is due. */
  function planPlatform(platform: MarketFeedPlatform, now: number): number | null {
    const lane = platforms[platform];
    const configured = sourcesOf(platform);
    if (!configured.length || lane.inFlight) return null;
    if (lane.issue && lane.retryAt !== undefined && lane.retryAt > now) return lane.retryAt;
    const activity = foregroundActivity(platform);
    if (activity.blockedUntil !== null && activity.blockedUntil > now) {
      lane.heldBy = 'foreground';
      lane.nextAt = activity.blockedUntil;
      return activity.blockedUntil;
    }
    if (platform === 'csfloat.com') {
      const decision = decideCsfloatFeed(csfloatFeedLedger(), {
        share: config?.csfloatShare ?? clampCsfloatFeedShare(undefined),
        reserved: reservedCsfloatRequests(now),
        foregroundInFlight: activity.inFlight,
        lastForegroundAt: activity.lastAt,
        now,
      });
      lane.intervalMs = decision.intervalMs;
      if (decision.kind === 'wait') {
        lane.heldBy = decision.reason === 'interval' ? undefined : decision.reason;
        lane.nextAt = decision.until;
        return decision.until;
      }
      lane.heldBy = undefined;
      void poll('csfloat');
      return null;
    }
    if (activity.inFlight > 0) {
      lane.heldBy = 'foreground';
      lane.nextAt = now + 1_000;
      return lane.nextAt;
    }
    if (activity.lastAt !== null && now < activity.lastAt + FEED_FOREGROUND_YIELD_MS) {
      lane.heldBy = 'foreground';
      lane.nextAt = activity.lastAt + FEED_FOREGROUND_YIELD_MS;
      return lane.nextAt;
    }
    lane.heldBy = undefined;
    const gapEnds = lane.lastRequestAt === null ? now : lane.lastRequestAt + CSMONEY_FEED_GAP_MS;
    const due = configured.map((source) => ({ source, at: Math.max(sources[source]?.nextAt ?? now, gapEnds) })).sort((a, b) => a.at - b.at)[0];
    if (!due) return null;
    lane.nextAt = due.at;
    if (due.at > now) return due.at;
    void poll(due.source);
    return null;
  }

  async function tick(): Promise<void> {
    await ready();
    const now = deps.now();
    if (!feedWanted(now)) {
      halt();
      return;
    }
    running = true;
    await deps.keepAlive().catch(() => undefined);
    let next = now + FEED_KEEPALIVE_MS;
    for (const platform of MARKET_FEED_PLATFORMS) {
      const due = planPlatform(platform, now);
      if (due !== null) next = Math.min(next, due);
    }
    schedule(next - deps.now());
  }

  function pause(platform: MarketFeedPlatform, issue: MarketFeedIssue, at: number): void {
    const lane = platforms[platform];
    lane.attempts += 1;
    lane.issue = issue;
    lane.retryAt = marketFeedRetryAt(issue, lane.attempts, at);
    lane.heldBy = undefined;
    for (const source of sourcesOf(platform)) {
      const runtime = sources[source];
      if (runtime) runtime.afterPause = true;
    }
  }

  async function poll(source: MarketSource): Promise<void> {
    const platform = MARKET_FEED_SOURCE_PLATFORM[source];
    const request = config?.sources[source];
    const lane = platforms[platform];
    if (!request) return;
    const sentAt = deps.now();
    lane.inFlight = true;
    lane.lastRequestAt = sentAt;
    const runtime = (sources[source] ??= idleSource(sentAt));
    runtime.nextAt = sentAt + (platform === 'cs.money' ? CSMONEY_FEED_INTERVAL_MS : 0);
    let answer: ProxyResult;
    try {
      answer = await deps.proxy(request.url, { method: 'GET', platform, purpose: 'schedule-check' });
    } catch (error) {
      answer = { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error) };
    }
    const at = deps.now();
    lane.inFlight = false;
    lane.lastPollAt = at;
    // Stopped, or the source left the config, while the request ran: its answer is not read.
    if (!running || config?.sources[source] !== request) {
      if (running) void tick();
      return;
    }
    runtime.polls += 1;
    runtime.lastPollAt = at;
    // A refused request or one without access never left; a lost one names no window.
    if (platform === 'csfloat.com' && answer.status > 0 && !answer.error) recordFeedCsfloatAnswer(answer.headers, at);
    const issue = detectMarketFeedIssue(platform, answer, at);
    const rows = issue ? null : parseMarketFeedRows(source, answer);
    if (issue || !rows) {
      pause(platform, issue ?? { kind: 'error', status: answer.status }, at);
      broadcast({ rows: [], gone: [] });
      persistSoon();
      void tick();
      return;
    }
    lane.attempts = 0;
    lane.issue = undefined;
    lane.retryAt = undefined;
    const pace = Math.max(2 * (platform === 'cs.money' ? CSMONEY_FEED_INTERVAL_MS : (lane.intervalMs ?? 0)), CONTINUITY_MS);
    const baseline = runtime.lastOkAt === null;
    const continuous = !baseline && !runtime.afterPause && at - (runtime.lastOkAt ?? 0) <= pace;
    const serverAt = serverTime(answer.headers);
    const result = buffer.ingest(source, rows, at, { baseline, continuous, ...(serverAt !== undefined ? { serverAt } : {}) });
    if (!baseline && !result.overlapped && rows.length > 0) runtime.gaps += 1;
    runtime.newListings += result.added.length;
    runtime.lastOkAt = at;
    runtime.afterPause = false;
    if (result.added.length && deps.onListings) {
      try {
        deps.onListings(result.added, at);
      } catch {
        // The engine's failure must not stop the feed.
      }
    }
    broadcast({ rows: result.added, gone: result.gone });
    persistSoon();
    void tick();
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  async function start(data: unknown, tabId: number | undefined): Promise<MarketFeedStateResponse> {
    await ready();
    const requestId = isRecord(data) && typeof data['requestId'] === 'string' ? data['requestId'].slice(0, 64) : '';
    const parsed = readConfig(isRecord(data) ? data['config'] : undefined);
    if (!parsed) return { requestId, state: state(), error: 'invalid_config' };
    if (!parsed.sources.length) return { requestId, state: state(), error: 'no_sources' };
    for (const { source, request } of parsed.sources) {
      const match = await deps.resolve(MARKET_FEED_SOURCE_PLATFORM[source], request, 'schedule-check');
      if (!match.ok || match.operation.id !== MARKET_FEED_OPERATION_IDS[source]) return { requestId, state: state(), error: 'operation_refused' };
    }
    const now = deps.now();
    const wasRunning = feedWanted(now);
    const key = tabId ?? -1;
    // This holder's sources replace its own earlier ones; the feed reads what every live holder wants.
    holders.set(
      key,
      parsed.sources.map(({ source }) => source)
    );
    leases.set(key, now + MARKET_FEED_LEASE_MS);
    const asked = new Map(parsed.sources.map(({ source, request }) => [source, request]));
    const next: FeedConfigRuntime = { sources: {}, csfloatShare: parsed.share };
    for (const source of wantedSources()) {
      const current = config?.sources[source];
      const request = asked.get(source) ?? current;
      if (!request) continue;
      next.sources[source] = current && current.url === request.url ? current : request;
    }
    // A cs.money source joining waits its turn: the two sources stay 5 s apart.
    let offset = 0;
    const kept: Partial<Record<MarketSource, SourceRuntime>> = {};
    for (const source of MARKET_SOURCES) {
      if (!next.sources[source]) continue;
      const existing = wasRunning ? sources[source] : undefined;
      if (existing && config?.sources[source] === next.sources[source]) {
        kept[source] = existing;
        continue;
      }
      // A new or re-added source starts with a baseline answer: what it shows first was listed before it was read.
      kept[source] = idleSource(now + (MARKET_FEED_SOURCE_PLATFORM[source] === 'cs.money' ? offset : 0));
      if (MARKET_FEED_SOURCE_PLATFORM[source] === 'cs.money') offset += CSMONEY_FEED_GAP_MS;
    }
    config = next;
    sources = kept;
    if (!wasRunning) startedAt = now;
    running = true;
    await deps.watchdog(true).catch(() => undefined);
    await persistNow();
    void tick();
    return { requestId, state: state() };
  }

  async function stop(data: unknown, tabId: number | undefined): Promise<MarketFeedStateResponse> {
    await ready();
    const requestId = isRecord(data) && typeof data['requestId'] === 'string' ? data['requestId'].slice(0, 64) : '';
    removeHolder(tabId ?? -1);
    if (!feedWanted(deps.now())) halt();
    else persistSoon();
    return { requestId, state: state() };
  }

  async function retry(data: unknown): Promise<MarketFeedStateResponse> {
    await ready();
    const requestId = isRecord(data) && typeof data['requestId'] === 'string' ? data['requestId'].slice(0, 64) : '';
    const platform = isRecord(data) ? data['platform'] : undefined;
    if (platform === 'csfloat.com' || platform === 'cs.money') {
      // The next failure still counts as one more in a row: "Try now" never resets the backoff.
      const lane = platforms[platform];
      const now = deps.now();
      if (lane.retryAt !== undefined) lane.retryAt = now;
      // Its sources are due at once (still 5 s after its last request, and never into an empty CSFloat window).
      for (const source of sourcesOf(platform)) {
        const runtime = sources[source];
        if (runtime) runtime.nextAt = Math.min(runtime.nextAt, now);
      }
      if (running) void tick();
    }
    return { requestId, state: state() };
  }

  /** The page's catch-up read: new listings after `sinceSeq` with their rows; renews the tab's lease. */
  async function read(data: unknown, tabId: number | undefined): Promise<MarketFeedUpdate> {
    await ready();
    const requestId = isRecord(data) && typeof data['requestId'] === 'string' ? data['requestId'].slice(0, 64) : '';
    const sinceSeq = isRecord(data) && typeof data['sinceSeq'] === 'number' && Number.isFinite(data['sinceSeq']) ? data['sinceSeq'] : 0;
    const now = deps.now();
    const key = tabId ?? -1;
    if (leases.has(key) && (leases.get(key) ?? 0) > now) leases.set(key, now + MARKET_FEED_LEASE_MS);
    return { requestId, state: state(), rows: buffer.rowsSince(sinceSeq), gone: buffer.recentGone(now) };
  }

  /** The compact last hour (QUICK-232 preview). Does not renew a lease: reading the buffer does not keep the feed on. */
  async function readBuffer(data: unknown): Promise<MarketFeedBufferResponse> {
    await ready();
    const request = (isRecord(data) ? data : {}) as Partial<MarketFeedBufferRequest>;
    const requestId = typeof request.requestId === 'string' ? request.requestId.slice(0, 64) : '';
    const sinceMs = typeof request.sinceMs === 'number' && Number.isFinite(request.sinceMs) ? request.sinceMs : undefined;
    const wanted = Array.isArray(request.sources) ? new Set(request.sources.filter(isMarketSource)) : undefined;
    const now = deps.now();
    buffer.prune(now);
    return {
      requestId,
      now,
      running,
      coveredSince: buffer.coveredSince(),
      listings: buffer.read({ ...(sinceMs !== undefined ? { sinceMs } : {}), ...(wanted ? { sources: wanted } : {}) }),
    };
  }

  function tabRemoved(tabId: number): void {
    if (!removeHolder(tabId)) return;
    if (!feedWanted(deps.now())) halt();
  }

  /**
   * QUICK-233: renews a holder's lease that `start` granted (the buy-order engine renews with its own lease); false
   * when it holds none (it must `start` again).
   */
  function hold(holder: number, until: number): boolean {
    const now = deps.now();
    pruneLeases(now);
    if (!leases.has(holder) || until <= now) return false;
    leases.set(holder, Math.max(leases.get(holder) ?? 0, Math.min(until, now + MARKET_FEED_LEASE_MS)));
    return true;
  }

  /** QUICK-233: the sources a holder asked for while its lease is live; null when it holds none. */
  function heldSources(holder: number): MarketSource[] | null {
    pruneLeases(deps.now());
    return leases.has(holder) ? [...(holders.get(holder) ?? [])] : null;
  }

  /** Worker start and the watchdog alarm: picks the loop up again when a tab still holds a lease. */
  async function resume(): Promise<void> {
    await ready();
    if (!feedWanted(deps.now())) {
      if (running) halt();
      else void deps.watchdog(false).catch(() => undefined);
      return;
    }
    running = true;
    if (timer === null) void tick();
  }

  // A page request ending (or a released reservation) may let the feed go sooner than it planned.
  onForegroundSettled(() => {
    if (running) schedule(0);
  });

  return { start, stop, retry, read, readBuffer, tabRemoved, resume, state, hold, heldSources };
}

export type MarketFeed = ReturnType<typeof createMarketFeed>;
