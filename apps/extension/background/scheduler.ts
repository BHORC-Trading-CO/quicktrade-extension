// apps/extension/background/scheduler.ts
import type {
  BackoffMap,
  ListingCheckResult,
  ListingIdentity,
  ListingIdentityPage,
  ListingPrecondition,
  OperationRefusal,
  RepriceCheckResult,
  RepriceFailureKind,
  RepriceResponse,
  RepriceStep,
  ResolvedSchedulerPolicy,
  ScheduledListingRule,
  ScheduledRule,
  ScheduledSyncRule,
  SchedulerErrorOutcome,
} from '@qts/contracts';
import {
  ASSET_ID_TOKEN,
  batchGroupKey,
  classifyRepriceFailure,
  classifySchedulerError,
  composeBatchBody,
  computeScheduledStep,
  concludeListingIdentity,
  evaluateListingCheck,
  evaluateListingIdentityPage,
  evaluateListingStallPage,
  evaluateRepriceCheck,
  hasRepriceItemError,
  hasRepricePlatformError,
  isArrivalExpired,
  isArrivalListing,
  isJournalOwner,
  isListingOverdue,
  isListingWriteConfirmed,
  isRepriceRuleExpired,
  isRepriceTerminalWriteStatus,
  isRepriceTransientStatus,
  isScheduledListingRule,
  isScheduledSyncRule,
  isSyncFactorsStale,
  listingPreconditionOutcome,
  needsListingAcknowledgement,
  nextRepriceWakeAt,
  operationRefusedError,
  parseRetryAfter,
  planDuePass,
  prepareListingRegistration,
  prepareRepriceRegistration,
  prepareSyncRegistration,
  readSyncReference,
  readSyncRowPrice,
  recordListingAbsent,
  recordListingFailure,
  recordRepriceFailure,
  recordRepriceNotListed,
  recordRepriceSuccess,
  recordSyncSuccess,
  resolveSchedulerPolicy,
  retireListing,
  retireSync,
  scheduledCheckHeaders,
  schedulerBackoffMs,
  SYNC_PRICE_TOLERANCE,
  syncFollowerPrice,
  syncRuleId,
} from '@qts/contracts';

import { MAX_FIRES_PER_PASS, REPRICE_CONTINUE_ALARM } from '@/models/constants';
import { getPlatformCatalog } from '@/shared/platformCatalog';
import { wait } from '@/shared/utils';

import { activeBrowserGate } from './active-browser';
import { noteSchedulerRun, pruneJournal } from './diagnostics-journal';
import { schedulerRunEvent } from './diagnostics-journal-model';
import { isListingBlocked } from './listing-blocks';
import { scheduledRequestRefusal, scheduledRuleRefusal } from './operation-policy';
import { hasPermission } from './permissions';
import { proxyRequest } from './proxy';

const KEY_PREFIX = 'rule:';
const INDEX_KEY = 'rule_index';
const BACKOFF_KEY = 'reprice_backoff';
/** Per-platform consecutive backoff count, persisted next to reprice_backoff so it survives worker restarts. */
const ATTEMPTS_KEY = 'reprice_backoff_attempts';
const PRICE_TOKEN = '__PRICE__';
const REPRICE_CONTINUE_DELAY_MS = 60_000;
/** Login, captcha or site access blocks the whole platform; re-probe it with one read-only check later. */
const BLOCKED_BACKOFF_MS = 30 * 60_000;

let opChain: Promise<unknown> = Promise.resolve();
let passRunning = false;
function runExclusive<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const keyOf = (ruleId: string): string => `${KEY_PREFIX}${ruleId}`;

async function readIndex(): Promise<string[]> {
  const stored = (await browser.storage.local.get(INDEX_KEY)) as Record<string, string[]>;
  return stored[INDEX_KEY] ?? [];
}
async function writeIndex(ids: string[]): Promise<void> {
  await browser.storage.local.set({ [INDEX_KEY]: ids });
}
async function readAll(): Promise<ScheduledRule[]> {
  const ids = await readIndex();
  if (!ids.length) return [];
  const stored = (await browser.storage.local.get(ids.map(keyOf))) as Record<string, ScheduledRule>;
  const out: ScheduledRule[] = [];
  for (const id of ids) {
    const r = stored[keyOf(id)];
    if (r) out.push(r);
  }
  return out;
}
async function readBackoff(): Promise<{ backoff: BackoffMap; attempts: Record<string, number> }> {
  const stored = (await browser.storage.local.get([BACKOFF_KEY, ATTEMPTS_KEY])) as Record<string, Record<string, number>>;
  return { backoff: stored[BACKOFF_KEY] ?? {}, attempts: stored[ATTEMPTS_KEY] ?? {} };
}
async function writeBackoff(map: BackoffMap, attempts: Record<string, number>): Promise<void> {
  await browser.storage.local.set({ [BACKOFF_KEY]: map, [ATTEMPTS_KEY]: attempts });
}

/** All rules (serialized after pending writes). */
export async function getRules(): Promise<ScheduledRule[]> {
  return runExclusive(() => readAll());
}

/** Upsert a scheduled rule + ensure it's in the index. */
export async function registerRule(rule: ScheduledRule | ScheduledListingRule | ScheduledSyncRule): Promise<void> {
  if (!rule.ruleId || !rule.template?.url) {
    throw new Error(`invalid rule: missing required fields (ruleId=${rule.ruleId})`);
  }
  // Runs without a tab: every request it can send must be a schedulable operation of its platform (QUICK-171).
  const refusal = await scheduledRuleRefusal(rule);
  if (refusal) throw new Error(operationRefusedError(refusal));
  await runExclusive(async () => {
    const now = Date.now();
    if (isScheduledListingRule(rule)) {
      const existing = (await browser.storage.local.get(keyOf(rule.ruleId)))[keyOf(rule.ruleId)] as ScheduledRule | undefined;
      // Duplicate/stale bridge delivery must never reset a fired, paused or running one-shot.
      if (existing && existing.createdAt >= rule.createdAt) return;
      // A listing that may have been sent, or was sent, is replaced only after the user confirmed it (a second
      // tab or a stale form never does). A refusal is silent: the web's read-back reports it as unconfirmed.
      if (existing && needsListingAcknowledgement(existing) && rule.replaceAcknowledged !== true) return;
    }
    if (isScheduledSyncRule(rule)) {
      // The pair's auto-reprice ramp sets its price (QUICK-296): a follower would undo each of its steps. Refused
      // silently, as a kept one-shot is: the web's read-back shows no follower.
      const rampKey = keyOf(`${rule.itemId}:${rule.platform}`);
      const ramp = (await browser.storage.local.get(rampKey))[rampKey] as ScheduledRule | undefined;
      if (ramp && !ramp.retiredReason) return;
    }
    const prepared = isScheduledListingRule(rule) ? prepareListingRegistration(rule, now) : isScheduledSyncRule(rule) ? prepareSyncRegistration(rule, now) : prepareRepriceRegistration(rule, now);
    // The account it belongs to (QUICK-214): kept only as a Clerk user id, or the rule is not journaled. The same rule
    // delivered again (a resume, a check upgrade, a stale tab: same `createdAt`) keeps the owner it was stored with; a
    // new rule for the pair belongs to whoever registered it.
    const current = (await browser.storage.local.get(keyOf(rule.ruleId)))[keyOf(rule.ruleId)] as ScheduledRule | undefined;
    const { owner: incoming, ...rest } = prepared;
    const owner = current && current.createdAt === rule.createdAt && isJournalOwner(current.owner) ? current.owner : incoming;
    const stored = isJournalOwner(owner) ? { ...rest, owner } : rest;
    await browser.storage.local.set({ [keyOf(rule.ruleId)]: stored });
    // An accepted one-shot ends the pair's auto-reprice ramp in the same step: left alone, the ramp's next
    // step would overwrite the fixed price once the item is listed. An accepted ramp ends the pair's price follower
    // (QUICK-296): the ramp's planned prices win over following the reference.
    const displacedId = isScheduledListingRule(rule) ? `${rule.itemId}:${rule.platform}` : isScheduledSyncRule(rule) ? undefined : syncRuleId(rule.itemId, rule.platform);
    if (displacedId) await browser.storage.local.remove(keyOf(displacedId));
    const ids = await readIndex();
    const next = [...ids.filter((id) => id !== displacedId), ...(ids.includes(rule.ruleId) ? [] : [rule.ruleId])];
    if (next.length !== ids.length || next.some((id, index) => id !== ids[index])) await writeIndex(next);
    // An activation, Resume or auto-resume with a step already due catches up soon, not at the next tick.
    scheduleContinuation(false, await readAll(), (await readBackoff()).backoff);
  });
}

