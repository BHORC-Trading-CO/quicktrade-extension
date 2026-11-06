// apps/extension/background/buy-orders/engine.ts
//
// QUICK-233 (epic QUICK-216 R-F3–R-F5, R-F7, R-F8): the buy-order engine. Every new listing of the live feed (never a
// baseline row, each once) is matched against the account's switched-on rules in their order; the first rule in `auto`
// mode that matches and passes its guards buys it through the one buy executor (QUICK-226, origin `buy_order`), and
// every rule in Test mode that matches logs what it would do. Nothing is bought unless this browser holds a live lease
// the server granted to the signed-in account the rules belong to.
//
// One automatic attempt:
//   1. the guards (`checkBuyOrderGuards`): the rule's run of failures, a linked Steam account, the price limit, one try
//      per listing, the account's and the rule's daily budgets and its items per day including this buy, the balance
//      left on the marketplace account the executor last confirmed;
//   2. the server's journal row is opened through the page (the server checks the lease and the budgets again, on its
//      own figures) while the executor re-reads the listing; the executor's account step uses a confirmation the engine
//      keeps fresh, so the re-read is the only marketplace request before the buy;
//   3. the executor sends the buy request only once the row is open (`beforeSend`), and only within R-F7's second of
//      QTS's own time after the feed answer: a row not open by then (and not while the re-read still ran) stops it.
//   4. the result settles the row (always, sent or not: a row whose settle never got through runs out as `unknown`, and
//      the activity says so), updates the spend, the rule's run of failures and the activity.
// A result the executor could not read (`unknown`) counts as spent and is never retried: the listing is never tried
// again by the engine, and the server refuses another attempt on it.
//
// A rule's run of failures counts only buy requests that were sent and refused (or whose result is unknown); a captcha
// or a rate limit is the marketplace's outage and a listing sold first is a race lost. The engine counts its own and
// takes the server's count from the journal (every device), whichever is higher; 3 in a row pause the rule: the server
// refuses its attempts, and the engine switches it off on the server, asking again until it is.
//
// What the engine remembers (the runs of failures, Test mode's day, the activity) is kept per account: a page signed in
// to another account never resets or reads the account that holds the lease. Stop all pressed in this browser stops
// every account of it.
import type {
  BuyOrderActivity,
  BuyOrderActivityValues,
  BuyOrderAttemptOpenRequest,
  BuyOrderGuardRefusal,
  BuyOrderListing,
  BuyOrderMismatch,
  BuyOrderRule,
  BuyOrderRuleRuntime,
  BuyOrdersEngineAnswer,
  BuyOrdersEngineRequest,
  BuyOrdersEngineState,
  BuyOrdersEngineView,
  BuyOrdersLeasePush,
  BuyOrdersSnapshot,
  BuyOrdersSpend,
  MarketBuyRequest,
  MarketBuyResult,
  MarketFeedConfig,
  MarketFeedListing,
  MarketFeedRow,
  MarketSource,
} from '@qts/contracts';
import {
  addToSpend,
  BUY_ORDER_ACCOUNT_REFRESH_MS,
  BUY_ORDER_ACTIVITY_MAX,
  BUY_ORDER_ESTIMATE_HIT_TTL_MS,
  BUY_ORDER_ESTIMATE_MISS_TTL_MS,
  BUY_ORDER_FAILURE_LIMIT,
  BUY_ORDER_LEASE_MARGIN_MS,
  BUY_ORDER_LEASE_RENEW_MS,
  BUY_ORDER_OWN_TIME_MS,
  buyOrderActivityKindOf,
  buyOrderFailureEffect,
  buyOrderListingFromFeedEntry,
  buyOrderListingKey,
  checkBuyOrderGuards,
  guardActivityValues,
  isBuyOrderEstimateCandidate,
  isMarketBuyPriceCents,
  isNearMiss,
  localLeaseUntil,
  MARKET_BUY_LISTING_READ_TIMEOUT_MS,
  MARKET_FEED_BUFFER_MS,
  MARKET_FEED_SEEN_GRACE_MS,
  MARKET_PHASES,
  MARKET_SOURCES,
  matchBuyOrderRule,
  parseMarketBuyResult,
  serverClockOffset,
  utcDayOf,
} from '@qts/contracts';

import type { AccountPlatform, MarketAccountCache } from '../market-buy/account-cache';
import type { MarketBuyOptions } from '../market-buy/executor';

/** The engine's ticks while it runs: lease renewals, account confirmations, the day's rollover. */
export const ENGINE_TICK_MS = 5_000;
/** The page's answer to a journal open may take this long; the buy waits for it only within R-F7's second (see `beforeSend`). */
export const ENGINE_OPEN_TIMEOUT_MS = MARKET_BUY_LISTING_READ_TIMEOUT_MS + BUY_ORDER_OWN_TIME_MS;
/** A settle, a pause or a renewal: no buy waits for them. */
export const ENGINE_RELAY_TIMEOUT_MS = 15_000;
/** QTS estimates the engine asks per minute at most (the route allows 10 per user; the Market page keeps the rest). */
export const ENGINE_ESTIMATE_ASKS_PER_MINUTE = 6;
/** After a failed account confirmation, the next one waits this long. */
const ACCOUNT_RETRY_MS = 60_000;
/** A renewal is asked of the page at most this often. */
const RENEW_ASK_MS = 10_000;
/** Pages that pushed a lease within this long are told about activity and asked for server work. */
const TAB_RECENT_MS = 2 * BUY_ORDER_LEASE_RENEW_MS + 10_000;
const PERSIST_DELAY_MS = 2_000;
const STATE_VERSION = 2;
/** Accounts whose memory is kept (most recent first). */
const ACCOUNTS_KEPT = 3;
/** A settle that did not get through is sent again after these delays (a row past its time still takes it). */
const SETTLE_RETRY_MS = [30_000, 120_000] as const;
/** A rule's pause the server has yet to take is asked again after these delays (the last one repeats). */
const PAUSE_RETRY_MS = [5_000, 15_000, 60_000, 300_000] as const;

/** The conditions a skip of a rule with its own item is logged for: the item's price or value was the reason. */
const LOGGED_SKIP_REASONS: ReadonlySet<BuyOrderMismatch['code']> = new Set<BuyOrderMismatch['code']>([
  'price_above_limit',
  'discount_too_small',
  'estimate_unknown',
  'sticker_premium',
  'sticker_premium_unknown',
]);

