import { EXTENSION_JOURNAL_LIMITS, type ExtensionJournalEntry, isJournalOwner, type SchedulerDiagnosticDraft } from '@qts/contracts';

/**
 * The extension's own journal (QUICK-214 part 4, capability `diagnostics_journal`): its scheduler's runs, which happen
 * in the background whether a page is open or not, kept in `storage.local` per account (the rule's `owner`, the Clerk
 * user id the web app registered it with) and handed only to a page of that account (`take_diagnostics`), which files
 * them in the account's journal. A rule without an owner is not journaled: nobody could be told it is theirs. At most
 * `EXTENSION_JOURNAL_LIMITS.maxEntries` entries for every account together (the oldest routine run first to go, so a
 * waiting one-shot's checks never push out a failure), none older than
 * `maxAgeMs`; metadata only (marketplace, stage, outcome, status, pause reason), never a request, an answer or a price.
 * Best effort: the scheduler does not wait for a write, so a worker stopped right after a run can lose that run's entry,
 * and a storage that hangs drops runs past `MAX_PENDING_RUNS` instead of queueing them.
 */

const STORAGE_KEY = 'qts:diagnostics:journal';

interface StoredEntry extends ExtensionJournalEntry {
  owner: string;
}

let queue: Promise<unknown> = Promise.resolve();
/** Runs waiting to be written: past this (a storage that hangs) a run is dropped rather than queued. */
const MAX_PENDING_RUNS = 50;
let pendingRuns = 0;
let pruning = false;

/** One read-modify-write of the journal at a time (the scheduler and a page's take may overlap). */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

function isStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StoredEntry>;
  return isJournalOwner(entry.owner) && typeof entry.at === 'number' && Number.isFinite(entry.at) && !!entry.event && typeof entry.event === 'object';
}

/** The live entries, and whether storage still holds expired or malformed ones (to be written away). */
async function readEntries(now: number): Promise<{ entries: StoredEntry[]; stale: boolean }> {
  const stored = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!Array.isArray(stored)) return { entries: [], stale: stored !== undefined };
  const entries = stored.filter((entry): entry is StoredEntry => isStoredEntry(entry) && now - entry.at < EXTENSION_JOURNAL_LIMITS.maxAgeMs);
  return { entries, stale: entries.length !== stored.length };
}

/** A run that went as planned or waits: what goes first when the journal is full, before any failure or pause. */
function isRoutineEntry(entry: StoredEntry): boolean {
  return (entry.event.outcome === 'ok' || entry.event.outcome === 'skipped') && !entry.event.retired;
}

/** At most `maxEntries`: past it the oldest routine entries go, then the oldest of any kind. */
function withinCap(entries: StoredEntry[]): StoredEntry[] {
  let excess = entries.length - EXTENSION_JOURNAL_LIMITS.maxEntries;
  if (excess <= 0) return entries;
  const kept = entries.filter((entry) => {
    if (excess > 0 && isRoutineEntry(entry)) {
      excess--;
      return false;
    }
    return true;
  });
  return excess > 0 ? kept.slice(excess) : kept;
}

async function writeEntries(entries: StoredEntry[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: withinCap(entries) });
}

/**
 * Keeps one scheduler run for `owner`. Best effort: never throws, and the scheduler does not wait for it (a slow or
 * failing storage never delays a price change).
 */
export async function noteSchedulerRun(owner: string | undefined, event: SchedulerDiagnosticDraft, at = Date.now()): Promise<void> {
  if (!isJournalOwner(owner) || pendingRuns >= MAX_PENDING_RUNS) return;
  pendingRuns++;
  try {
    await serialized(async () => {
      const { entries } = await readEntries(at);
      entries.push({ owner, at, event });
      await writeEntries(entries);
    });
  } catch {
    // The journal is best effort.
  } finally {
    pendingRuns--;
  }
}

/** Writes away entries past their seven days (each scheduler pass and worker start asks; nothing to do is one read). */
export async function pruneJournal(now = Date.now()): Promise<void> {
  // One at a time: passes that come while one waits add nothing.
  if (pruning) return;
  pruning = true;
  try {
    await serialized(async () => {
      const { entries, stale } = await readEntries(now);
      if (stale) await writeEntries(entries);
    });
  } catch {
    // The journal is best effort.
  } finally {
    pruning = false;
  }
}

/** Hands `owner`'s entries (oldest first, at most `maxPerTake`) to the page and removes them; others' stay. */
export async function takeJournalEntries(owner: unknown, now = Date.now()): Promise<ExtensionJournalEntry[]> {
  if (!isJournalOwner(owner)) return [];
  return serialized(async () => {
    const { entries, stale } = await readEntries(now);
    const taken: ExtensionJournalEntry[] = [];
    const kept: StoredEntry[] = [];
    for (const entry of entries) {
      if (entry.owner === owner && taken.length < EXTENSION_JOURNAL_LIMITS.maxPerTake) taken.push({ at: entry.at, event: entry.event });
      else kept.push(entry);
    }
    if (taken.length || stale) await writeEntries(kept);
    return taken;
  });
}

/** Tests only: the journal's next read starts from storage again. */
export function resetDiagnosticsJournalForTests(): void {
  queue = Promise.resolve();
  pendingRuns = 0;
  pruning = false;
}
