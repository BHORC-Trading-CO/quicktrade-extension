// QUICK-214 part 4: the extension's journal of its scheduler's runs, per account, through the real message entry point
// (onRuntimeMessage → handlers/site.ts → diagnostics-journal.ts), with only the browser APIs faked.
import { EXTENSION_JOURNAL_LIMITS, type ScheduledRule } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeSender } from '../../shared/bridge-policy';
import type * as Journal from '../diagnostics-journal';
import { schedulerRunEvent } from '../diagnostics-journal-model';
import type * as Router from '../runtime-router';
import { chromeStored } from './chrome-storage';

vi.mock('../../shared/config', () => ({ BRIDGE_MODE: 'production' }));

const PAGE: BridgeSender = { id: 'qts', tab: { id: 2 }, frameId: 0, origin: 'https://app.quicktrade.skin', url: 'https://app.quicktrade.skin/sell-mode' };
const KEY = 'qts:diagnostics:journal';
const DAY = 86_400_000;
const NOW = 40 * DAY;
const RUN = { kind: 'scheduler', platform: 'csfloat.com', stage: 'write', outcome: 'ok' } as const;

let router: typeof Router;
let journal: typeof Journal;
let storage: Record<string, unknown>;
const local = { get: vi.fn(), set: vi.fn() };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  storage = {};
  local.get.mockImplementation(async (keys: string | string[]) =>
    Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((key) => key in storage).map((key) => [key, chromeStored(storage[key])]))
  );
  local.set.mockImplementation(async (values: Record<string, unknown>) => {
    // A slow write, so a run and a take in flight would interleave without the journal's queue.
    await new Promise((resolve) => setTimeout(resolve, 5));
    Object.assign(storage, chromeStored(values));
  });
  vi.stubGlobal('browser', { runtime: { id: 'qts', getURL: (path = '/') => `chrome-extension://qts${path}` }, storage: { local } });
  router = await import('../runtime-router');
  journal = await import('../diagnostics-journal');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function take(owner: unknown, requestId = 'r1'): Promise<unknown> {
  const reply = vi.fn();
  router.onRuntimeMessage({ type: 'site:take_diagnostics', data: { requestId, owner } }, PAGE, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
  return reply.mock.calls[0]?.[0];
}

describe("the extension's journal (QUICK-214 part 4)", () => {
  it("hands an account's entries to its page once; another account's stay for its own", async () => {
    await Promise.all([
      journal.noteSchedulerRun('user_alice', RUN, NOW - 2_000),
      journal.noteSchedulerRun('user_bob', { ...RUN, outcome: 'error', status: 500 }, NOW - 1_000),
      journal.noteSchedulerRun('user_alice', { ...RUN, stage: 'check', outcome: 'skipped' }, NOW),
    ]);
    expect(await take('user_alice')).toEqual({
      ok: true,
      data: {
        requestId: 'r1',
        entries: [
          { at: NOW - 2_000, event: RUN },
          { at: NOW, event: { ...RUN, stage: 'check', outcome: 'skipped' } },
        ],
      },
    });
    expect(await take('user_alice')).toEqual({ ok: true, data: { requestId: 'r1', entries: [] } });
    expect(await take('user_bob')).toMatchObject({ data: { entries: [{ at: NOW - 1_000, event: { outcome: 'error', status: 500 } }] } });
  });

  it('keeps nothing without a Clerk user id and hands nothing for a malformed owner', async () => {
    await journal.noteSchedulerRun(undefined, RUN);
    await journal.noteSchedulerRun('someone', RUN);
    expect(storage[KEY]).toBeUndefined();
    await journal.noteSchedulerRun('user_alice', RUN);
    expect(await take({ owner: 'user_alice' })).toMatchObject({ data: { entries: [] } });
    expect(await take('user_alice')).toMatchObject({ data: { entries: [{ event: RUN }] } });
  });

  it('when full, a routine run goes before a failure, so waiting checks never push errors out', async () => {
    storage[KEY] = [
      { owner: 'user_alice', at: NOW - 3_000, event: { ...RUN, outcome: 'error', status: 500 } },
      ...Array.from({ length: EXTENSION_JOURNAL_LIMITS.maxEntries - 1 }, (_, index) => ({
        owner: 'user_bob',
        at: NOW - 2_000 + index,
        event: { ...RUN, stage: 'check', outcome: 'skipped' },
      })),
    ];
    await journal.noteSchedulerRun('user_bob', { ...RUN, stage: 'check', outcome: 'skipped' }, NOW);
    const kept = storage[KEY] as Array<{ owner: string; event: { outcome: string } }>;
    expect(kept).toHaveLength(EXTENSION_JOURNAL_LIMITS.maxEntries);
    expect(kept[0]).toMatchObject({ owner: 'user_alice', event: { outcome: 'error' } });
  });

  it('keeps at most 500 entries, the oldest first to go, and none older than seven days', async () => {
    storage[KEY] = [
      { owner: 'user_alice', at: NOW - 8 * DAY, event: { ...RUN, outcome: 'paused', paused: 'consecutive_failures' } },
      ...Array.from({ length: EXTENSION_JOURNAL_LIMITS.maxEntries }, (_, index) => ({ owner: 'user_alice', at: NOW - DAY + index, event: RUN })),
    ];
    await journal.noteSchedulerRun('user_alice', { ...RUN, outcome: 'retry' }, NOW);
    const kept = storage[KEY] as Array<{ at: number; event: { outcome: string } }>;
    expect(kept).toHaveLength(EXTENSION_JOURNAL_LIMITS.maxEntries);
    expect(kept.some((entry) => entry.event.outcome === 'paused')).toBe(false);
    expect(kept[0]?.at).toBe(NOW - DAY + 1);
    expect(kept.at(-1)?.event.outcome).toBe('retry');
    const first = (await take('user_alice')) as { data: { entries: unknown[] } };
    expect(first.data.entries).toHaveLength(EXTENSION_JOURNAL_LIMITS.maxPerTake);
  });
});

describe('expired entries leave storage', () => {
  it('on a take and on a pass, even when nobody takes them', async () => {
    storage[KEY] = [
      { owner: 'user_alice', at: NOW - 8 * DAY, event: RUN },
      { owner: 'user_bob', at: NOW - DAY, event: RUN },
    ];
    await journal.pruneJournal();
    expect(storage[KEY]).toEqual([{ owner: 'user_bob', at: NOW - DAY, event: RUN }]);
    storage[KEY] = [{ owner: 'user_bob', at: NOW - 8 * DAY, event: RUN }];
    expect(await take('user_alice')).toMatchObject({ data: { entries: [] } });
    expect(storage[KEY]).toEqual([]);
  });
});

describe('what one run did, from the rule before and after it', () => {
  const before: ScheduledRule = {
    ruleId: '1:csfloat.com',
    platform: 'csfloat.com',
    itemId: '1',
    marketHashName: 'x',
    firstPrice: 10,
    secondPrice: 9,
    startAt: 0,
    days: 5,
    lastAppliedDay: 1,
    template: { url: 'https://csfloat.com/api/v1/listings/1', method: 'PATCH', bodyTemplate: '{}', priceInCents: true },
    active: true,
    createdAt: 0,
    consecutiveFailures: 0,
  };
  const failed = { ...before, lastFailureAt: NOW, lastStatus: 503 };

  it.each([
    ['the last step written (rule gone)', null, 'write', { outcome: 'ok' }],
    ['a new step', { ...before, lastAppliedDay: 2 }, 'write', { outcome: 'ok' }],
    ['a counted failure', { ...failed, consecutiveFailures: 1, lastStatus: 400 }, 'write', { outcome: 'error', status: 400 }],
    ['a transient failure', { ...failed, transientFailures: 1 }, 'check', { outcome: 'retry', status: 503 }],
    ['a blocked platform', { ...before, lastFailureAt: NOW, blockedSince: NOW }, 'check', { outcome: 'retry' }],
    ['a pause', { ...failed, consecutiveFailures: 3, active: false, pausedReason: 'consecutive_failures' }, 'write', { outcome: 'paused', paused: 'consecutive_failures', status: 503 }],
    ['a one-shot listed', { ...before, active: false, retiredReason: 'listed' }, 'write', { outcome: 'ok', retired: 'listed' }],
    ['a one-shot whose item never appeared', { ...before, active: false, retiredReason: 'never_appeared' }, 'check', { outcome: 'skipped', retired: 'never_appeared' }],
    ['a check that changed nothing yet', { ...before, pendingNotListedAt: NOW }, 'check', { outcome: 'skipped' }],
  ] as const)('%s', (_name, after, stage, expected) => {
    expect(schedulerRunEvent(before, after as ScheduledRule | null, stage)).toEqual({ kind: 'scheduler', platform: 'csfloat.com', stage, ...expected });
  });
});