/** Guards that concern only this rule: the next matching rule may still buy the listing (R-F4). */
const RULE_GUARDS: ReadonlySet<BuyOrderGuardRefusal['code']> = new Set<BuyOrderGuardRefusal['code']>(['rule_paused', 'failures_pending', 'price_above_limit', 'rule_budget', 'items']);

export interface BuyOrderEngineDeps {
  now: () => number;
  newId: () => string;
  /** The one buy executor (QUICK-226). */
  execute: (request: MarketBuyRequest, options: MarketBuyOptions) => Promise<MarketBuyResult>;
  /** Any attempt on record for the listing in the executor's registry (a click or a rule, any outcome). */
  attempted: (key: string) => Promise<boolean>;
  accounts: MarketAccountCache;
  /** Reads the marketplace account and keeps its confirmation in `accounts`; true when it is the linked Steam account. */
  confirmAccount: (platform: AccountPlatform, steamId: string) => Promise<boolean>;
  /** One request to a page that holds the lease (the most recent first); null without an answer by `timeoutMs`. */
  ask: (tabIds: readonly number[], request: BuyOrdersEngineRequest, timeoutMs: number) => Promise<BuyOrdersEngineAnswer | null>;
  /** An activity worth a notification, to those pages. */
  notify: (tabIds: readonly number[], event: BuyOrderActivity) => void;
  /** The live feed, with the engine as one of its holders. */
  feed: {
    start: (config: MarketFeedConfig) => Promise<boolean>;
    hold: (until: number) => boolean;
    sources: () => MarketSource[] | null;
    stop: () => Promise<void>;
  };
  /** storage.local: what survives a browser restart (the activity, the paused rules, the local stop). */
  load: () => Promise<unknown>;
  save: (state: PersistedEngine) => Promise<void>;
  /** storage.session: the lease and the spend, so a worker restart keeps running. */
  loadSession: () => Promise<unknown>;
  saveSession: (state: SessionEngine) => Promise<void>;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  botsEnabled: boolean;
  csmoneyMarketEnabled: boolean;
  deviceId: () => Promise<string>;
}

interface RuleMemory {
  /** The rule's `updatedAt` when the failures were counted: any change to the rule starts again. */
  updatedAt: string;
  failures: number;
  pausedAt: number | null;
  /** A pause the server has yet to take: when to ask again, and how often it was asked. */
  pauseRetry?: { at: number; tries: number } | null;
}

/** What the engine remembers of one account (Clerk id). */
export interface AccountMemory {
  rules: Record<string, RuleMemory>;
  test: { day: string; rules: Record<string, { items: number; cents: number }> };
  activity: BuyOrderActivity[];
}

export interface PersistedEngine {
  v: number;
  /** Stop all pressed in this browser (its clock), for every account; null when it may run. */
  stoppedHere: number | null;
  accounts: Record<string, AccountMemory>;
  /** The accounts by their last use, most recent first. */
  recent: string[];
  /** Settles that did not get through, sent again when due (a timer, the next tick, or the next worker start). */
  settles: PendingSettle[];
}

/** A journal settle to send again; `activityId` names the entry logged "unknown" for a never-sent attempt. */
interface PendingSettle {
  clerkId: string;
  attemptId: string;
  seenAt: number;
  result: MarketBuyResult;
  activityId: string | null;
  /** The retry this is (an index of SETTLE_RETRY_MS) and when it is due (this computer's clock). */
  retry: number;
  at: number;
}

/** Settles kept for sending again at most. */
const SETTLES_KEPT = 50;

function restoredSettles(value: unknown): PendingSettle[] {
  if (!Array.isArray(value)) return [];
  const settles: PendingSettle[] = [];
  for (const entry of value.slice(0, SETTLES_KEPT)) {
    if (!isRecord(entry)) continue;
    const result = parseMarketBuyResult(entry['result']);
    const { clerkId, attemptId, seenAt, activityId, retry, at } = entry;
    if (!result || typeof clerkId !== 'string' || typeof attemptId !== 'string' || result.attemptId !== attemptId) continue;
    if (typeof seenAt !== 'number' || typeof retry !== 'number' || typeof at !== 'number') continue;
    settles.push({ clerkId, attemptId, seenAt, result, activityId: typeof activityId === 'string' ? activityId : null, retry, at });
  }
  return settles;
}

interface LeaseState {
  push: BuyOrdersLeasePush & { status: NonNullable<BuyOrdersLeasePush['status']> };
  /** This browser's lease end on its clock (null when another device holds it or none is live). */
  until: number | null;
  /** The server's clock minus this one's. */
  offset: number;
}

export interface SessionEngine {
  v: number;
  lease: LeaseState | null;
  spend: { figure: BuyOrdersSpend; serverNow: number } | null;
  tabs: Record<string, number>;
}

interface Journal {
  state: 'pending' | 'opened' | 'refused' | 'failed';
  code?: string;
}

const platformOf = (source: MarketSource): AccountPlatform => (source === 'csfloat' ? 'csfloat.com' : 'cs.money');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The estimate's cache key: what the server prices by (name, phase, seed). */
function estimateKey(listing: BuyOrderListing): string {
  return [listing.marketHashName, listing.phase ?? '', listing.paintSeed ?? ''].join('\n');
}

const emptyAccount = (): AccountMemory => ({ rules: {}, test: { day: '', rules: {} }, activity: [] });

function restoredAccount(value: unknown): AccountMemory {
  if (!isRecord(value)) return emptyAccount();
  const test = value['test'];
  return {
    rules: isRecord(value['rules']) ? (value['rules'] as Record<string, RuleMemory>) : {},
    test: isRecord(test) && typeof test['day'] === 'string' && isRecord(test['rules']) ? (test as AccountMemory['test']) : { day: '', rules: {} },
    activity: Array.isArray(value['activity']) ? (value['activity'] as BuyOrderActivity[]).slice(0, BUY_ORDER_ACTIVITY_MAX) : [],
  };
}

