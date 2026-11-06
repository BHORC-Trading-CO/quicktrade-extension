// apps/extension/background/market-buy/attempt-registry.ts
//
// QUICK-226 (R-C4): one buy attempt per listing at a time, for every tab and every buy-order rule of this browser. The
// executor claims a listing before it reads anything and settles it with the result; a claim is refused while another
// attempt on the listing runs, after an `unknown` outcome (the listing may be ours already) and after `bought`.
//
// The records live in worker memory and in `storage.session`, so a worker restart in the middle of an attempt still
// knows it: an attempt that never settled is taken as `unknown` once it is older than IN_FLIGHT_STALE_MS when its buy
// request had been handed to the network, else as `not_sent`. The check-and-set itself is synchronous (after the one
// load), so two messages arriving together cannot both claim a listing.
import type { MarketBuyOutcome, MarketBuyRequest, MarketBuyResult } from '@qts/contracts';
import { MARKET_BUY_BOUGHT_HOLD_MS, MARKET_BUY_UNKNOWN_HOLD_MS } from '@qts/contracts';

export const ATTEMPTS_SESSION_KEY = 'qts:market_buy_attempts';
/** Longer than the re-reads, the buy request and a bot confirmation together: an attempt still open by then stopped. */
export const IN_FLIGHT_STALE_MS = 2 * 60_000;
/** Attempts that may run at once across listings. */
export const MAX_IN_FLIGHT = 4;
/** Settled attempts are kept for replays and holds this long (≥ every hold). */
const RETAIN_MS = Math.max(MARKET_BUY_UNKNOWN_HOLD_MS, MARKET_BUY_BOUGHT_HOLD_MS);

export interface AttemptRecord {
  /** `<source>:<listing id>` */
  key: string;
  attemptId: string;
  state: 'in_flight' | 'settled';
  startedAt: number;
  /** The buy request was handed to the network (persisted before the fetch). */
  sent: boolean;
  outcome?: MarketBuyOutcome;
  settledAt?: number;
  /** The settled result, answered again to a repeat of the same attempt id. */
  result?: MarketBuyResult;
}

/**
 * `in_flight`: another attempt on the listing runs; `attempt_running`: this very attempt runs (a repeated message after a
 * worker restart): the page keeps waiting for its result, it is never "not sent".
 */
export type BusyReason = 'in_flight' | 'attempt_running' | 'unknown_hold' | 'already_bought' | 'too_many';

export type AttemptClaim =
  | { kind: 'claimed' }
  | { kind: 'replay'; result: MarketBuyResult }
  /** The same attempt id while it runs in this worker: its result, when it comes. */
  | { kind: 'running'; result: Promise<MarketBuyResult> }
  | { kind: 'busy'; reason: BusyReason; until?: number };

/** The part of `storage.session` the registry uses. */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function listingKey(request: Pick<MarketBuyRequest, 'source' | 'listingId'>): string {
  return `${request.source}:${request.listingId}`;
}

function isRecordShape(value: unknown): value is AttemptRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<AttemptRecord>;
  return (
    typeof record.key === 'string' &&
    typeof record.attemptId === 'string' &&
    (record.state === 'in_flight' || record.state === 'settled') &&
    typeof record.startedAt === 'number' &&
    typeof record.sent === 'boolean'
  );
}