/**
 * Cancel any kind by its exact, namespaced ruleId: remove key + drop from index. Cancelling a pair's
 * reprice rule `${itemId}:${platform}` (every web version does that on "Add for sale" and on a delist) also
 * cancels the pair's one-shot `list:${itemId}:${platform}`, which would otherwise list the item again, and its
 * price follower `sync:${itemId}:${platform}` (QUICK-296), which would otherwise change the new listing's price.
 */
export async function cancelRule(id: string): Promise<void> {
  return runExclusive(async () => {
    const cancelled = id.startsWith('list:') || id.startsWith('sync:') ? [id] : [id, `list:${id}`, `sync:${id}`];
    for (const ruleId of cancelled) await browser.storage.local.remove(keyOf(ruleId));
    const ids = await readIndex();
    if (ids.some((x) => cancelled.includes(x))) await writeIndex(ids.filter((x) => !cancelled.includes(x)));
  });
}

/**
 * Reconcile the index with the actual `rule:*` keys on startup. Self-healing: adds orphan rules
 * created by pre-index builds (or any path that missed the index) and drops stale entries whose
 * key was removed — so a stale/empty index can't hide existing rules from getRules/list_rules.
 * Also activates checked rules that the safety-aware web registered while an older extension was
 * installed (stored verbatim as `extension_update_required`): every write is now gated by their check.
 * startAt/lastAppliedDay are kept, so the first pass applies the normal one-step catch-up.
 */
export async function ensureIndex(): Promise<void> {
  return runExclusive(async () => {
    const all = await browser.storage.local.get(null);
    const scanned: string[] = [];
    const activated: Record<string, ScheduledRule> = {};
    const now = Date.now();
    for (const k of Object.keys(all)) {
      if (!k.startsWith(KEY_PREFIX)) continue;
      scanned.push(k.slice(KEY_PREFIX.length));
      const rule = all[k] as ScheduledRule | undefined;
      if (rule && !isScheduledListingRule(rule) && !isScheduledSyncRule(rule) && rule.pausedReason === 'extension_update_required' && rule.template?.checkTemplate) {
        try {
          activated[k] = prepareRepriceRegistration({ ...rule, activationRequested: true }, now);
        } catch {
          // A stored rule this build refuses (a malformed `schedule`) stays paused; the index is still repaired.
        }
      }
    }
    if (Object.keys(activated).length) await browser.storage.local.set(activated);
    const current = (all[INDEX_KEY] as string[] | undefined) ?? [];
    const same = current.length === scanned.length && current.every((id) => scanned.includes(id));
    if (!same) await writeIndex(scanned);
  });
}

/** `text` (the body, or its batch item) with the run's tokens: today's price, or the asset id an identity scan resolved. */
function fillTokens(rule: ScheduledRule, text: string, step: RepriceStep, writeId: string | undefined): string {
  if (isScheduledListingRule(rule)) return writeId ? text.split(ASSET_ID_TOKEN).join(writeId) : text;
  // A follower's placeholder step (QUICK-296) is replaced by its reference price before any write; never write NaN.
  if (!Number.isFinite(step.targetPrice)) throw new Error('invalid_price');
  const value = rule.template.priceInCents ? Math.round(step.targetPrice * 100) : step.targetPrice;
  return text.replace(PRICE_TOKEN, String(value));
}

/**
 * Each platform's scheduler policy for the running pass (QUICK-289): the catalog's `scheduler` entry clamped to this
 * build's bounds, read once when the pass starts. A platform without one keeps the build's defaults.
 */
let passPolicies = new Map<string, ResolvedSchedulerPolicy>();
const DEFAULT_POLICY = resolveSchedulerPolicy(undefined);

function policyOf(platform: string): ResolvedSchedulerPolicy {
  return passPolicies.get(platform) ?? DEFAULT_POLICY;
}

function gapMs(platform: string): number {
  return policyOf(platform).gapMs;
}

async function loadPassPolicies(): Promise<void> {
  const policies = new Map<string, ResolvedSchedulerPolicy>();
  try {
    for (const entry of await getPlatformCatalog()) if (entry.scheduler) policies.set(entry.id, resolveSchedulerPolicy(entry.scheduler));
  } catch {
    // An unreadable catalog leaves every platform on the defaults.
  }
  passPolicies = policies;
}

function expBackoff(attempts: Record<string, number>, platform: string): number {
  const n = (attempts[platform] ?? 0) + 1;
  attempts[platform] = n;
  return schedulerBackoffMs(policyOf(platform), n);
}

/**
 * Content, not key order: Chrome returns stored objects with sorted keys (and without undefined values),
 * while a rule built in memory (the pre-write reservation) keeps insertion order.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner
  );
}

/** Compare under the storage lock: an in-flight check must not revive a cancelled/replaced rule. */
async function isCurrent(rule: ScheduledRule): Promise<boolean> {
  const stored = (await browser.storage.local.get(keyOf(rule.ruleId)))[keyOf(rule.ruleId)];
  return stored !== undefined && canonicalJson(stored) === canonicalJson(rule);
}

/** A run that stopped at its check (or before any request): journaled as such. */
const CHECK_RUN = { stage: 'check' } as const;

/**
 * Stores a run's result. With `journal`, the run also goes to the extension's journal (QUICK-214) for the rule's owner:
 * what changed between `before` (the rule as the run found it; by default `rule`) and `updated`.
 */
async function persistResult(rule: ScheduledRule, updated: ScheduledRule | null, journal?: { stage: 'check' | 'write'; before?: ScheduledRule }): Promise<void> {
  const stored = await runExclusive(async () => {
    if (!(await isCurrent(rule))) return false;
    if (updated) {
      await browser.storage.local.set({ [keyOf(rule.ruleId)]: updated });
    } else {
      await browser.storage.local.remove(keyOf(rule.ruleId));
      const ids = await readIndex();
      if (ids.includes(rule.ruleId)) await writeIndex(ids.filter((x) => x !== rule.ruleId));
    }
    return true;
  });
  if (stored && journal) {
    const before = journal.before ?? rule;
    // Not awaited: the journal never delays the next rule or the pass.
    void noteSchedulerRun(before.owner, schedulerRunEvent(before, updated, journal.stage));
  }
}