/** What the server judges besides the price, as the feed read it (`BuyOrderAttemptOpenRequest`, within the server's limits). */
function judgedFields(listing: BuyOrderListing): Pick<BuyOrderAttemptOpenRequest, 'paintSeed' | 'phase' | 'stickers'> {
  const seed = listing.paintSeed;
  return {
    paintSeed: seed !== null && Number.isInteger(seed) && seed >= 0 && seed <= 1000 ? seed : null,
    phase: listing.phase !== null && (MARKET_PHASES as readonly string[]).includes(listing.phase) ? listing.phase : null,
    stickers: listing.stickers
      .filter((sticker) => sticker.name.trim() !== '')
      .slice(0, 10)
      .map((sticker) => ({ name: sticker.name.slice(0, 256), priceCents: isMarketBuyPriceCents(sticker.priceCents) ? sticker.priceCents : null })),
  };
}

function activityListing(listing: BuyOrderListing): BuyOrderActivity['listing'] {
  return {
    source: listing.source,
    listingId: listing.listingId,
    marketHashName: listing.marketHashName,
    priceCents: listing.priceCents,
    floatValue: listing.floatValue,
    paintSeed: listing.paintSeed,
  };
}

/** The numbers a condition reason is told with. */
function mismatchValues(reason: BuyOrderMismatch): BuyOrderActivityValues {
  switch (reason.code) {
    case 'price_above_limit':
      return { limitCents: reason.limitCents };
    case 'discount_too_small':
      return { discountPct: reason.discountPct, wantPct: reason.wantPct };
    case 'sticker_premium':
      return { discountPct: reason.premiumPct, wantPct: reason.limitPct };
    default:
      return {};
  }
}

