// apps/extension/background/operation-table-store.ts
//
// The effective operation table: the bundled PLATFORM_OPERATIONS with the platforms of the accepted signed table
// replaced. The accepted envelope lives in storage.local; on every worker start it is verified again (signature,
// document, expiry, floor) before first use, and dropped when it no longer passes. Every failure falls back to the
// bundled table, never to "allow". Refusals are logged without values (reason and a field path only).
//
// Every load, drop and accept runs through one queue, so an expiry reload can never interleave with an accept: it
// cannot wipe a table accepted meanwhile or lower the stored version floor. A drop re-reads storage first and removes
// only the envelope it verified; every write keeps `highestVersion` at the maximum of what is stored and what is held.
import type { OperationTable, OperationTableRefusal, SignedOperationTable } from '@qts/contracts';
import { effectiveOperationTable, PLATFORM_OPERATIONS } from '@qts/contracts';

import { OPERATION_TABLE_PUBLIC_KEY } from '@/shared/operation-table-key';
import { storageGet, StorageKeys, storageSet } from '@/shared/storage';

import { readSignedEnvelope, verifySignedOperationTable } from './operation-table-policy';

const BUNDLED: OperationTable = PLATFORM_OPERATIONS;

/** After a failed storage read the bundled fallback is kept this long, then the load is tried again. */
export const STORAGE_RETRY_MS = 60_000;

/** What storage.local keeps: the accepted envelope and the highest version ever accepted (the rollback floor). */
interface StoredOperationTable {
  envelope?: SignedOperationTable;
  highestVersion: number;
}

interface OperationTableState {
  table: OperationTable;
  acceptedDocument: string | null;
  highestVersion: number;
  expiresAt?: number;
}

export type OperationTableUpdate = { ok: true; version: number; unchanged: boolean } | { ok: false; refusal: OperationTableRefusal };

/** The verified state; read and replaced only by tasks of `queue` (the fast path in getEffectiveOperationTable only reads it). */
let state: OperationTableState | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Updates in flight by their exact envelope: several tabs delivering the same artifact share one verification. */
const pending = new Map<string, Promise<OperationTableUpdate>>();

export function logOperationTableRefusal(refusal: OperationTableRefusal, source: 'page' | 'storage'): void {
  console.warn('[qts background] operation table refused', { source, reason: refusal.reason, ...(refusal.detail ? { detail: refusal.detail.slice(0, 128) } : {}) });
}

/** Runs `task` after every earlier load, drop and accept has finished. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

function bundledState(highestVersion = 0): OperationTableState {
  return { table: BUNDLED, acceptedDocument: null, highestVersion };
}

function isExpired(current: OperationTableState, now: number): boolean {
  return current.expiresAt !== undefined && current.expiresAt <= now;
}

async function readStored(): Promise<StoredOperationTable> {
  const raw = (await storageGet<Record<string, unknown>>(StorageKeys.operationTable))[StorageKeys.operationTable];
  if (typeof raw !== 'object' || raw === null) return { highestVersion: 0 };
  const { envelope, highestVersion } = raw as Record<string, unknown>;
  const floor = typeof highestVersion === 'number' && Number.isSafeInteger(highestVersion) && highestVersion > 0 ? highestVersion : 0;
  const signed = readSignedEnvelope(envelope);
  return signed ? { envelope: signed, highestVersion: floor } : { highestVersion: floor };
}

async function writeStored(value: StoredOperationTable): Promise<void> {
  await storageSet({ [StorageKeys.operationTable]: value });
}

/**
 * Forgets the stored envelope whose `document` failed verification, keeping the floor. Storage is read again first:
 * an envelope that is no longer the one verified is kept (only its floor is raised when lower). Returns that other
 * envelope, if any, so the caller can verify it.
 */
async function dropStoredEnvelope(document: string, floor: number): Promise<StoredOperationTable | null> {
  const latest = await readStored();
  const highestVersion = Math.max(latest.highestVersion, floor);
  if (latest.envelope && latest.envelope.document !== document) {
    if (latest.highestVersion < highestVersion) await writeStored({ envelope: latest.envelope, highestVersion });
    return { envelope: latest.envelope, highestVersion };
  }
  await writeStored({ highestVersion });
  return null;
}

