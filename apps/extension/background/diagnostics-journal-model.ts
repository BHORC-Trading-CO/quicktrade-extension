import type { ScheduledRule, SchedulerDiagnosticDraft, SchedulerDiagnosticOutcome } from '@qts/contracts';

/** A one-shot retired because it reached its goal: listed now, or it already was. */
const DONE_RETIREMENTS: ReadonlySet<string> = new Set(['listed', 'already_listed']);

/**
 * What one run of a scheduled rule did, read from the rule before and after it (QUICK-214 part 4): every outcome of
 * `processDueRules` is stored through `persistResult`, so the difference says it without touching each branch.
 *  - gone (`after` null): the last step was written;
 *  - newly paused: `paused` with the rule's reason;
 *  - newly retired: `ok` when listed (now or already), else `skipped` (never appeared, the lot it waited for is gone, …),
 *    with the reason as `retired`;
 *  - a counted failure (more consecutive failures, or a failure without a transient or blocked count): `error`;
 *  - a transient or blocked failure (retried later, never counted): `retry`;
 *  - a new step applied: `ok`; anything else (a check that changed nothing yet): `skipped`.
 */
export function schedulerRunEvent(before: ScheduledRule, after: ScheduledRule | null, stage: 'check' | 'write'): SchedulerDiagnosticDraft {
  const base = { kind: 'scheduler' as const, platform: before.platform, stage };
  if (!after) return { ...base, outcome: 'ok' };
  const failed = after.lastFailureAt !== undefined && after.lastFailureAt !== before.lastFailureAt;
  const status = failed && typeof after.lastStatus === 'number' ? { status: after.lastStatus } : {};
  if (after.pausedReason && after.pausedReason !== before.pausedReason) return { ...base, outcome: 'paused', paused: after.pausedReason, ...status };
  if (after.retiredReason && after.retiredReason !== before.retiredReason) {
    // Ended for good: the reason tells support a finished rule from a check that is still waiting.
    return { ...base, outcome: DONE_RETIREMENTS.has(after.retiredReason) ? 'ok' : 'skipped', retired: after.retiredReason };
  }
  if (failed) return { ...base, outcome: failureOutcome(before, after), ...status };
  return { ...base, outcome: after.lastAppliedDay !== before.lastAppliedDay ? 'ok' : 'skipped' };
}

function failureOutcome(before: ScheduledRule, after: ScheduledRule): SchedulerDiagnosticOutcome {
  if ((after.consecutiveFailures ?? 0) > (before.consecutiveFailures ?? 0)) return 'error';
  const transient = (after.transientFailures ?? 0) > (before.transientFailures ?? 0);
  const blocked = after.blockedSince !== undefined;
  return transient || blocked ? 'retry' : 'error';
}
