import { type DnrRulesResult, PAGE_DNR_MAX_ID, PAGE_DNR_MIN_ID, type PageDnrRule, validatePageDnrRules } from '@qts/contracts';

import { HALOSKINS_DNR_ID } from './haloskins-service';

const PAGE_ID_SLOTS = PAGE_DNR_MAX_ID - PAGE_DNR_MIN_ID + 1;

let queue: Promise<unknown> = Promise.resolve();
/** Page installs and the startup migration read and replace the same ids: run them one at a time. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Resolves once every page install and migration queued so far has finished (QUICK-202). Login probes depend on the
 * page's header rewrites, so the status service waits for a `set_dnr_rules` that reached the background before it.
 */
export function pageDnrSettled(): Promise<void> {
  return queue.then(() => undefined);
}

/** When page rules for a host were last installed, in this worker's life (QUICK-202 r1). */
const installedAtByHost = new Map<string, number>();

/** The latest page-rule install for any of these hosts (0 = none since the worker started). */
export function pageDnrInstalledAt(hosts: readonly string[]): number {
  return Math.max(0, ...hosts.map((host) => installedAtByHost.get(host) ?? 0));
}

/**
 * The initiator host of the extension's own requests: the Chrome id, or Firefox's per-install UUID (its background
 * page is `moz-extension://<uuid>/…`). Every page rule is pinned to it (QUICK-291), like HaloSkins 1014.
 */
function extensionHost(): string {
  return new URL(browser.runtime.getURL('/')).hostname;
}

/** Permission checks are browser-owned; the page-supplied platform catalog is not authority. */
export function installPageDnrRules(payload: unknown): Promise<DnrRulesResult> {
  return serialized(() => install(payload));
}

async function install(payload: unknown): Promise<DnrRulesResult> {
  const ownHost = extensionHost();
  const { accepted, rejected } = validatePageDnrRules(payload, ownHost);
  const apiAvailable = !!browser.declarativeNetRequest?.updateDynamicRules;
  if (!accepted.length) {
    return rejected.length ? { status: 'rejected', installedIds: [], rejected } : { status: 'skipped', reason: 'no rules', apiAvailable, installedIds: [], rejected };
  }
  if (!apiAvailable) return { status: 'skipped', reason: 'api_unavailable', apiAvailable, installedIds: [], rejected };

  const rules: PageDnrRule[] = [];
  const hosts: string[] = [];
  for (const { rule, host } of accepted) {
    let granted = false;
    try {
      // contains includes both required manifest hosts and optional hosts actually granted by the user.
      granted = host !== ownHost && (await browser.permissions.contains({ origins: [`https://${host}/*`] }));
    } catch {
      // Permission errors fail closed, without exposing browser error text to the page.
    }
    if (granted) {
      rules.push(rule);
      hosts.push(host);
    } else rejected.push({ id: rule.id, reason: 'host_not_granted' });
  }
  if (!rules.length) return { status: 'rejected', installedIds: [], rejected };
  try {
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map((rule) => rule.id),
      addRules: rules as chrome.declarativeNetRequest.Rule[],
    });
    const installedAt = Date.now();
    for (const host of hosts) installedAtByHost.set(host, installedAt);
    return { status: rejected.length ? 'partial' : 'ok', installedIds: rules.map((rule) => rule.id), rejected };
  } catch {
    // DNR errors can contain header values. Failed atomic updates install/remove nothing.
    return { status: 'rejected', installedIds: [], rejected: [...rejected, ...rules.map((rule) => ({ id: rule.id, reason: 'installation_failed' as const }))] };
  }
}

/** Stable page slot for a stored id: 2xxx stays, legacy 1xxx moves to 2xxx, any other id keeps its last three digits. */
function pageIdFor(id: number): number {
  return PAGE_DNR_MIN_ID + (id % PAGE_ID_SLOTS);
}

/** Who keeps a contested slot: a rule already in the page range, then a legacy 1xxx page rule, then anything else. */
function slotRank(id: number): number {
  if (id >= PAGE_DNR_MIN_ID && id <= PAGE_DNR_MAX_ID) return 0;
  return id >= 1000 && id <= 1999 ? 1 : 2;
}

/** getDynamicRules echoes fields a page never sends: Firefox returns null for every absent key, browsers the case flag. */
function withoutBrowserDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBrowserDefaults);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => entry !== null && entry !== undefined && !(key === 'isUrlFilterCaseSensitive' && typeof entry === 'boolean'))
      .map(([key, entry]) => [key, withoutBrowserDefaults(entry)])
  );
}

/** Deep equality of JSON-like data, ignoring key order. */
function sameData(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, index) => sameData(entry, b[index]));
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}

type Slot = { rule: PageDnrRule; from: number; unchanged: boolean };

/**
 * Dynamic rules survive browser restarts and extension updates, and before QUICK-172 a page could store any rule under
 * any id. Every stored rule except the background-owned 1014 goes through the page validator (with the T5 normalisation,
 * and pinned to this extension as initiator, QUICK-291: a rule an older version stored without it is rewritten here):
 * a valid one is kept or moved to its page slot, an invalid one (or the loser of a slot) is removed. Rules for hosts the
 * user has not granted stay: modifyHeaders needs host access, so they are inert until granted.
 * One atomic update, so background flows (auto-reprice, popup login checks) never run without their header rewrites.
 * Runs on install/update and every worker start; a no-op once everything is in place, and a failure retries next start.
 */
export function migrateLegacyPageDnrRules(): Promise<void> {
  return serialized(migrate);
}

async function migrate(): Promise<void> {
  const dnr = browser.declarativeNetRequest;
  if (!dnr?.getDynamicRules || !dnr?.updateDynamicRules) return;
  try {
    const ownHost = extensionHost();
    const stored = (await dnr.getDynamicRules()).filter(({ id }) => id !== HALOSKINS_DNR_ID);
    const slots = new Map<number, Slot>();
    // Sorts a copy (toSorted needs Chrome 110; the minimum is 101).
    const ranked = [...stored].sort((a, b) => slotRank(a.id) - slotRank(b.id) || a.id - b.id);
    for (const entry of ranked) {
      const id = pageIdFor(entry.id);
      if (slots.has(id)) continue;
      const candidate = { ...(withoutBrowserDefaults(entry) as object), id };
      const accepted = validatePageDnrRules({ rules: [candidate] }, ownHost).accepted[0];
      if (!accepted || accepted.host === ownHost) continue;
      const unchanged = entry.id === id && sameData(candidate, accepted.rule);
      slots.set(id, { rule: accepted.rule, from: entry.id, unchanged });
    }
    const kept = new Set([...slots.values()].filter(({ unchanged }) => unchanged).map(({ from }) => from));
    const removeRuleIds = stored.map(({ id }) => id).filter((id) => !kept.has(id));
    const addRules = [...slots.values()].filter(({ unchanged }) => !unchanged).map(({ rule }) => rule);
    if (!removeRuleIds.length && !addRules.length) return;
    await dnr.updateDynamicRules({ removeRuleIds, addRules: addRules as chrome.declarativeNetRequest.Rule[] });
  } catch {
    // Atomic: a failed update changes nothing. Browser text can contain header values, so it is not logged.
    console.warn('[qts background] Legacy DNR cleanup failed');
  }
}