/** Reads and verifies the stored envelope; `heldFloor` is the floor this worker already knows (never lowered). */
async function loadState(heldFloor: number, retry = true): Promise<OperationTableState> {
  if (!OPERATION_TABLE_PUBLIC_KEY) return bundledState();
  let stored: StoredOperationTable;
  try {
    stored = await readStored();
  } catch {
    logOperationTableRefusal({ reason: 'storage' }, 'storage');
    // A transient failure must not pin the bundled table for the worker's lifetime: expire the fallback soon.
    return { ...bundledState(heldFloor), expiresAt: Date.now() + STORAGE_RETRY_MS };
  }
  const floor = Math.max(stored.highestVersion, heldFloor);
  if (!stored.envelope) return bundledState(floor);
  const verdict = await verifySignedOperationTable(stored.envelope, {
    publicKey: OPERATION_TABLE_PUBLIC_KEY,
    highestVersion: floor,
    acceptedDocument: stored.envelope.document,
    now: Date.now(),
  });
  if (!verdict.ok) {
    logOperationTableRefusal(verdict.refusal, 'storage');
    // The copy no longer passes (expired, a release raised the floor, another key): forget it, keep the floor.
    let replaced: StoredOperationTable | null = null;
    try {
      replaced = await dropStoredEnvelope(stored.envelope.document, floor);
    } catch {
      logOperationTableRefusal({ reason: 'storage' }, 'storage');
    }
    // Another envelope was stored meanwhile: verify that one instead (once).
    if (replaced && retry) return loadState(replaced.highestVersion, false);
    return bundledState(Math.max(floor, replaced?.highestVersion ?? 0));
  }
  return {
    table: effectiveOperationTable(BUNDLED, verdict.document.table),
    acceptedDocument: verdict.envelope.document,
    highestVersion: Math.max(floor, verdict.document.version),
    expiresAt: verdict.document.expiresAt,
  };
}

/** The verified state, loaded (or reloaded after its expiry) when needed. Call only from a queued task. */
async function settledState(): Promise<OperationTableState> {
  if (!state || isExpired(state, Date.now())) state = await loadState(state?.highestVersion ?? 0);
  return state;
}

/** The table every request is matched against: proxy, login probes, redirects, auth refresh and the scheduler. */
export async function getEffectiveOperationTable(): Promise<OperationTable> {
  const current = state;
  if (current && !isExpired(current, Date.now())) return current.table;
  // First use, or a persistent background page (Firefox MV2) outlived the table's expiry: load (again) in the queue.
  try {
    return (await enqueue(settledState)).table;
  } catch {
    return BUNDLED;
  }
}

function refused(refusal: OperationTableRefusal): OperationTableUpdate {
  logOperationTableRefusal(refusal, 'page');
  return { ok: false, refusal };
}

async function applyUpdate(value: unknown): Promise<OperationTableUpdate> {
  const current = await settledState();
  const verdict = await verifySignedOperationTable(value, {
    publicKey: OPERATION_TABLE_PUBLIC_KEY,
    highestVersion: current.highestVersion,
    acceptedDocument: current.acceptedDocument,
    now: Date.now(),
  });
  if (!verdict.ok) return refused(verdict.refusal);
  const { version } = verdict.document;
  if (verdict.unchanged) return { ok: true, version, unchanged: true };
  try {
    // Storage may hold a higher floor than this worker saw (another context): never store below it.
    const latest = await readStored();
    if (latest.highestVersion > version) return refused({ reason: 'rollback' });
    if (latest.highestVersion === version && latest.envelope?.document !== verdict.envelope.document) return refused({ reason: 'version_conflict' });
    await writeStored({ envelope: verdict.envelope, highestVersion: Math.max(latest.highestVersion, current.highestVersion, version) });
  } catch {
    return refused({ reason: 'storage' });
  }
  state = {
    table: effectiveOperationTable(BUNDLED, verdict.document.table),
    acceptedDocument: verdict.envelope.document,
    highestVersion: version,
    expiresAt: verdict.document.expiresAt,
  };
  return { ok: true, version, unchanged: false };
}

/**
 * `site:set_operation_table`: verify and, when newer, store and apply. Updates run one at a time with every load and
 * drop; an identical envelope already in flight (several tabs) shares that update's answer.
 */
export function acceptOperationTable(value: unknown): Promise<OperationTableUpdate> {
  const envelope = readSignedEnvelope(value);
  const key = envelope ? `${envelope.signature}\n${envelope.document}` : null;
  const inFlight = key ? pending.get(key) : undefined;
  if (inFlight) return inFlight;
  const run = enqueue(() => applyUpdate(value));
  if (key) {
    pending.set(key, run);
    const clear = () => {
      pending.delete(key);
    };
    run.then(clear, clear);
  }
  return run;
}