export function createBuyOrderEngine(deps: BuyOrderEngineDeps) {
  let deviceId = '';
  let snapshot: BuyOrdersSnapshot | null = null;
  let lease: LeaseState | null = null;
  let spend: SessionEngine['spend'] = null;
  const tabs = new Map<number, number>();
  let memory: PersistedEngine = { v: STATE_VERSION, stoppedHere: null, accounts: {}, recent: [], settles: [] };
  /** Settles being sent again now (by attempt id). */
  const settling = new Set<string>();
  /** Attempts whose journal row is being opened: counted until the server's figure has them. */
  const inFlight = new Map<string, { ruleId: string; priceCents: number }>();
  /** Each rule's automatic attempts between their guards and their result (by account and rule). */
  const running = new Map<string, number>();
  /** Rules whose pause is being asked of a page now. */
  const pausing = new Set<string>();
  /** Listings the engine has looked at (each once). */
  const handled = new Map<string, number>();
  const estimates = new Map<string, { cents: number | null; at: number }>();
  const estimateAsks: number[] = [];
  const accountChecks = new Map<AccountPlatform, { inFlight: boolean; retryAt: number }>();
  let lastFeedAt: number | null = null;
  let lastRenewAsk = 0;
  let wasRunning = false;
  let timer: unknown = null;
  let persistTimer: unknown = null;
  let ready: Promise<void> | null = null;

  // ─── Persistence ────────────────────────────────────────────────────────────────────────────

  function restore(saved: unknown, session: unknown): void {
    if (isRecord(saved) && saved['v'] === STATE_VERSION) {
      const accounts: Record<string, AccountMemory> = {};
      const recent = Array.isArray(saved['recent']) ? saved['recent'].filter((id): id is string => typeof id === 'string').slice(0, ACCOUNTS_KEPT) : [];
      const stored = isRecord(saved['accounts']) ? saved['accounts'] : {};
      for (const clerkId of recent) accounts[clerkId] = restoredAccount(stored[clerkId]);
      memory = {
        v: STATE_VERSION,
        stoppedHere: typeof saved['stoppedHere'] === 'number' ? saved['stoppedHere'] : null,
        accounts,
        recent: Object.keys(accounts),
        settles: restoredSettles(saved['settles']),
      };
    } else if (isRecord(saved) && saved['v'] === 1) {
      // The first version kept one account.
      const clerkId = typeof saved['clerkId'] === 'string' ? saved['clerkId'] : null;
      memory = {
        v: STATE_VERSION,
        stoppedHere: typeof saved['stoppedHere'] === 'number' ? saved['stoppedHere'] : null,
        accounts: clerkId ? { [clerkId]: restoredAccount(saved) } : {},
        recent: clerkId ? [clerkId] : [],
        settles: [],
      };
    }
    if (isRecord(session) && (session['v'] === STATE_VERSION || session['v'] === 1)) {
      const value = session as unknown as SessionEngine;
      if (value.lease && isRecord(value.lease.push) && isRecord(value.lease.push.status)) lease = value.lease;
      if (value.spend && isRecord(value.spend.figure)) spend = value.spend;
      if (isRecord(value.tabs)) for (const [tabId, at] of Object.entries(value.tabs)) if (typeof at === 'number') tabs.set(Number(tabId), at);
    }
  }

  function init(): Promise<void> {
    ready ??= (async () => {
      deviceId = await deps.deviceId();
      const [saved, session] = await Promise.all([deps.load().catch(() => undefined), deps.loadSession().catch(() => undefined)]);
      restore(saved, session);
    })();
    return ready;
  }

  function persistSoon(): void {
    if (persistTimer !== null) return;
    persistTimer = deps.setTimer(() => {
      persistTimer = null;
      void deps.save(memory).catch(() => undefined);
      void deps.saveSession(sessionState()).catch(() => undefined);
    }, PERSIST_DELAY_MS);
  }

  function sessionState(): SessionEngine {
    return { v: STATE_VERSION, lease, spend, tabs: Object.fromEntries([...tabs].map(([tabId, at]) => [String(tabId), at])) };
  }

  // ─── Each account's memory ──────────────────────────────────────────────────────────────────

  /** What the engine remembers of this account (kept for the last ACCOUNTS_KEPT); a throwaway one without an account. */
  function accountMemory(clerkId: string | null | undefined): AccountMemory {
    if (!clerkId) return emptyAccount();
    let known = memory.accounts[clerkId];
    if (!known) {
      known = emptyAccount();
      memory.accounts[clerkId] = known;
    }
    if (memory.recent[0] !== clerkId) {
      memory.recent = [clerkId, ...memory.recent.filter((id) => id !== clerkId)];
      for (const old of memory.recent.splice(ACCOUNTS_KEPT)) delete memory.accounts[old];
    }
    return known;
  }

  /** The account whose rules the engine has (the one it may run for, when the lease is that account's). */
  const current = (): AccountMemory => accountMemory(snapshot?.clerkId);

  // ─── Whether it runs ────────────────────────────────────────────────────────────────────────

  function enabledRules(): BuyOrderRule[] {
    return snapshot ? snapshot.rules.filter((rule) => rule.enabled) : [];
  }

  /** The engine's state now, and whether it may buy. */
  function runState(now: number): { state: BuyOrdersEngineState; canBuy: boolean } {
    if (!snapshot || !lease) return { state: 'idle', canBuy: false };
    const { status } = lease.push;
    // The rules, the page's account and the server's account must be one account.
    if (snapshot.clerkId !== lease.push.clerkId || status.clerkId !== snapshot.clerkId) return { state: 'idle', canBuy: false };
    if (!enabledRules().length) return { state: 'no_rules', canBuy: false };
    if (!status.switchedOn) return { state: 'switched_off', canBuy: false };
    if (status.stoppedAt !== null || memory.stoppedHere !== null) return { state: 'stopped', canBuy: false };
    if (!status.lease) return { state: 'waiting', canBuy: false };
    if (status.lease.deviceId !== deviceId) return { state: 'other_device', canBuy: false };
    if (lease.until === null || now >= lease.until - BUY_ORDER_LEASE_MARGIN_MS) return { state: 'waiting', canBuy: false };
    return { state: 'running', canBuy: status.steamId !== null };
  }

  function recentTabs(now: number): number[] {
    return [...tabs]
      .filter(([, at]) => now - at <= TAB_RECENT_MS)
      .sort((a, b) => b[1] - a[1])
      .map(([tabId]) => tabId);
  }

  // ─── Spend ──────────────────────────────────────────────────────────────────────────────────

  function takeFigure(figure: BuyOrdersSpend, serverNow: number): void {
    if (spend && spend.serverNow > serverNow) return;
    spend = { figure, serverNow };
  }

  /** Today's spend as the engine counts it: the server's newest figure plus attempts it is opening; null when the figure is of another day. */
  function effectiveSpend(now: number): BuyOrdersSpend | null {
    if (!spend || !lease) return null;
    if (now + lease.offset >= spend.figure.dayEndsAt) return null;
    let total = spend.figure;
    for (const { ruleId, priceCents } of inFlight.values()) total = addToSpend(total, ruleId, priceCents);
    return total;
  }

  function testDay(now: number, account: AccountMemory = current()): AccountMemory['test'] {
    const day = utcDayOf(now + (lease?.offset ?? 0));
    if (account.test.day !== day) account.test = { day, rules: {} };
    return account.test;
  }

  // ─── Rules' runs of failures (R-F3) ─────────────────────────────────────────────────────────

  function ruleMemory(rule: BuyOrderRule, account: AccountMemory = current()): RuleMemory {
    const known = account.rules[rule.id];
    if (known && known.updatedAt === rule.updatedAt) return known;
    // A new rule, or one the user changed or switched on again: it starts with no failures.
    const fresh: RuleMemory = { updatedAt: rule.updatedAt, failures: 0, pausedAt: null };
    account.rules[rule.id] = fresh;
    return fresh;
  }

  /**
   * The rule's run of failures: this browser's count or the server's (from the journal, every device), the higher. The
   * server's counts since the rule's last change, so a status from before that change (the user switched the rule on
   * again, the next renewal not yet in) says nothing of it.
   */
  function failuresOf(rule: BuyOrderRule): number {
    const status = lease && snapshot && lease.push.clerkId === snapshot.clerkId ? lease.push.status : null;
    const server = status && Date.parse(rule.updatedAt) < status.serverNow ? (status.failures[rule.id] ?? 0) : 0;
    return Math.max(ruleMemory(rule).failures, server);
  }

  const runningKey = (clerkId: string, ruleId: string) => `${clerkId}\n${ruleId}`;

  function runtimeOf(rule: BuyOrderRule, now: number): BuyOrderRuleRuntime {
    const remembered = ruleMemory(rule);
    const test = testDay(now).rules[rule.id] ?? { items: 0, cents: 0 };
    return { failures: failuresOf(rule), pausedAt: remembered.pausedAt, testItems: test.items, testCents: test.cents };
  }

  /**
   * Pauses each rule whose run of failures reached the limit (once), and switches it off on the server through a page,
   * asking again with backoff until the server has it: the rule reads switched off, or the user changed it.
   */
  function syncPauses(now: number): void {
    if (!snapshot) return;
    const clerkId = snapshot.clerkId;
    for (const rule of snapshot.rules) {
      const remembered = ruleMemory(rule);
      if (!rule.enabled) {
        remembered.pauseRetry = null;
        continue;
      }
      const failures = failuresOf(rule);
      if (failures >= BUY_ORDER_FAILURE_LIMIT && remembered.pausedAt === null) {
        remembered.pausedAt = now;
        remembered.pauseRetry = { at: now, tries: 0 };
        record({ kind: 'paused', ruleId: rule.id, ruleName: rule.name, listing: null, reason: 'failures', values: { failures } }, true);
      }
      const retry = remembered.pauseRetry;
      const key = runningKey(clerkId, rule.id);
      if (!retry || now < retry.at || pausing.has(key)) continue;
      pausing.add(key);
      void deps
        .ask(recentTabs(now), { requestId: deps.newId(), kind: 'pause_rule', ruleId: rule.id }, ENGINE_RELAY_TIMEOUT_MS)
        .catch(() => null)
        .then((answer) => {
          pausing.delete(key);
          remembered.pauseRetry =
            answer?.kind === 'pause_rule' && answer.ok ? null : { at: deps.now() + (PAUSE_RETRY_MS[Math.min(retry.tries, PAUSE_RETRY_MS.length - 1)] ?? 300_000), tries: retry.tries + 1 };
          persistSoon();
          return undefined;
        });
    }
  }

  // ─── Activity ───────────────────────────────────────────────────────────────────────────────

  /** An activity of the current account, or of `clerkId` (an attempt's own account): notified only to that account's pages. */
  function record(entry: Omit<BuyOrderActivity, 'id' | 'at'> & { at?: number }, notify = false, clerkId: string | null = snapshot?.clerkId ?? null): BuyOrderActivity {
    const activity: BuyOrderActivity = { ...entry, id: deps.newId(), at: entry.at ?? deps.now() };
    const account = accountMemory(clerkId);
    account.activity = [activity, ...account.activity].slice(0, BUY_ORDER_ACTIVITY_MAX);
    persistSoon();
    // The pages told are those of the lease's account (or, with no lease, of the rules' account).
    if (notify && clerkId !== null && (lease?.push.clerkId ?? snapshot?.clerkId) === clerkId) deps.notify(recentTabs(deps.now()), activity);
    return activity;
  }

  // ─── The feed ───────────────────────────────────────────────────────────────────────────────

  async function syncFeed(now: number): Promise<void> {
    const running = runState(now).state === 'running';
    const config = lease?.push.feed ?? null;
    if (!running || !config || !config.sources.length || lease?.until == null) {
      if (deps.feed.sources() !== null) await deps.feed.stop().catch(() => undefined);
      return;
    }
    const held = deps.feed.sources();
    const wanted = config.sources.map(({ source }) => source);
    const same = held !== null && held.length === wanted.length && wanted.every((source) => held.includes(source));
    if (same && deps.feed.hold(lease.until)) return;
    await deps.feed.start(config).catch(() => false);
  }

  /** After every change of the lease, the rules or the stop: the feed, the timer and the start/stop entries. */
  async function settleRunning(now: number): Promise<void> {
    const { state } = runState(now);
    const running = state === 'running';
    if (running && !wasRunning) record({ kind: 'started', ruleId: null, ruleName: null, listing: null, reason: null });
    if (!running && wasRunning) {
      const reason = state === 'stopped' ? 'stopped' : state === 'switched_off' ? 'switched_off' : state === 'other_device' ? 'other_device' : 'lease_ended';
      record({ kind: state === 'stopped' ? 'stopped' : 'lease_lost', ruleId: null, ruleName: null, listing: null, reason }, true);
    }
    wasRunning = running;
    syncPauses(now);
    await syncFeed(now);
    schedule();
  }

  // ─── Ticks: renewals, account confirmations, the lease's end ────────────────────────────────

  function schedule(): void {
    if (timer !== null) return;
    const now = deps.now();
    const { state } = runState(now);
    if (state === 'idle' || state === 'no_rules' || state === 'stopped' || state === 'switched_off') return;
    timer = deps.setTimer(() => {
      timer = null;
      void tick();
    }, ENGINE_TICK_MS);
  }

  async function tick(): Promise<void> {
    await init();
    const now = deps.now();
    const { state, canBuy } = runState(now);
    if (lease && now - lease.push.requestedAt >= BUY_ORDER_LEASE_RENEW_MS && now - lastRenewAsk >= RENEW_ASK_MS) {
      // A hidden tab's timers may be slowed: the extension's own timer asks the page to renew.
      lastRenewAsk = now;
      void deps.ask(recentTabs(now), { requestId: deps.newId(), kind: 'renew' }, ENGINE_RELAY_TIMEOUT_MS).catch(() => null);
    }
    if (state === 'running' && canBuy) refreshAccounts(now);
    retrySettles(now);
    await settleRunning(now);
  }

  /** A source this build buys from; the executor refuses the others before any request. */
  function sourceBuyable(source: MarketSource): boolean {
    if (source === 'csmoney-bots') return deps.botsEnabled;
    if (source === 'csmoney-market') return deps.csmoneyMarketEnabled;
    return true;
  }

  /** Keeps the confirmation of each marketplace an `auto` rule buys on fresh, so a buy needs no account read (R-F7). */
  function refreshAccounts(now: number): void {
    const steamId = lease?.push.status.steamId;
    if (!steamId) return;
    const platforms = new Set<AccountPlatform>();
    for (const rule of enabledRules()) {
      if (rule.mode !== 'auto') continue;
      for (const source of rule.sources) if (sourceBuyable(source)) platforms.add(platformOf(source));
    }
    for (const platform of platforms) {
      const check = accountChecks.get(platform) ?? { inFlight: false, retryAt: 0 };
      const age = deps.accounts.age(platform, steamId);
      if (check.inFlight || now < check.retryAt || (age !== null && age < BUY_ORDER_ACCOUNT_REFRESH_MS)) continue;
      check.inFlight = true;
      accountChecks.set(platform, check);
      void deps
        .confirmAccount(platform, steamId)
        .catch(() => false)
        .then((ok) => {
          check.inFlight = false;
          check.retryAt = ok ? 0 : deps.now() + ACCOUNT_RETRY_MS;
          return undefined;
        });
    }
  }

  // ─── Estimates ──────────────────────────────────────────────────────────────────────────────

  function cachedEstimate(listing: BuyOrderListing, now: number): number | null | undefined {
    const entry = estimates.get(estimateKey(listing));
    if (!entry) return undefined;
    const ttl = entry.cents === null ? BUY_ORDER_ESTIMATE_MISS_TTL_MS : BUY_ORDER_ESTIMATE_HIT_TTL_MS;
    if (now - entry.at >= ttl) {
      estimates.delete(estimateKey(listing));
      return undefined;
    }
    return entry.cents;
  }

  /** Asks the page for the QTS estimates of these listings, waiting no later than `deadline`. */
  async function fetchEstimates(listings: BuyOrderListing[], deadline: number): Promise<void> {
    const now = deps.now();
    while (estimateAsks.length && now - (estimateAsks[0] ?? 0) >= 60_000) estimateAsks.shift();
    if (estimateAsks.length >= ENGINE_ESTIMATE_ASKS_PER_MINUTE || deadline <= now) return;
    estimateAsks.push(now);
    const answer = await deps.ask(recentTabs(now), { requestId: deps.newId(), kind: 'estimates', listings }, deadline - now).catch(() => null);
    if (!answer || answer.kind !== 'estimates' || !answer.estimates) return;
    const at = deps.now();
    for (const listing of listings) {
      const cents = answer.estimates[buyOrderListingKey(listing)];
      if (cents !== undefined) estimates.set(estimateKey(listing), { cents, at });
    }
  }

  // ─── One listing ────────────────────────────────────────────────────────────────────────────

  function guardsFor(rule: BuyOrderRule, listing: BuyOrderListing, now: number, tried: boolean, test: boolean): BuyOrderGuardRefusal | null {
    const status = lease?.push.status;
    const steamId = status?.steamId ?? null;
    const real = effectiveSpend(now);
    let spendView = real;
    if (test && real) {
      // Test mode plays its own day: what it would have bought, against its own limits and the account's real spend.
      const counters = testDay(now).rules[rule.id] ?? { items: 0, cents: 0 };
      spendView = { ...real, rules: { ...real.rules, [rule.id]: { cents: counters.cents, items: counters.items } } };
    }
    const balance = steamId ? (deps.accounts.get(platformOf(listing.source), steamId)?.balanceCents ?? null) : null;
    return checkBuyOrderGuards({
      rule,
      accountBudgetCents: snapshot?.dailyBudgetCents ?? null,
      priceCents: listing.priceCents,
      spend: spendView,
      balanceCents: balance,
      failures: test ? 0 : failuresOf(rule),
      running: test || !snapshot ? 0 : (running.get(runningKey(snapshot.clerkId, rule.id)) ?? 0),
      listingTried: !test && tried,
      steamLinked: test || steamId !== null,
      sourceEnabled: test || sourceBuyable(listing.source),
    });
  }

  function decide(listing: BuyOrderListing, now: number): { buys: Array<{ rule: BuyOrderRule }>; tests: BuyOrderRule[]; skips: Array<{ rule: BuyOrderRule; reasons: BuyOrderMismatch[] }> } {
    const estimate = cachedEstimate(listing, now) ?? null;
    const buys: Array<{ rule: BuyOrderRule }> = [];
    const tests: BuyOrderRule[] = [];
    const skips: Array<{ rule: BuyOrderRule; reasons: BuyOrderMismatch[] }> = [];
    for (const rule of enabledRules()) {
      const result = matchBuyOrderRule(rule, listing, { estimateCents: estimate });
      if (result.match) {
        if (rule.mode === 'auto') buys.push({ rule });
        else tests.push(rule);
      } else if (rule.item.trim() && isNearMiss(result) && result.reasons.every((reason) => LOGGED_SKIP_REASONS.has(reason.code))) {
        skips.push({ rule, reasons: result.reasons });
      }
    }
    return { buys, tests, skips };
  }

  async function processListing(entry: MarketFeedListing, listing: BuyOrderListing): Promise<void> {
    const now = deps.now();
    if (runState(now).state !== 'running') return;
    const { buys, tests, skips } = decide(listing, now);
    const key = buyOrderListingKey(listing);
    const tried = buys.length ? await deps.attempted(key).catch(() => true) : false;

    for (const rule of tests) {
      const refusal = guardsFor(rule, listing, deps.now(), false, true);
      if (refusal) {
        record({ kind: 'would_skip', ruleId: rule.id, ruleName: rule.name, listing: activityListing(listing), reason: refusal.code, values: guardActivityValues(refusal) });
        continue;
      }
      const counters = testDay(deps.now()).rules;
      const own = counters[rule.id] ?? { items: 0, cents: 0 };
      counters[rule.id] = { items: own.items + 1, cents: own.cents + listing.priceCents };
      record({ kind: 'would_buy', ruleId: rule.id, ruleName: rule.name, listing: activityListing(listing), reason: null });
    }

    for (const { rule, reasons } of skips) {
      const first = reasons[0];
      if (!first || buys.some((buy) => buy.rule.id === rule.id)) continue;
      record({ kind: 'skipped', ruleId: rule.id, ruleName: rule.name, listing: activityListing(listing), reason: first.code, values: mismatchValues(first) });
    }

    // R-F4: one buy, by the highest rule in the user's order that may buy it.
    for (const { rule } of buys) {
      const refusal = guardsFor(rule, listing, deps.now(), tried, false);
      if (!refusal) {
        await attempt(rule, entry, listing);
        return;
      }
      record({ kind: 'skipped', ruleId: rule.id, ruleName: rule.name, listing: activityListing(listing), reason: refusal.code, values: guardActivityValues(refusal) });
      if (!RULE_GUARDS.has(refusal.code)) return;
    }
  }

  // ─── One automatic attempt ──────────────────────────────────────────────────────────────────

  async function attempt(rule: BuyOrderRule, entry: MarketFeedListing, listing: BuyOrderListing): Promise<void> {
    const status = lease?.push.status;
    const leaseId = status?.lease?.leaseId;
    const steamId = status?.steamId;
    const clerkId = snapshot?.clerkId;
    if (!status || !leaseId || !steamId || !clerkId) return;
    const seenAt = entry.firstSeenAt;
    // R-F7: QTS's own part ends a second after the feed answer that brought the listing.
    const deadline = seenAt + BUY_ORDER_OWN_TIME_MS;
    const attemptId = deps.newId();
    const priceCents = listing.priceCents;
    inFlight.set(attemptId, { ruleId: rule.id, priceCents });
    const ruleKey = runningKey(clerkId, rule.id);
    running.set(ruleKey, (running.get(ruleKey) ?? 0) + 1);

    const journal: Journal = { state: 'pending' };
    const floatValue = listing.floatValue !== null && listing.floatValue >= 0 && listing.floatValue <= 1 ? listing.floatValue : undefined;
    const opened = deps
      .ask(
        recentTabs(deps.now()),
        {
          requestId: deps.newId(),
          kind: 'open',
          open: {
            attemptId,
            source: listing.source,
            listingId: listing.listingId,
            marketHashName: listing.marketHashName.slice(0, 256),
            ...(floatValue !== undefined ? { floatValue } : {}),
            priceCents,
            ruleId: rule.id,
            ...judgedFields(listing),
            deviceId,
            leaseId,
            seenAt,
            sentAt: deps.now(),
          },
        },
        ENGINE_OPEN_TIMEOUT_MS
      )
      .catch(() => null)
      .then((answer) => {
        inFlight.delete(attemptId);
        // An answer about another attempt is no answer about this one: its row may exist, it is settled "not sent".
        if (answer?.kind === 'open' && answer.outcome === 'opened' && answer.response.attemptId === attemptId) {
          journal.state = 'opened';
          takeFigure(answer.response.spend, answer.response.serverNow);
        } else if (answer?.kind === 'open' && answer.outcome === 'refused') {
          journal.state = 'refused';
          journal.code = answer.code;
        } else journal.state = 'failed';
        return journal;
      });

    const beforeSend = async (): Promise<string | null> => {
      // The lease and the stop again, right before the request: Stop all or a lost lease stops an attempt in flight.
      if (runState(deps.now()).state !== 'running') return 'engine_stopped';
      if (journal.state === 'pending') {
        const wait = Math.max(0, deadline - deps.now());
        let waitTimer: unknown = null;
        await Promise.race([opened, new Promise<void>((resolve) => (waitTimer = deps.setTimer(resolve, wait)))]);
        if (waitTimer !== null) deps.clearTimer(waitTimer);
      }
      if (runState(deps.now()).state !== 'running') return 'engine_stopped';
      // Read the state as a value: the narrowing of an earlier check does not survive the await above.
      const state = journal.state as Journal['state'];
      if (state === 'opened') return null;
      if (state === 'refused') return journal.code ?? 'journal_refused';
      if (state === 'failed') return 'journal_unavailable';
      return 'journal_timeout';
    };

    const request: MarketBuyRequest = {
      requestId: deps.newId(),
      attemptId,
      source: listing.source,
      listingId: listing.listingId,
      priceCents,
      origin: { kind: 'buy_order', ruleId: rule.id },
      item: floatValue !== undefined ? { name: listing.marketHashName, float: floatValue } : { name: listing.marketHashName },
      steamId,
    };
    let result: MarketBuyResult;
    try {
      result = await deps.execute(request, { beforeSend });
    } catch {
      // The executor never throws; a fault around it is "not sent" only while the gate kept the request back.
      result = {
        requestId: request.requestId,
        attemptId,
        source: listing.source,
        listingId: listing.listingId,
        priceCents,
        outcome: 'unknown',
        sent: true,
        reason: 'engine_error',
        settledAt: deps.now(),
      };
    }

    // A request that was sent counts in the rule's run at once; the settle goes on behind it.
    if (result.sent) {
      finish(clerkId, rule, listing, result, seenAt, false);
      const settledJournal = journal.state === 'pending' ? await opened : journal;
      if (settledJournal.state !== 'refused' && !(await settleOnce(attemptId, seenAt, result))) queueSettle({ clerkId, attemptId, seenAt, result, activityId: null });
      return;
    }
    // Nothing sent: the row (if the server opened one, whatever its answer said) is settled "not sent". A row that may
    // exist but did not take it runs out as `unknown` on the server, and the activity says "unknown" too, until a later
    // settle gets through.
    running.set(ruleKey, Math.max(0, (running.get(ruleKey) ?? 1) - 1));
    const settledJournal = journal.state === 'pending' ? await opened : journal;
    const confirmed = settledJournal.state === 'refused' || (await settleOnce(attemptId, seenAt, result));
    const activity = finish(clerkId, rule, listing, result, seenAt, !confirmed, false);
    if (!confirmed) queueSettle({ clerkId, attemptId, seenAt, result, activityId: activity.id });
  }

  /** The journal's copy of the result, through a page; true once the server has it. */
  async function settleOnce(attemptId: string, seenAt: number, result: MarketBuyResult): Promise<boolean> {
    const answer = await deps.ask(recentTabs(deps.now()), { requestId: deps.newId(), kind: 'settle', attemptId, seenAt, result }, ENGINE_RELAY_TIMEOUT_MS).catch(() => null);
    return answer?.kind === 'settle' && answer.ok;
  }

  /** A settle that did not get through: kept in storage.local and sent again after SETTLE_RETRY_MS. */
  function queueSettle(entry: Omit<PendingSettle, 'retry' | 'at'>, retry = 0): void {
    const delay = SETTLE_RETRY_MS[retry];
    if (delay === undefined) return;
    memory.settles = [...memory.settles.filter((pending) => pending.attemptId !== entry.attemptId), { ...entry, retry, at: deps.now() + delay }].slice(-SETTLES_KEPT);
    persistSoon();
    // The timer is the fast path; a worker the browser stopped retries at its next tick or start.
    deps.setTimer(() => retrySettles(deps.now()), delay);
  }

  /** Sends every due settle again; one that gets through for a never-sent attempt corrects its "unknown" entry. */
  function retrySettles(now: number): void {
    for (const pending of memory.settles) {
      if (pending.at > now || settling.has(pending.attemptId)) continue;
      settling.add(pending.attemptId);
      void settleOnce(pending.attemptId, pending.seenAt, pending.result)
        .catch(() => false)
        .then((ok) => {
          settling.delete(pending.attemptId);
          memory.settles = memory.settles.filter((entry) => entry.attemptId !== pending.attemptId);
          if (!ok) queueSettle(pending, pending.retry + 1);
          else if (pending.activityId) {
            const entry = accountMemory(pending.clerkId).activity.find((activity) => activity.id === pending.activityId);
            if (entry?.kind === 'unknown' && entry.reason === 'journal_unconfirmed') {
              entry.kind = buyOrderActivityKindOf(pending.result.outcome);
              entry.reason = pending.result.reason ?? null;
            }
          }
          persistSoon();
          return undefined;
        });
    }
  }

  function finish(clerkId: string, rule: BuyOrderRule, listing: BuyOrderListing, result: MarketBuyResult, seenAt: number, unconfirmed: boolean, counted = true): BuyOrderActivity {
    const account = accountMemory(clerkId);
    const remembered = ruleMemory(rule, account);
    if (counted) {
      const ruleKey = runningKey(clerkId, rule.id);
      running.set(ruleKey, Math.max(0, (running.get(ruleKey) ?? 1) - 1));
    }
    // Only a buy request that was sent and refused (or whose result is unknown) is a failure (R-F3).
    const effect = buyOrderFailureEffect(result.outcome, result.sent);
    if (effect === 'success') remembered.failures = 0;
    else if (effect === 'failure') remembered.failures += 1;
    const latencyMs = result.requestedAt !== undefined ? Math.max(0, result.requestedAt - seenAt) : undefined;
    // Nothing was sent, but the journal row may not have taken it: it runs out as `unknown` on the server, so here too.
    const kind = unconfirmed ? 'unknown' : buyOrderActivityKindOf(result.outcome);
    const activity = record(
      {
        kind,
        ruleId: rule.id,
        ruleName: rule.name,
        listing: activityListing(listing),
        reason: unconfirmed ? 'journal_unconfirmed' : (result.reason ?? null),
        outcome: result.outcome,
        attemptId: result.attemptId,
        ...(result.newPriceCents !== undefined ? { values: { newPriceCents: result.newPriceCents } } : result.shortCents !== undefined ? { values: { shortCents: result.shortCents } } : {}),
        ...(latencyMs !== undefined ? { latencyMs } : {}),
      },
      kind === 'bought' || kind === 'unknown',
      clerkId
    );
    if (snapshot?.clerkId === clerkId) syncPauses(deps.now());
    persistSoon();
    return activity;
  }

  // ─── Commands ───────────────────────────────────────────────────────────────────────────────

  function view(requestId?: string): BuyOrdersEngineView {
    const now = deps.now();
    const { state, canBuy } = runState(now);
    const status = lease?.push.status;
    const holderLease = status?.lease && status.lease.deviceId !== deviceId ? status.lease : null;
    const rules: Record<string, BuyOrderRuleRuntime> = {};
    for (const rule of snapshot?.rules ?? []) rules[rule.id] = runtimeOf(rule, now);
    return {
      ...(requestId !== undefined ? { requestId } : {}),
      deviceId,
      state,
      clerkId: snapshot?.clerkId ?? null,
      stoppedHere: memory.stoppedHere !== null,
      canBuy,
      holder: holderLease ? { deviceLabel: holderLease.deviceLabel, renewedAt: holderLease.renewedAt - (lease?.offset ?? 0) } : null,
      leaseUntil: state === 'running' ? (lease?.until ?? null) : null,
      lastFeedAt,
      spend: effectiveSpend(now),
      rules,
      activity: snapshot ? current().activity : [],
      now,
    };
  }

  /** A pushed snapshot of the rules (or the stored one at start). */
  async function setRules(next: BuyOrdersSnapshot | null): Promise<void> {
    await init();
    snapshot = next;
    // Another account's rules: what the engine remembers of each account stays that account's (nothing is reset).
    if (next) accountMemory(next.clerkId);
    persistSoon();
    await settleRunning(deps.now());
  }

  /** The page's `set_buy_orders_lease`, already parsed. */
  async function setLease(push: BuyOrdersLeasePush, tabId: number | undefined): Promise<BuyOrdersEngineView> {
    await init();
    const now = deps.now();
    if (tabId !== undefined && tabId >= 0) tabs.set(tabId, now);
    // An answer older than the one the engine has (a slow renewal) changes nothing.
    if (lease && push.requestedAt < lease.push.requestedAt && push.clerkId === lease.push.clerkId) return view();
    // Another account on the page: nothing it counted is this one's.
    if (lease && lease.push.clerkId !== push.clerkId) {
      spend = null;
      inFlight.clear();
    }
    if (!push.status) {
      // Signed out, the plan lapsed, the server refused: the lease is gone at once.
      lease = null;
    } else {
      const status = push.status;
      lease = {
        push: { ...push, status },
        until: status.lease?.deviceId === deviceId ? localLeaseUntil(status, push.requestedAt) : null,
        offset: serverClockOffset(status.serverNow, push.requestedAt, push.receivedAt),
      };
      takeFigure(status.spend, status.serverNow);
    }
    persistSoon();
    await settleRunning(now);
    return view();
  }

  /** Stop all pressed (`true`) or Start pressed (`false`) in this browser. */
  async function setStopped(stopped: boolean): Promise<BuyOrdersEngineView> {
    await init();
    memory.stoppedHere = stopped ? (memory.stoppedHere ?? deps.now()) : null;
    persistSoon();
    await settleRunning(deps.now());
    return view();
  }

  async function handleListings(rows: readonly MarketFeedRow[]): Promise<void> {
    await init();
    const now = deps.now();
    for (const [key, seen] of handled) if (now - seen > MARKET_FEED_BUFFER_MS + MARKET_FEED_SEEN_GRACE_MS) handled.delete(key);
    if (runState(now).state !== 'running') return;
    const fresh: Array<{ entry: MarketFeedListing; listing: BuyOrderListing }> = [];
    for (const { listing: entry } of rows) {
      if (entry.baseline || entry.goneAt !== null || handled.has(entry.key) || !(MARKET_SOURCES as readonly string[]).includes(entry.source)) continue;
      handled.set(entry.key, now);
      fresh.push({ entry, listing: buyOrderListingFromFeedEntry(entry) });
    }
    if (!fresh.length) return;
    // One estimate request for every listing of this answer whose estimate decides a rule.
    const rules = enabledRules();
    const missing = fresh.filter(({ listing }) => cachedEstimate(listing, now) === undefined && rules.some((rule) => isBuyOrderEstimateCandidate(rule, listing))).map(({ listing }) => listing);
    if (missing.length) await fetchEstimates(missing, Math.min(...fresh.map(({ entry }) => entry.firstSeenAt)) + BUY_ORDER_OWN_TIME_MS);
    await Promise.all(fresh.map(({ entry, listing }) => processListing(entry, listing).catch(() => undefined)));
  }

  /** The feed's new listings (QUICK-231 `onListings`): each new arrival once, never a baseline row. */
  function onListings(rows: readonly MarketFeedRow[], at: number): void {
    lastFeedAt = at;
    void handleListings(rows).catch(() => undefined);
  }

  function tabRemoved(tabId: number): void {
    if (!tabs.delete(tabId)) return;
    // The last page that renewed the lease closed: the engine stops at once instead of waiting for the lease to end.
    if (lease && !recentTabs(deps.now()).length) {
      lease = null;
      persistSoon();
      void settleRunning(deps.now());
    }
  }

  /** Worker start: the lease and the rules from storage. */
  async function resume(rules: BuyOrdersSnapshot | null): Promise<void> {
    await init();
    snapshot = rules;
    // A worker restart is not a new start: the activity says "started" only when the engine was not running.
    wasRunning = runState(deps.now()).state === 'running';
    // Settles whose timers the stopped worker lost.
    retrySettles(deps.now());
    await settleRunning(deps.now());
  }

  return { setRules, setLease, setStopped, onListings, tabRemoved, resume, view, tick, init };
}

export type BuyOrderEngine = ReturnType<typeof createBuyOrderEngine>;
