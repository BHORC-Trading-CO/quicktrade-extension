// apps/extension/background/active-browser.ts
//
// QUICK-305: the account's working browser on the real browser APIs. One browser of an account runs the scheduled
// rules; the others keep theirs and wait. A page of this browser claims the lease on the QTS server and hands the
// answer over (`set_active_browser`, with a device token when the server issued one); from then on this extension
// renews the lease alone with that token, every tab closed: at most once a minute while it works, every five minutes
// otherwise, and a waiting browser takes the lease over once the holder's runs out (it was closed). The token can only
// renew or take this lease; it is never sent anywhere but the QTS server's renew route. Before a page told it about a
// lease (an older web app), the extension runs its rules as it always did.
import { ACTIVE_BROWSER_RENEW_MS, ACTIVE_BROWSER_STANDBY_MS, type ActiveBrowserPush, type ActiveBrowserView, parseActiveBrowserRenewResult, type ScheduledRule } from '@qts/contracts';

import config from '@/shared/config';

import { type ActiveBrowserState, isRenewDue, isWorking, mayRunRule, parseActiveBrowserState, stateAfterPush, stateAfterRenew, stateUnreachable, stateWithoutToken } from './active-browser-model';
import { deviceId } from './device-id';

export const ACTIVE_BROWSER_ALARM = 'qts-active-browser';
const STATE_KEY = 'qts:active_browser';
const RENEW_TIMEOUT_MS = 10_000;

let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

/** One read-modify-write at a time. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function readState(): Promise<ActiveBrowserState | null> {
  return parseActiveBrowserState((await browser.storage.local.get(STATE_KEY))[STATE_KEY]);
}

async function writeState(state: ActiveBrowserState): Promise<void> {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

/** Called when this extension starts working (it got the lease): the scheduler runs its due rules at once. */
export function onActiveBrowserWorking(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function noteChange(before: ActiveBrowserState | null, after: ActiveBrowserState | null): void {
  const now = Date.now();
  if (isWorking(after, now) && !isWorking(before, now)) for (const listener of listeners) listener();
}

export async function activeBrowserView(requestId?: string): Promise<ActiveBrowserView> {
  const [state, id] = await Promise.all([readState(), deviceId()]);
  return {
    ...(requestId !== undefined ? { requestId } : {}),
    deviceId: id,
    clerkId: state?.clerkId ?? null,
    holds: state?.holds ?? false,
    working: isWorking(state, Date.now()),
    expiresAt: state?.expiresAt ?? null,
    hasToken: !!state?.token,
  };
}

/** A page's claim answer for this browser (already parsed). */
export async function acceptActiveBrowserPush(push: ActiveBrowserPush): Promise<ActiveBrowserView> {
  await exclusive(async () => {
    const before = await readState();
    const after = stateAfterPush(before, push);
    await writeState(after);
    noteChange(before, after);
  });
  return activeBrowserView();
}

/** Asks the server about the lease with the device token now; nothing without a token. Never throws. */
export async function renewActiveBrowser(): Promise<void> {
  await exclusive(async () => {
    const before = await readState();
    if (!before?.token) return;
    const requestedAt = Date.now();
    let response: Response;
    // Chrome 101 has no AbortSignal.timeout.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), RENEW_TIMEOUT_MS);
    try {
      response = await fetch(`${config.api_url}/active-browser/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: await deviceId(), token: before.token }),
        credentials: 'omit',
        signal: abort.signal,
      });
    } catch {
      // Unreachable: a holder keeps working until the server answers; the next renew tries again.
      await writeState(stateUnreachable(before));
      return;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      await writeState(stateWithoutToken(before));
      return;
    }
    // A server without the route (rolled back to a build before QUICK-305): nothing to go by, the extension runs its
    // rules as before until a page tells it about a lease again.
    if (response.status === 404) {
      await browser.storage.local.remove(STATE_KEY);
      noteChange(before, null);
      return;
    }
    const result = response.ok ? parseActiveBrowserRenewResult(await response.json().catch(() => null)) : null;
    if (!result) {
      await writeState(stateUnreachable(before));
      return;
    }
    const after = stateAfterRenew(before, result, requestedAt, Date.now());
    await writeState(after);
    noteChange(before, after);
  });
}

/** Whether the scheduler sends a rule's requests now (`mayRunRule`). */
export type ActiveBrowserGate = (rule: Pick<ScheduledRule, 'kind' | 'origin' | 'owner' | 'platform'>) => boolean;

/**
 * The scheduler's gate for the next requests. Asks the server first when the last answer is a minute old, so a browser
 * another one took the lease from stops within about a minute of it.
 */
export async function activeBrowserGate(): Promise<ActiveBrowserGate> {
  if (isRenewDue(await readState(), Date.now(), ACTIVE_BROWSER_RENEW_MS)) await renewActiveBrowser();
  const state = await readState();
  const now = Date.now();
  return (rule) => mayRunRule(state, rule, now);
}

/**
 * The alarm's tick: keeps the lease alive while the scheduler has nothing to send (a pass renews it more often), and
 * on standby checks whether the holder's lease ran out.
 */
export async function tickActiveBrowser(): Promise<void> {
  if (isRenewDue(await readState(), Date.now(), ACTIVE_BROWSER_STANDBY_MS)) await renewActiveBrowser();
}