/** A stored template's request is not an allowlisted scheduled operation: nothing is sent, the rule pauses. */
class OperationRefusedError extends Error {
  constructor(readonly refusal: OperationRefusal) {
    super(operationRefusedError(refusal));
  }
}

type ScheduledRequest = Omit<Parameters<typeof proxyRequest>[1], 'platform' | 'purpose'>;

/**
 * Throws OperationRefusedError unless the request may be sent now (checked at fire time, QUICK-171). `platform` is the
 * rule's own unless the request is a precondition read of another marketplace.
 */
async function assertScheduledRequest(rule: ScheduledRule, stage: 'check' | 'write', url: string, options: ScheduledRequest, platform = rule.platform): Promise<void> {
  const refusal = await scheduledRequestRefusal(platform, { url, method: options.method ?? 'GET', headers: options.headers, body: options.body }, stage);
  if (refusal) throw new OperationRefusedError(refusal);
}

/** Requests sent to each platform by this worker: a rule that sent none needs no gap before the next one's. */
const requestsSent = new Map<string, number>();

function sentTo(platform: string): number {
  return requestsSent.get(platform) ?? 0;
}

/** Only thrown requests are transport failures; local template errors must remain bounded. */
async function requestReprice(rule: ScheduledRule, stage: 'check' | 'write', url: string, options: ScheduledRequest, platform = rule.platform): Promise<RepriceResponse> {
  await assertScheduledRequest(rule, stage, url, options, platform);
  requestsSent.set(platform, sentTo(platform) + 1);
  try {
    return await proxyRequest(url, { ...options, platform, purpose: stage === 'write' ? 'schedule-write' : 'schedule-check' });
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** Per-pass cache of successful check GETs, keyed by the exact request: rules sharing a paged read reuse it. */
type CheckCache = Map<string, RepriceResponse>;

interface Reconciled {
  response: RepriceResponse;
  result: RepriceCheckResult | ListingCheckResult;
  /** Page that decided the result. */
  page: number;
  /** The deciding page came from this pass's cache, not from a request made for this rule. */
  cached: boolean;
  /** A request was sent for this rule (the next one must keep the platform gap). */
  requested: boolean;
  /** The current Steam asset id an identity scan resolved (re-issued ids included). */
  assetId?: string;
}

async function reconcile(rule: ScheduledRule, cache: CheckCache, fromPage = 0, fresh = false): Promise<Reconciled> {
  const check = rule.template.checkTemplate;
  if (!check || check.request.method !== 'GET') throw new Error('invalid_check');
  // Bound work even for a malformed/future web template. A cap is uncertainty, never absence.
  const maxPages = Math.max(1, Math.min(30, check.pagination?.maxPages ?? 1));
  let response: RepriceResponse = { ok: false, status: 0, data: null };
  let result: RepriceCheckResult | ListingCheckResult = { outcome: 'unknown', reason: 'invalid_check' };
  let cached = false;
  let requested = false;
  let page = fromPage;
  // Pages before `fromPage` were full pages of other rows; an empty scan is never proof of absence.
  let rowsSeen = fromPage * check.matcher.pageSize;
  for (; page < maxPages; page++) {
    if (!(await runExclusive(() => isCurrent(rule)))) return { response, result: { outcome: 'unknown', reason: 'rule_changed' }, page, cached, requested };
    const url = new URL(check.request.url);
    if (check.pagination) url.searchParams.set(check.pagination.offsetParam, String(page * check.matcher.pageSize));
    const request = { ...check.request, headers: scheduledCheckHeaders(check.request.headers) };
    const key = JSON.stringify([url.toString(), request]);
    const hit = fresh ? undefined : cache.get(key);
    cached = hit !== undefined;
    if (hit) {
      response = hit;
    } else {
      if (requested) await wait(gapMs(rule.platform));
      response = await requestReprice(rule, 'check', url.toString(), request);
      requested = true;
      if (response.ok && response.status >= 200 && response.status < 300) cache.set(key, response);
    }
    result = isScheduledListingRule(rule) ? evaluateListingCheck(check, response, rowsSeen) : evaluateRepriceCheck(check, response, rowsSeen);
    rowsSeen += result.rowCount ?? 0;
    if (!result.hasMore || !check.pagination) break;
  }
  return { response, result, page: Math.min(page, maxPages - 1), cached, requested };
}

/**
 * A one-shot for an item that was trade-protected when scheduled: Steam may have re-issued its asset id, so
 * the whole inventory is read fresh and the item found by its identity. Every page is read, because a
 * second copy on a later page makes the identity ambiguous; a cap or any doubtful page concludes nothing.
 */
async function reconcileIdentity(rule: ScheduledListingRule, identity: ListingIdentity, scans: CheckCache): Promise<Reconciled> {
  const check = rule.template.checkTemplate;
  if (check.request.method !== 'GET') throw new Error('invalid_check');
  const maxPages = Math.max(1, Math.min(30, check.pagination?.maxPages ?? 1));
  const matches: ListingIdentityPage['matches'] = [];
  let rowsSeen = 0;
  let requested = false;
  let response: RepriceResponse = { ok: false, status: 0, data: null };
  for (let page = 0; page < maxPages; page++) {
    if (!(await runExclusive(() => isCurrent(rule)))) return { response, result: { outcome: 'unknown', reason: 'rule_changed' }, page, cached: false, requested };
    const url = new URL(check.request.url);
    if (check.pagination) url.searchParams.set(check.pagination.offsetParam, String(page * check.matcher.pageSize));
    const request = { ...check.request, headers: scheduledCheckHeaders(check.request.headers) };
    // Pages read by another identity rule since this platform's last write are shared (QUICK-289): every rule
    // still sees the whole inventory, read fresh in this pass, and a write clears them.
    const key = JSON.stringify([url.toString(), request]);
    const hit = scans.get(key);
    if (hit) {
      response = hit;
    } else {
      if (requested) await wait(gapMs(rule.platform));
      response = await requestReprice(rule, 'check', url.toString(), request);
      requested = true;
      if (response.ok && response.status >= 200 && response.status < 300) scans.set(key, response);
    }
    const read = evaluateListingIdentityPage(check, identity, response);
    const base = { response, page, cached: false, requested };
    if (read.failure) return { ...base, result: read.failure };
    matches.push(...read.matches);
    rowsSeen += read.rowCount;
    if (read.full && !check.pagination) return { ...base, result: { outcome: 'unknown', reason: 'partial_check_response' } };
    if (!read.full) return { ...base, ...concludeListingIdentity(check, matches, rowsSeen) };
  }
  return { response, result: { outcome: 'unknown', reason: 'identity_scan_incomplete' }, page: maxPages - 1, cached: false, requested };
}

/**
 * CSFloat-style cursor stall: only a complete fresh read can authorize a create (or, as a precondition, prove a lot
 * gone). With `shared`, pages another rule read into it are reused (the stall is one request for every rule; only the
 * row each looks for differs): a rule whose write waits for its batch, which reads the stall again before the write.
 */
async function reconcileListingStall(rule: ScheduledListingRule, check = rule.template.stallCheck, platform = rule.platform, shared?: CheckCache): Promise<Reconciled> {
  if (!check || check.request.method !== 'GET') throw new Error('invalid_check');
  const cursors = new Set<string>();
  const rowIds = new Set<string>();
  let seen = 0;
  let total: number | undefined;
  let cursor: string | undefined;
  let cached = false;
  let requested = false;
  for (let page = 0; page < Math.min(100, check.cursor.maxPages); page++) {
    const url = new URL(check.request.url);
    if (cursor) url.searchParams.set(check.cursor.param, cursor);
    const request = { ...check.request, headers: scheduledCheckHeaders(check.request.headers) };
    const key = JSON.stringify([platform, url.toString(), request]);
    const hit = shared?.get(key);
    if (!hit) await wait(gapMs(platform));
    if (!(await runExclusive(() => isCurrent(rule)))) throw new Error('rule_changed');
    let response: RepriceResponse;
    if (hit) {
      response = hit;
      cached = true;
    } else {
      response = await requestReprice(rule, 'check', url.toString(), request, platform);
      requested = true;
      if (shared && response.ok && response.status >= 200 && response.status < 300) shared.set(key, response);
    }
    const parsed = evaluateListingStallPage(check, response, seen, total);
    const reconciled = { response, result: parsed.result, page, cached, requested };
    for (const id of parsed.rowIds ?? []) {
      if (rowIds.has(id)) return { ...reconciled, result: { outcome: 'unknown', reason: 'repeated_stall_row' } };
      rowIds.add(id);
    }
    if (!parsed.result.hasMore) return reconciled;
    if (!parsed.cursor || cursors.has(parsed.cursor)) return { ...reconciled, result: { outcome: 'unknown', reason: 'repeated_stall_cursor' } };
    cursors.add(parsed.cursor);
    cursor = parsed.cursor;
    total = parsed.total;
    seen += parsed.result.rowCount ?? 0;
  }
  return { response: { ok: true, status: 200, data: null }, result: { outcome: 'unknown', reason: 'stall_page_cap' }, page: 0, cached, requested };
}

/** Continue after a cap soon; otherwise only when the earliest waiting rule or platform backoff allows. */
function scheduleContinuation(capped: boolean, rules: ScheduledRule[], backoff: BackoffMap): void {
  const now = Date.now();
  const wake = capped ? now : nextRepriceWakeAt(rules, now, backoff);
  if (wake === null) return;
  browser.alarms.create(REPRICE_CONTINUE_ALARM, { when: Math.max(now + REPRICE_CONTINUE_DELAY_MS, wake) });
}

/** What a pass knows about one platform while it runs that platform's rules. */
interface PlatformRun {
  platform: string;
  policy: ResolvedSchedulerPolicy;
  attempts: Record<string, number>;
  freshBackoff: BackoffMap;
  /** The pass's shared check reads (every platform). */
  cache: CheckCache;
  /**
   * Identity-scan pages read since this platform's last write (QUICK-289), and the stall pages of one-shots whose
   * write waits for a batch: both say what this platform lists, which its own writes change.
   */
  scans: CheckCache;
  /**
   * Another platform's precondition pages (a held cs.money one-shot's CSFloat stall) read in this pass by one-shots
   * whose write waits for a batch. Never cleared by this platform's writes: the batch reads them again before writing.
   */
  preconditions: CheckCache;
  /** A write that succeeded in this pass proves the platform accepts writes (see F1 in recordRepriceFailure). */
  writeSucceeded: boolean;
  /** Items one batched write may carry for the rest of the pass: the policy's, halved by a `halveBatch` refusal. */
  batchLimit: number;
}

/** A rule whose checks allowed its write: sent alone, or kept for a batch (QUICK-289). */
interface ReadyWrite {
  rule: ScheduledRule;
  /** The rule as this run found it (before a one-shot's reservation), for the journal's comparison. */
  found: ScheduledRule;
  step: RepriceStep;
  writeId?: string;
  checkedStatus: RepriceCheckResult['observedStatus'];
  write: ScheduledRequest;
  /** The batch it may join and its item there, both with the run's tokens replaced. */
  batch?: { group: string; item: string };
  /** Page of its check that decided the write. */
  page: number;
}

/** What a failure asks of the platform for the rest of the pass. */
type PlatformStop = 'backoff' | 'blocked';

function applyStop(run: PlatformRun, stop: PlatformStop, response: RepriceResponse): void {
  const ms = stop === 'blocked' ? BLOCKED_BACKOFF_MS : (parseRetryAfter(response.headers, Date.now()) ?? expBackoff(run.attempts, run.platform));
  run.freshBackoff[run.platform] = Date.now() + ms;
}

/** How each outcome of a platform's error map is recorded on the rule and what it asks of the platform (QUICK-289). */
const MAPPED_FAILURES: Readonly<Record<SchedulerErrorOutcome, { kind: RepriceFailureKind; stop: PlatformStop | null }>> = {
  transient: { kind: 'transient', stop: 'backoff' },
  item: { kind: 'counted', stop: null },
  auth: { kind: 'blocked', stop: 'blocked' },
  stop: { kind: 'counted', stop: 'backoff' },
};

/**
 * How a failed read of `platform` made for a rule of another one (a precondition lot, a follower's reference) is
 * recorded on the rule: by that platform's error map when it names the answer, else by its status.
 */
function foreignReadFailureKind(platform: string, response: RepriceResponse, transient: boolean): RepriceFailureKind {
  if (transient) return 'transient';
  const mapped = classifySchedulerError(policyOf(platform).errors, 'check', response.status, response.data);
  return mapped ? MAPPED_FAILURES[mapped.outcome].kind : classifyRepriceFailure(response.status);
}


async function readPrecondition(rule: ScheduledListingRule, precondition: ListingPrecondition, shared?: CheckCache): Promise<{ live: Reconciled; outcome: 'met' | 'unmet' | 'unknown' }> {
  let live = await reconcileListingStall(rule, precondition.liveCheck, precondition.platform, shared);
  let outcome = listingPreconditionOutcome(live.result);
  if (outcome === 'unmet' && live.cached) {
    const requested = live.requested;
    live = await reconcileListingStall(rule, precondition.liveCheck, precondition.platform);
    live = { ...live, requested: live.requested || requested };
    outcome = listingPreconditionOutcome(live.result);
  }
  return { live, outcome };
}

/**
 * Records a failed run of `rule` and says whether the platform stops for this pass. `provenItemSpecific` is false for
 * the outcome of a whole batch: a refusal of many items at once is never proof against one of them. A status the
 * platform's error map names (QUICK-289 PR 2) is read by the map instead of the built-in status rules.
 */
async function recordFailure(
  run: PlatformRun,
  rule: ScheduledRule,
  found: ScheduledRule,
  stage: 'check' | 'write',
  response: RepriceResponse,
  message: string,
  transient: boolean,
  checkedStatus: RepriceCheckResult['observedStatus'],
  provenItemSpecific = run.writeSucceeded
): Promise<PlatformStop | null> {
  const mapped = transient ? null : classifySchedulerError(run.policy.errors, stage, response.status, response.data);
  const kind = mapped ? MAPPED_FAILURES[mapped.outcome].kind : transient ? 'transient' : classifyRepriceFailure(response.status);
  // A platform-wide refusal is never evidence against this item.
  const itemSpecific = mapped?.outcome === 'stop' ? false : provenItemSpecific;
  // Only a write the marketplace answered as rejected (4xx, or a 2xx carrying a declared or item error)
  // is re-armed for a retry behind a fresh check. A lost response, timeout, rate limit or server error
  // may have been applied, as executeSale treats them, and a fresh read can lag a just-created
  // listing: the reservation stays paused as listing_outcome_unknown.
  const retryable = isScheduledListingRule(rule) && stage === 'write' && !isRepriceTransientStatus(response.status) ? { ...rule, active: true, pausedReason: undefined, pausedAt: undefined } : rule;
  await persistResult(
    rule,
    {
      ...(isScheduledListingRule(rule)
        ? recordListingFailure(retryable, response.status, message, Date.now(), kind, stage)
        : recordRepriceFailure(rule, response.status, message, Date.now(), kind, stage, itemSpecific)),
      lastCheckStatus: checkedStatus,
    },
    { stage, before: found }
  );
  if (mapped) return MAPPED_FAILURES[mapped.outcome].stop;
  // A 4xx on a shared (whole-inventory) read says nothing about this item but likely hits every rule on it.
  const sharedRead = stage === 'check' && !rule.template.checkTemplate?.matcher.single;
  const sharedReadRejected = kind === 'counted' && sharedRead && response.status >= 400 && response.status < 500;
  // A terminal write status may be a platform-wide glitch: one strike, and the platform stops for this pass.
  const terminalWrite = kind === 'counted' && stage === 'write' && isRepriceTerminalWriteStatus(response.status);
  if (kind === 'transient' || sharedReadRejected || terminalWrite) return 'backoff';
  if (kind === 'blocked') return 'blocked';
  return null;
}

/** A template the extension refuses (or cannot fill) pauses or fails its rule without a request. */
async function recordTemplateError(rule: ScheduledRule, found: ScheduledRule, stage: 'check' | 'write', error: unknown): Promise<void> {
  if (error instanceof OperationRefusedError) {
    // Not a marketplace failure: the extension refuses this template, so it waits for the user.
    await persistResult(rule, { ...rule, active: false, pausedReason: 'operation_not_allowed', pausedAt: Date.now(), lastMessage: error.message }, { stage, before: found });
    return;
  }
  await persistResult(
    rule,
    (isScheduledListingRule(rule) ? recordListingFailure : recordRepriceFailure)(rule, undefined, isScheduledListingRule(rule) ? 'invalid_listing_template' : 'invalid_reprice_template', Date.now()),
    { stage, before: found }
  );
}

/**
 * The rule as it may be written: a one-shot is first stored as `listing_outcome_unknown`, so a worker killed after
 * sending cannot repeat an uncertain write. Null when the rule changed or was cancelled meanwhile, or when its item
 * was sold on another marketplace (QUICK-217: the one-shot waits a minute, unwritten).
 */
async function reserveWrite(ready: Pick<ReadyWrite, 'rule' | 'writeId'>): Promise<ScheduledRule | null> {
  const { rule } = ready;
  if (!isScheduledListingRule(rule)) return (await runExclusive(() => isCurrent(rule))) ? rule : null;
  if (!(await runExclusive(() => isCurrent(rule)))) return null;
  if (await isListingBlocked(rule, ready.writeId)) {
    await persistResult(rule, { ...rule, nextAttemptAt: Date.now() + 60_000, lastMessage: 'sold_elsewhere' }, CHECK_RUN);
    return null;
  }
  const pending = { ...rule, active: false, pausedReason: 'listing_outcome_unknown' as const, pausedAt: Date.now(), pendingNotListedAt: undefined };
  const reserved = await runExclusive(async () => {
    if (!(await isCurrent(rule))) return false;
    await browser.storage.local.set({ [keyOf(rule.ruleId)]: pending });
    return true;
  });
  return reserved ? pending : null;
}

/** Settles one (reserved) rule by the answer to a write that carried it. */
async function settleWrite(run: PlatformRun, ready: ReadyWrite, rule: ScheduledRule, response: RepriceResponse, provenItemSpecific = run.writeSucceeded): Promise<PlatformStop | null> {
  const { found, step, writeId, checkedStatus } = ready;
  // A 2xx carrying a declared platform error, or rejecting this item, did not apply: never success, never the final delete.
  const is2xx = response.ok && response.status >= 200 && response.status < 300;
  const platformError = hasRepricePlatformError(rule.template.platformError, response.data);
  const itemErrors = writeId && rule.template.itemErrors ? { ...rule.template.itemErrors, id: writeId } : rule.template.itemErrors;
  const itemRejected = is2xx && !platformError && hasRepriceItemError(itemErrors, response.data);
  if (is2xx && !platformError && !itemRejected && isScheduledListingRule(rule) && !isListingWriteConfirmed(rule.template, response.data)) {
    // A 2xx without the created listing in its body (an HTML page, an empty body, no CSFloat id) may
    // or may not have applied: the reservation stays paused for the user to check.
    await persistResult(rule, { ...rule, lastStatus: response.status, lastMessage: 'listing_unconfirmed' }, { stage: 'write', before: found });
    return null;
  }
  if (is2xx && !platformError && !itemRejected) {
    run.attempts[run.platform] = 0;
    run.writeSucceeded = true;
    await persistResult(
      rule,
      isScheduledListingRule(rule)
        ? retireListing(rule, 'listed', Date.now())
        : isScheduledSyncRule(rule)
          ? { ...recordSyncSuccess(rule, step.targetPrice, Date.now(), true), lastCheckStatus: checkedStatus }
          : step.final
            ? null
            : { ...recordRepriceSuccess(rule, step.dayIndex), lastCheckStatus: checkedStatus },
      { stage: 'write', before: found }
    );
    return null;
  }
  const message = platformError ? 'step_platform_error' : itemRejected ? 'step_item_rejected' : 'step_http_error';
  return recordFailure(run, rule, found, 'write', response, message, platformError, checkedStatus, provenItemSpecific);
}

/** Sends one rule's own write, right after a gap. True when the platform stops for this pass. */
async function writeAlone(run: PlatformRun, ready: ReadyWrite): Promise<boolean> {
  let rule = ready.rule;
  try {
    await wait(run.policy.gapMs);
    // QUICK-305: the lease may have gone to another browser during the pass; its rules are then that browser's to write.
    if (!(await activeBrowserGate())(rule)) return true;
    const reserved = await reserveWrite(ready);
    if (!reserved) return false;
    rule = reserved;
    const response = await requestReprice(rule, 'write', rule.template.url, ready.write);
    run.scans.clear();
    const stop = await settleWrite(run, ready, rule, response);
    if (stop) applyStop(run, stop, response);
    return stop !== null;
  } catch (error) {
    await recordTemplateError(rule, ready.found, 'write', error);
    return false;
  }
}

/**
 * Whether a batched rule may still be written, by reads made right before the batch (`fresh`: reads of this flush
 * only, shared by its rules). Its checks may be a whole batch old, and cs.money's write lists an item it would only
 * have repriced. A one-shot's stall and precondition lot are read again too: what its own run read decided only that
 * it could join the batch. A lot that is gone now retires the one-shot; any other doubt leaves it out unrecorded,
 * for the next pass to check from the start. The lot can still sell between this read and the write (a gap and the
 * reservation, as for a one-shot written alone right after its own read): the web's sold-elsewhere take-down covers it.
 */
async function stillReady(ready: ReadyWrite, fresh: CheckCache): Promise<{ ok: boolean; requested: boolean }> {
  const { rule } = ready;
  const identity = isScheduledListingRule(rule) ? rule.template.identity : undefined;
  const checked = isScheduledListingRule(rule) && identity ? await reconcileIdentity(rule, identity, fresh) : await reconcile(rule, fresh, isScheduledListingRule(rule) ? 0 : ready.page);
  let requested = checked.requested;
  if (!isScheduledListingRule(rule)) return { ok: checked.result.outcome === 'listed', requested };
  if (checked.result.outcome !== 'ready' || (identity && checked.assetId !== ready.writeId)) return { ok: false, requested };
  const stall = rule.template.stallCheck;
  if (stall) {
    const stalled = await reconcileListingStall(rule, ready.writeId ? { ...stall, matcher: { ...stall.matcher, id: ready.writeId } } : stall, rule.platform, fresh);
    requested ||= stalled.requested;
    if (stalled.result.outcome !== 'ready') return { ok: false, requested };
  }
  const { precondition } = rule.template;
  if (!precondition) return { ok: true, requested };
  const { live, outcome } = await readPrecondition(rule, precondition, fresh);
  requested ||= live.requested;
  if (outcome === 'unmet') await persistResult(rule, retireListing(rule, 'required_lot_gone', Date.now()), CHECK_RUN);
  return { ok: outcome === 'met', requested };
}

/**
 * Whether a refused batch is retried item by item: what the platform's error map says (only an `item` refusal is
 * about the items), else any definitive refusal of the whole write (not auth, not a timeout or rate limit).
 */
function isolatesBatch(run: PlatformRun, response: RepriceResponse): boolean {
  const mapped = classifySchedulerError(run.policy.errors, 'write', response.status, response.data);
  if (mapped) return mapped.outcome === 'item';
  return response.status >= 400 && response.status < 500 && ![401, 403, 408, 429].includes(response.status);
}

/** A reserved rule of a batch and the ready write it came from. */
interface ReservedWrite {
  entry: ReadyWrite;
  rule: ScheduledRule;
}

/**
 * Writes a group of ready rules as one request (QUICK-289): re-read right before, reserved, sent, and each rule settled
 * by the answer. A refused batch is retried item by item, as executeSale isolates a rejected publish, until two items
 * in a row repeat the batch's refusal (an account-level one) or the platform stops; the rest keep the batch's answer.
 * A refusal the platform's error map marks `halveBatch` (cs.money 134: too many items) sends it again as two halves.
 */
async function writeBatch(run: PlatformRun, entries: ReadyWrite[]): Promise<boolean> {
  const fresh: CheckCache = new Map();
  const ready: ReadyWrite[] = [];
  let requested = false;
  for (const entry of entries) {
    try {
      if (requested) await wait(run.policy.gapMs);
      const verdict = await stillReady(entry, fresh);
      requested = verdict.requested;
      // Not ready any more: nothing is recorded, the next pass checks it from the start.
      if (verdict.ok) ready.push(entry);
    } catch (error) {
      await recordTemplateError(entry.rule, entry.found, 'check', error);
    }
  }
  if (ready.length <= 1) return ready.length ? writeAlone(run, ready[0]) : false;

  const [first] = ready;
  try {
    await assertScheduledRequest(first.rule, 'write', first.rule.template.url, batchRequest(first, ready));
  } catch (error) {
    if (!(error instanceof OperationRefusedError)) throw error;
    // The batched body is no allowed write: every rule goes alone, as an older extension sends it.
    for (const entry of ready) if (await writeAlone(run, entry)) return true;
    return false;
  }

  await wait(run.policy.gapMs);
  const gate = await activeBrowserGate();
  if (!ready.every((entry) => gate(entry.rule))) return true;
  const reserved: ReservedWrite[] = [];
  for (const entry of ready) {
    const rule = await reserveWrite(entry);
    if (rule) reserved.push({ entry, rule });
  }
  if (!reserved.length) return false;
  return sendBatch(run, first, reserved);
}

/** The batched write carrying `items`, in the shape of the group's first write (one template for the whole group). */
function batchRequest(first: ReadyWrite, items: readonly ReadyWrite[]): ScheduledRequest {
  const wrapper = first.rule.template.batch?.wrapper ?? '';
  return {
    ...first.write,
    body: composeBatchBody(
      wrapper,
      items.map((entry) => entry.batch?.item ?? '')
    ),
  };
}

/** Sends reserved rules as one write and settles each. True when the platform stops for this pass. */
async function sendBatch(run: PlatformRun, first: ReadyWrite, reserved: ReservedWrite[]): Promise<boolean> {
  // A group gathered before this pass halved its limit goes in writes of the new size.
  const limit = run.batchLimit;
  if (reserved.length > limit) {
    for (let start = 0; start < reserved.length; start += limit) {
      if (start > 0) await wait(run.policy.gapMs);
      if (await sendBatch(run, first, reserved.slice(start, start + limit))) return true;
    }
    return false;
  }
  let response: RepriceResponse;
  try {
    response = await requestReprice(
      reserved[0].rule,
      'write',
      first.rule.template.url,
      batchRequest(
        first,
        reserved.map(({ entry }) => entry)
      )
    );
  } catch (error) {
    // Refused at fire time: nothing was sent, so no reservation may stay as an uncertain write.
    for (const { entry, rule } of reserved) await recordTemplateError(rule, entry.found, 'write', error);
    return false;
  }
  run.scans.clear();

  if (reserved.length > 1 && classifySchedulerError(run.policy.errors, 'write', response.status, response.data)?.halveBatch) {
    // Refused as a whole for its size, so nothing of it applied: the same reserved rules go again, half by half, and
    // the platform's later batches of this pass are no larger.
    const half = Math.ceil(reserved.length / 2);
    run.batchLimit = Math.max(1, Math.min(run.batchLimit, half));
    for (const part of [reserved.slice(0, half), reserved.slice(half)]) {
      await wait(run.policy.gapMs);
      if (await sendBatch(run, first, part)) return true;
    }
    return false;
  }

  let stop: PlatformStop | null = null;
  let stopResponse = response;
  let isolating = reserved.length > 1 && isolatesBatch(run, response);
  let isolated = 0;
  let repeated = 0;
  for (const { entry, rule } of reserved) {
    if (!isolating) {
      stop = (await settleWrite(run, entry, rule, response, false)) ?? stop;
      continue;
    }
    await wait(run.policy.gapMs);
    let single: RepriceResponse;
    try {
      single = await requestReprice(rule, 'write', rule.template.url, entry.write);
    } catch (error) {
      await recordTemplateError(rule, entry.found, 'write', error);
      continue;
    }
    const singleStop = await settleWrite(run, entry, rule, single);
    isolated++;
    if (!single.ok && single.status === response.status) repeated++;
    if (singleStop) {
      stop = singleStop;
      stopResponse = single;
      isolating = false;
    } else if (isolated === 2 && repeated === 2) {
      isolating = false;
    }
  }
  if (stop) applyStop(run, stop, stopResponse);
  return stop !== null;
}

/**
 * Chunked, resumable, rate-limited catch-up. Fires up to MAX_FIRES_PER_PASS edits this pass (or a platform's own cap
 * from its scheduler policy), platforms processed in parallel (serial within a platform, the policy's gap, 500 ms by
 * default). Each success is persisted immediately (crash-safe). Identical check reads are shared within a pass; a
 * shared page is re-read right before a write. Identity scans are shared until the platform's next write. Rules whose
 * template has a `batch` and whose platform's policy allows more than one item per write are written together after
 * their checks, behind a fresh re-read (QUICK-289); a one-shot held behind another market's lot joins them too, its
 * stall and lot read once for every due one-shot and again, fresh, before the write. Every failure makes its rule wait (see recordRepriceFailure) and
 * least recently failed rules go first. Check/step 429, 5xx, transport failures and declared platform errors (on the
 * read or the write) back the platform off with a persisted exponential delay; 401/403 and withheld site access block
 * it for longer; a 4xx on the shared read or a terminal write status stops the platform for this pass. A write
 * rejecting the item in a 2xx body is a counted failure. Three counted failures, a terminal write status shown to be
 * item-specific, or a week of blocked/transient-only failures pause until re-registration. Absence retires a rule only
 * on two consecutive checks that saw other rows. A one-shot continuation alarm fires when the cap, the earliest
 * waiting rule or the earliest platform backoff allows, never on a fixed one-minute loop. A platform's policy may carry an
 * error map (QUICK-289 PR 2): a status/code it names is read by the map instead of the rules above (see recordFailure),
 * and a batch it marks `halveBatch` is sent again in halves. A rule with a `schedule` fires its planned prices.
 */
export async function processDueRules(): Promise<void> {
  if (passRunning) return;
  passRunning = true;
  // The journal's expired entries go with every pass (QUICK-214), off the pass's path.
  void pruneJournal();
  try {
    // QUICK-305: while another browser of the account works, this one leaves it the account-wide rules (they stay as they
    // are, untouched) and runs only its own; it runs them all as soon as it gets the lease (`onActiveBrowserWorking`).
    const gate = await activeBrowserGate();
    const now = Date.now();
    await loadPassPolicies();
    const stored = await runExclusive(async () => ({ rules: await readAll(), ...(await readBackoff()) }));
    const { backoff, attempts } = stored;
    const rules = stored.rules.filter(gate);
    for (const rule of rules) {
      if (isRepriceRuleExpired(rule, now)) await persistResult(rule, null);
      // Its price was frozen when it was scheduled; the user reschedules instead (no request is made).
      else if (isScheduledListingRule(rule) && isListingOverdue(rule, now))
        await persistResult(rule, { ...rule, active: false, pausedReason: 'listing_overdue', pausedAt: now, lastMessage: 'listing_overdue' }, CHECK_RUN);
      // A trade-locked item that never became listable by its deadline: retired without a request.
      else if (isScheduledListingRule(rule) && isArrivalExpired(rule, now)) await persistResult(rule, retireListing(rule, 'never_appeared', now), CHECK_RUN);
      // A follower's factors the web has not refreshed for a week (QUICK-296): it waits for the web, no request is made.
      else if (isScheduledSyncRule(rule) && isSyncFactorsStale(rule, now))
        await persistResult(rule, { ...rule, active: false, pausedReason: 'sync_factors_stale', pausedAt: now, lastMessage: 'sync_factors_stale' }, CHECK_RUN);
    }
    const maxFiresByPlatform = Object.fromEntries([...passPolicies].filter(([, policy]) => policy.ownFireCap).map(([platform, policy]) => [platform, policy.maxFiresPerPass]));
    const plan = planDuePass(rules, now, { maxFires: MAX_FIRES_PER_PASS, backoff, maxFiresByPlatform });
    const platforms = Object.keys(plan.byPlatform);
    if (!platforms.length) {
      scheduleContinuation(plan.capped, rules, backoff);
      return;
    }

    const freshBackoff: BackoffMap = { ...backoff };
    const cache: CheckCache = new Map();
    await Promise.all(
      platforms.map(async (platform) => {
        let permitted = false;
        try {
          permitted = await hasPermission(platform);
        } catch {
          // A permission API failure is not evidence that requests are authorized.
        }
        if (!permitted) {
          // Withheld site access (or no catalog yet) blocks the platform; the rules stay active.
          for (const rule of plan.byPlatform[platform]) {
            await persistResult(rule, (isScheduledListingRule(rule) ? recordListingFailure : recordRepriceFailure)(rule, undefined, 'permission_unavailable', Date.now(), 'blocked'), CHECK_RUN);
          }
          freshBackoff[platform] = Date.now() + BLOCKED_BACKOFF_MS;
          return;
        }
        const policy = policyOf(platform);
        const run: PlatformRun = { platform, policy, attempts, freshBackoff, cache, scans: new Map(), preconditions: new Map(), writeSucceeded: false, batchLimit: policy.maxBatchItems };
        await runPlatform(run, plan.byPlatform[platform]);
      })
    );

    const after = await runExclusive(async () => {
      await writeBackoff(freshBackoff, attempts);
      return readAll();
    });
    scheduleContinuation(plan.capped, after.filter(gate), freshBackoff);
  } finally {
    passRunning = false;
  }
}

/**
 * The follower price of a `sync:` rule from one fresh read of its reference listing (QUICK-296), or null when the run
 * ends here: the reference market backing off (nothing recorded; the rule's wake waits for it), the reference gone
 * (the rule retires, nothing written) or unreadable (the rule's own failure; a rate limit or block also backs the
 * reference market off). Never the rule's platform: the read went elsewhere, as a one-shot's precondition read.
 */
async function syncTarget(run: PlatformRun, rule: ScheduledSyncRule): Promise<number | null> {
  const { reference } = rule;
  if ((run.freshBackoff[reference.platform] ?? 0) > Date.now()) return null;
  await wait(gapMs(reference.platform));
  if (!(await runExclusive(() => isCurrent(rule)))) return null;
  const request = { ...reference.check.request, headers: scheduledCheckHeaders(reference.check.request.headers) };
  const response = await requestReprice(rule, 'check', reference.check.request.url, request, reference.platform);
  const read = readSyncReference(reference, response);
  if (read.outcome === 'gone') {
    await persistResult(rule, retireSync(rule, Date.now()), CHECK_RUN);
    return null;
  }
  if (read.outcome === 'unknown') {
    const kind = foreignReadFailureKind(reference.platform, response, read.transient === true);
    await persistResult(rule, recordRepriceFailure(rule, response.status, `reference_${read.reason}`, Date.now(), kind, 'check'), CHECK_RUN);
    if (kind === 'blocked') run.freshBackoff[reference.platform] = Date.now() + BLOCKED_BACKOFF_MS;
    else if (kind === 'transient') run.freshBackoff[reference.platform] = Date.now() + (parseRetryAfter(response.headers, Date.now()) ?? expBackoff(run.attempts, reference.platform));
    return null;
  }
  const target = syncFollowerPrice(read.price, rule.factors);
  // Registration refuses unusable factors; a damaged stored rule writes nothing rather than guess a price.
  if (target === null) throw new Error('invalid_sync_factors');
  return target;
}

/** One platform's rules of a pass, in order: each checked, then written alone or kept for its batch. */
async function runPlatform(run: PlatformRun, list: ScheduledRule[]): Promise<void> {
  const batching = run.policy.maxBatchItems > 1;
  // Ready writes waiting for their batch, by group, in the order they became ready.
  const pending = new Map<string, ReadyWrite[]>();
  // Requests to the platform up to the last gap: a rule whose checks were all answered by shared reads sent none, so
  // the next rule needs no gap before its own.
  let sentAtGap = sentTo(run.platform);
  for (let i = 0; i < list.length; i++) {
    const rule = list[i];
    const found = rule;
    let step = computeScheduledStep(rule, Date.now());
    if (!step) continue;
    if (i > 0 && sentTo(run.platform) !== sentAtGap) await wait(run.policy.gapMs);
    sentAtGap = sentTo(run.platform);
    if (!(await runExclusive(() => isCurrent(rule)))) continue;
    if (!rule.template.checkTemplate) {
      await persistResult(rule, { ...rule, active: false, pausedReason: 'missing_check', pausedAt: Date.now(), lastMessage: 'missing_check' }, CHECK_RUN);
      continue;
    }

    let response: RepriceResponse;
    let message: string;
    let transient = false;
    let checkedStatus: RepriceCheckResult['observedStatus'];
    try {
      if (isScheduledSyncRule(rule)) {
        // A follower's price comes from its reference listing, read first (QUICK-296); null: the run ends here.
        const target = await syncTarget(run, rule);
        if (target === null) continue;
        step = { targetPrice: target, dayIndex: 0, final: false };
      }
      const identity = isScheduledListingRule(rule) ? rule.template.identity : undefined;
      // A rule that may join a batch is read through the pass's shared reads, its stall and precondition lot as well
      // (one read for every due one-shot): its batch reads all of them again, fresh, right before writing (stillReady).
      const batchable = batching && Boolean(rule.template.batch);
      let checked = isScheduledListingRule(rule) && identity ? await reconcileIdentity(rule, identity, run.scans) : await reconcile(rule, run.cache, 0, isScheduledListingRule(rule) && !batchable);
      // The asset id the create must name: the resolved current one for an identity rule, else the pinned one.
      const writeId = identity ? checked.assetId : undefined;
      if (isScheduledListingRule(rule) && checked.result.outcome === 'ready' && rule.template.stallCheck) {
        const stall = rule.template.stallCheck;
        checked = await reconcileListingStall(rule, writeId ? { ...stall, matcher: { ...stall.matcher, id: writeId } } : stall, rule.platform, batchable ? run.scans : undefined);
      }
      // A page shared from earlier in the pass is re-read from the target's page before any write (a batch does it at once).
      if (checked.result.outcome === 'listed' && checked.cached && !batchable) {
        if (checked.requested) await wait(run.policy.gapMs);
        checked = await reconcile(rule, run.cache, checked.page, true);
      }
      // Replaced or cancelled mid-check: not a platform failure, nothing to record.
      if (checked.result.reason === 'rule_changed') continue;
      response = checked.response;
      checkedStatus = checked.result.observedStatus;
      if (checked.result.outcome === 'already_listed') {
        await persistResult(rule, retireListing(rule, 'already_listed', Date.now()), CHECK_RUN);
        continue;
      }
      // An arrival one-shot reads an empty inventory like an absent item: Steam has not released it yet, so
      // it keeps waiting (bounded by its deadline) instead of counting toward an `empty_inventory` pause.
      const arrivalWait = isArrivalListing(rule) && checked.result.outcome === 'unknown' && checked.result.reason === 'empty_check_response';
      if (checked.result.outcome === 'absent' || arrivalWait) {
        await persistResult(rule, recordListingAbsent(rule, { ...checked.result, outcome: 'absent' }, response.status, Date.now()), CHECK_RUN);
        continue;
      }
      if (checked.result.outcome === 'ambiguous') {
        // Two copies match the identity: guessing could list the wrong one. The user lists it.
        await persistResult(rule, { ...rule, active: false, pausedReason: 'identity_ambiguous', pausedAt: Date.now(), lastMessage: 'identity_ambiguous' }, CHECK_RUN);
        continue;
      }
      if (checked.result.outcome === 'not_listed') {
        await persistResult(rule, recordRepriceNotListed(rule, { ...checked.result, outcome: 'not_listed' }, response.status, Date.now()), CHECK_RUN);
        continue;
      }

      const precondition = isScheduledListingRule(rule) && checked.result.outcome === 'ready' ? rule.template.precondition : undefined;
      if (precondition && isScheduledListingRule(rule)) {
        const { live, outcome } = await readPrecondition(rule, precondition, batchable ? run.preconditions : undefined);
        if (outcome === 'unmet') {
          await persistResult(rule, retireListing(rule, 'required_lot_gone', Date.now()), CHECK_RUN);
          continue;
        }
        if (outcome === 'unknown') {
          const kind = foreignReadFailureKind(precondition.platform, live.response, live.result.transient === true);
          await persistResult(rule, recordListingFailure(rule, live.response.status, `precondition_${live.result.reason}`, Date.now(), kind, 'check'), CHECK_RUN);
          continue;
        }
      }
      if (checked.result.outcome === 'unknown') {
        message = checked.result.reason;
        transient = checked.result.transient === true;
      } else {
        if (isScheduledSyncRule(rule)) {
          // Already at the follower price: nothing to write until the next run.
          const own = rule.ownPrice;
          const live = own && rule.template.checkTemplate ? readSyncRowPrice(rule.template.checkTemplate, response.data, own.paths, own.inCents) : undefined;
          const current = live ?? rule.syncedPrice;
          if (Math.abs(current - step.targetPrice) < SYNC_PRICE_TOLERANCE) {
            await persistResult(rule, { ...recordSyncSuccess(rule, current, Date.now(), false), lastCheckStatus: checkedStatus }, CHECK_RUN);
            continue;
          }
          // Sold on another marketplace (QUICK-217): its price is not changed; the item is about to leave this one too.
          if (await isListingBlocked(rule)) {
            await persistResult(rule, { ...rule, nextAttemptAt: Date.now() + 60_000, lastMessage: 'sold_elsewhere' }, CHECK_RUN);
            continue;
          }
        }
        if (identity && !writeId) throw new Error('invalid_asset_id');
        const body = fillTokens(rule, rule.template.bodyTemplate, step, writeId);
        const write: ScheduledRequest = { method: rule.template.method, headers: rule.template.headers ?? { 'Content-Type': 'application/json' }, body };
        // Before any reservation: a refused write pauses the rule and is never sent.
        await assertScheduledRequest(rule, 'write', rule.template.url, write);
        const item = batchable && rule.template.batch ? fillTokens(rule, rule.template.batch.item, step, writeId) : undefined;
        const group = item === undefined ? null : batchGroupKey(rule.template, body, item);
        const ready: ReadyWrite = { rule, found, step, writeId, checkedStatus, write, page: checked.page, ...(group && item !== undefined ? { batch: { group, item } } : {}) };
        if (!ready.batch) {
          if (await writeAlone(run, ready)) return;
          continue;
        }
        const queue = pending.get(ready.batch.group) ?? [];
        queue.push(ready);
        pending.set(ready.batch.group, queue);
        if (queue.length >= run.batchLimit) {
          pending.delete(ready.batch.group);
          if (await writeBatch(run, queue)) return;
        }
        continue;
      }
    } catch (error) {
      await recordTemplateError(rule, found, 'check', error);
      continue;
    }
    const stop = await recordFailure(run, rule, found, 'check', response, message, transient, checkedStatus);
    if (stop) {
      // The checks of rules still waiting for their batch said nothing wrong; they are simply not written this pass.
      applyStop(run, stop, response);
      return;
    }
  }
  for (const queue of pending.values()) if (await writeBatch(run, queue)) return;
}
