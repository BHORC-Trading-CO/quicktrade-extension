import { isJournalOwner, type ListingBlocksSnapshot, SOLD_ELSEWHERE_TTL_MS } from '@qts/contracts';

import { StorageKeys } from '@/shared/storage';

const MAX_OWNERS = 3;
let queue: Promise<unknown> = Promise.resolve();

function parseSnapshot(value: unknown, legacy = false): ListingBlocksSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const { owner, assetIds, expiresAt: storedExpiries, at } = value as Partial<ListingBlocksSnapshot>;
  if (
    !isJournalOwner(owner) ||
    !Number.isSafeInteger(at) ||
    at === undefined ||
    at < 0 ||
    !Array.isArray(assetIds) ||
    assetIds.length > 400 ||
    !assetIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128 && id.trim() === id) ||
    new Set(assetIds).size !== assetIds.length
  )
    return null;
  // Round 2 storage lacks notice times: retain protection for at most seven days after its last push.
  // New pushes must carry exact expiries; only persisted legacy data gets this conservative migration.
  const expiresAt = legacy && !Object.hasOwn(value, 'expiresAt') ? Object.fromEntries(assetIds.map((id) => [id, at + SOLD_ELSEWHERE_TTL_MS])) : storedExpiries;
  if (
    !expiresAt ||
    typeof expiresAt !== 'object' ||
    Array.isArray(expiresAt) ||
    Object.keys(expiresAt).length !== assetIds.length ||
    !assetIds.every((id) => {
      const expiry = expiresAt[id];
      return Object.hasOwn(expiresAt, id) && typeof expiry === 'number' && Number.isSafeInteger(expiry) && expiry >= 0;
    })
  )
    return null;
  return { owner, assetIds: [...assetIds], expiresAt: { ...expiresAt }, at };
}

function prune(snapshot: ListingBlocksSnapshot, now: number): ListingBlocksSnapshot {
  const expiresAt = Object.fromEntries(Object.entries(snapshot.expiresAt).filter(([, expiry]) => expiry > now));
  const assetIds = snapshot.assetIds.filter((id) => Object.hasOwn(expiresAt, id));
  return { ...snapshot, assetIds, expiresAt };
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => undefined);
  return run;
}

/** Read storage on every pass, including the first pass after the service worker restarts. */
async function readSnapshots(): Promise<ListingBlocksSnapshot[]> {
  const stored = (await browser.storage.local.get(StorageKeys.listingBlocks))[StorageKeys.listingBlocks];
  if (!Array.isArray(stored)) return [];
  let migrated = false;
  const snapshots = stored
    .map((value) => {
      const snapshot = parseSnapshot(value, true);
      if (snapshot && !parseSnapshot(value)) migrated = true;
      return snapshot;
    })
    .filter((row): row is ListingBlocksSnapshot => row !== null)
    .sort((a, b) => b.at - a.at);
  const newest = snapshots.filter((row, index) => snapshots.findIndex((other) => other.owner === row.owner) === index).slice(0, MAX_OWNERS);
  if (migrated) await browser.storage.local.set({ [StorageKeys.listingBlocks]: newest });
  return newest;
}

/** Only the app-origin route calls this. Serialize competing tabs so an older snapshot cannot overwrite a newer one. */
export function setListingBlocks(value: unknown): Promise<{ accepted: boolean }> {
  const incoming = parseSnapshot(value);
  if (!incoming) return Promise.resolve({ accepted: false });
  return serialized(async () => {
    const snapshots = await readSnapshots();
    const previous = snapshots.find((row) => row.owner === incoming.owner);
    if (previous && previous.at >= incoming.at) return { accepted: false };
    const now = Date.now();
    const next = [incoming, ...snapshots.filter((row) => row.owner !== incoming.owner)]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_OWNERS)
      .map((row) => prune(row, now));
    await browser.storage.local.set({ [StorageKeys.listingBlocks]: next });
    return { accepted: true };
  });
}

export async function isListingBlocked(rule: { owner?: string; itemId: string | number }, resolvedAssetId?: string): Promise<boolean> {
  if (!isJournalOwner(rule.owner)) return false;
  return serialized(async () => {
    const snapshots = await readSnapshots();
    const now = Date.now();
    const next = snapshots.map((row) => prune(row, now));
    // Retain empty snapshots as timestamp tombstones so an older push cannot restore an expired block.
    if (next.some((row, index) => row.assetIds.length !== snapshots[index]?.assetIds.length)) await browser.storage.local.set({ [StorageKeys.listingBlocks]: next });
    const snapshot = next.find((row) => row.owner === rule.owner);
    return snapshot !== undefined && (snapshot.assetIds.includes(String(rule.itemId)) || (resolvedAssetId !== undefined && snapshot.assetIds.includes(resolvedAssetId)));
  });
}
