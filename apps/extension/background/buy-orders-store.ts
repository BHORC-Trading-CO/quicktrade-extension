import { type BuyOrdersSetResult, type BuyOrdersSnapshot, parseBuyOrdersSnapshot } from '@qts/contracts';

import { StorageKeys } from '@/shared/storage';

/**
 * The account's QTS buy orders as the web app last pushed them (QUICK-232, capability `buy_orders`): the server's state
 * for one Clerk user, kept in `storage.local` for the buy-order engine (T11). Only a valid snapshot is kept, and for the
 * same account only a newer revision replaces the stored one, so a stale tab cannot bring back a rule the user already
 * switched off in another tab. Accepts run one at a time: two tabs pushing at once never interleave a read and a write.
 * The extension decides nothing here; the server checked every limit before it answered.
 */

let queue: Promise<unknown> = Promise.resolve();
const storedListeners = new Set<(snapshot: BuyOrdersSnapshot) => void>();

/** QUICK-233: the buy-order engine hears of every snapshot kept. Returns the unsubscribe. */
export function onBuyOrdersStored(listener: (snapshot: BuyOrdersSnapshot) => void): () => void {
  storedListeners.add(listener);
  return () => storedListeners.delete(listener);
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** The stored snapshot, or null when there is none or it no longer reads as one. */
export async function getStoredBuyOrders(): Promise<BuyOrdersSnapshot | null> {
  const stored = (await browser.storage.local.get(StorageKeys.buyOrders)) as Record<string, unknown>;
  return parseBuyOrdersSnapshot(stored[StorageKeys.buyOrders]);
}

/** Whether `incoming` replaces `stored`: another account's state always does; the same account's only when newer. */
export function replacesStoredBuyOrders(stored: BuyOrdersSnapshot | null, incoming: BuyOrdersSnapshot): boolean {
  return stored === null || stored.clerkId !== incoming.clerkId || incoming.revision > stored.revision;
}

/** `site:set_buy_orders`: validates and keeps the pushed state. */
export function acceptBuyOrders(value: unknown): Promise<BuyOrdersSetResult> {
  const incoming = parseBuyOrdersSnapshot(value);
  if (!incoming) return Promise.resolve({ error: 'buy_orders_refused:invalid' });
  return serialized(async () => {
    const stored = await getStoredBuyOrders();
    if (!replacesStoredBuyOrders(stored, incoming)) return { stored: false, revision: stored?.revision ?? incoming.revision };
    await browser.storage.local.set({ [StorageKeys.buyOrders]: incoming });
    for (const listener of storedListeners) {
      try {
        listener(incoming);
      } catch {
        // A listener's failure never refuses the page's rules.
      }
    }
    return { stored: true, revision: incoming.revision };
  });
}