export class AttemptRegistry {
  private readonly records = new Map<string, AttemptRecord>();
  /** The result of each attempt running in this worker, for a repeat of its message. */
  private readonly running = new Map<string, { promise: Promise<MarketBuyResult>; resolve: (result: MarketBuyResult) => void }>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly area: () => SessionArea | null,
    private readonly now: () => number
  ) {}

  private load(): Promise<void> {
    this.loading ??= (async () => {
      const area = this.area();
      if (!area) return;
      try {
        const stored = (await area.get(ATTEMPTS_SESSION_KEY))[ATTEMPTS_SESSION_KEY];
        const list = Array.isArray(stored) ? stored.filter(isRecordShape) : [];
        // A record claimed while this load ran wins over its stored copy.
        for (const record of list) if (!this.records.has(record.attemptId)) this.records.set(record.attemptId, record);
      } catch {
        // No session storage (or it failed): memory only, as on a browser without storage.session.
      }
    })();
    return this.loading;
  }

  private async persist(): Promise<void> {
    const area = this.area();
    if (!area) return;
    try {
      await area.set({ [ATTEMPTS_SESSION_KEY]: [...this.records.values()] });
    } catch {
      // The memory copy still holds the lock for this worker.
    }
  }

  /** An attempt that stopped without settling, and records past every hold. */
  private expire(now: number): void {
    for (const record of this.records.values()) {
      if (record.state === 'in_flight' && now - record.startedAt > IN_FLIGHT_STALE_MS) {
        record.state = 'settled';
        record.outcome = record.sent ? 'unknown' : 'not_sent';
        record.settledAt = now;
      }
      if (record.state === 'settled' && now - (record.settledAt ?? record.startedAt) > RETAIN_MS) this.records.delete(record.attemptId);
    }
  }

  /** The newest record of a listing. */
  private latest(key: string): AttemptRecord | undefined {
    let found: AttemptRecord | undefined;
    for (const record of this.records.values()) if (record.key === key && (!found || record.startedAt >= found.startedAt)) found = record;
    return found;
  }

  /** Claims the listing for this attempt, or says why not; a settled attempt id gets its result again (nothing is sent). */
  async claim(request: MarketBuyRequest): Promise<AttemptClaim> {
    await this.load();
    // Synchronous from here to the set: no other message can claim in between.
    const now = this.now();
    this.expire(now);
    const own = this.records.get(request.attemptId);
    if (own?.state === 'settled' && own.result) return { kind: 'replay', result: own.result };
    if (own) {
      const running = this.running.get(request.attemptId);
      return running ? { kind: 'running', result: running.promise } : { kind: 'busy', reason: 'attempt_running' };
    }
    const key = listingKey(request);
    const latest = this.latest(key);
    if (latest?.state === 'in_flight') return { kind: 'busy', reason: 'in_flight' };
    const settledAt = latest?.settledAt ?? 0;
    if (latest?.outcome === 'unknown' && now - settledAt < MARKET_BUY_UNKNOWN_HOLD_MS) return { kind: 'busy', reason: 'unknown_hold', until: settledAt + MARKET_BUY_UNKNOWN_HOLD_MS };
    if (latest?.outcome === 'bought' && now - settledAt < MARKET_BUY_BOUGHT_HOLD_MS) return { kind: 'busy', reason: 'already_bought', until: settledAt + MARKET_BUY_BOUGHT_HOLD_MS };
    if ([...this.records.values()].filter((record) => record.state === 'in_flight').length >= MAX_IN_FLIGHT) return { kind: 'busy', reason: 'too_many' };
    this.records.set(request.attemptId, { key, attemptId: request.attemptId, state: 'in_flight', startedAt: now, sent: false });
    let resolve!: (result: MarketBuyResult) => void;
    const promise = new Promise<MarketBuyResult>((done) => {
      resolve = done;
    });
    this.running.set(request.attemptId, { promise, resolve });
    await this.persist();
    return { kind: 'claimed' };
  }

  /** Right before the buy request is handed to the network: from now on a lost attempt counts as `unknown`. */
  async markSent(attemptId: string): Promise<void> {
    const record = this.records.get(attemptId);
    if (!record) return;
    record.sent = true;
    await this.persist();
  }

  async settle(result: MarketBuyResult): Promise<void> {
    const record = this.records.get(result.attemptId);
    if (!record) return;
    record.state = 'settled';
    record.outcome = result.outcome;
    record.sent = record.sent || result.sent;
    record.settledAt = this.now();
    record.result = result;
    this.running.get(result.attemptId)?.resolve(result);
    this.running.delete(result.attemptId);
    await this.persist();
  }

  /**
   * The answer of a buy request that had timed out (settled `unknown`): a purchase holds the listing as bought from
   * now; a definite refusal releases the unknown hold. Another unknown changes nothing. The page is not told.
   */
  async settleLate(attemptId: string, outcome: MarketBuyOutcome): Promise<void> {
    const record = this.records.get(attemptId);
    if (!record || record.state !== 'settled' || record.outcome !== 'unknown' || outcome === 'unknown') return;
    record.outcome = outcome;
    record.settledAt = this.now();
    await this.persist();
  }

  /**
   * QUICK-233: whether any attempt on the listing is on record (running, or settled within the records' retention),
   * whatever its outcome: a buy-order rule never tries a listing a click or another rule already tried.
   */
  async hasRecord(key: string): Promise<boolean> {
    await this.load();
    this.expire(this.now());
    for (const record of this.records.values()) if (record.key === key) return true;
    return false;
  }

  /** For tests and the status of one listing. */
  snapshot(): AttemptRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}
