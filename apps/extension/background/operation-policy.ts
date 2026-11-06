// apps/extension/background/operation-policy.ts
//
// QUICK-171: the background executes only the operations of its effective table: PLATFORM_OPERATIONS
// (@qts/contracts) as bundled, with the platforms of a verified signed table replaced (operation-table-store.ts).
// Every proxied request, login probe and scheduled request is matched here first; a refusal makes no
// network call and is logged without values (names of the offending key/header only).
import type { OperationMatch, OperationPurpose, OperationRefusal, OperationRequest, OperationTable, ScheduledRule } from '@qts/contracts';
import { matchPlatformOperation, scheduledRuleRequests } from '@qts/contracts';

import { getPlatformCatalog } from '@/shared/platformCatalog';

import { getEffectiveOperationTable } from './operation-table-store';

/**
 * The ids the page-published catalog entry narrows its platform to; undefined = every bundled operation.
 * The catalog can only remove operations: unknown ids match nothing. A storage failure narrows to none.
 */
async function narrowedOperationIds(platform: string): Promise<readonly string[] | undefined> {
  try {
    const entry = (await getPlatformCatalog()).find((candidate) => candidate.id === platform);
    const ids: unknown = entry?.operations;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : undefined;
  } catch {
    return [];
  }
}

function hostOf(url: unknown): string | undefined {
  try {
    return typeof url === 'string' ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

/** Logs a refusal: platform, purpose, reason, the offending name, method and host. Never a URL, header value or body. */
export function logOperationRefusal(platform: string, purpose: OperationPurpose, refusal: OperationRefusal, request: Partial<OperationRequest>): void {
  console.warn('[qts background] operation refused', {
    platform: String(platform).slice(0, 64),
    purpose,
    reason: refusal.reason,
    ...(refusal.detail ? { detail: refusal.detail } : {}),
    method: typeof request.method === 'string' ? request.method.slice(0, 16) : undefined,
    host: hostOf(request.url),
  });
}

/**
 * Matches one request for `purpose` against the effective table (bundled, or with a verified signed table's
 * platforms replaced; `table` when the caller already holds it), narrowed by the stored catalog.
 */
export async function resolveOperation(platform: string, request: OperationRequest, purpose: OperationPurpose, table?: OperationTable): Promise<OperationMatch> {
  const operations = table ?? (await getEffectiveOperationTable());
  const allowedIds = await narrowedOperationIds(platform);
  const match = matchPlatformOperation(platform, request, { purpose, table: operations, ...(allowedIds ? { allowedIds } : {}) });
  if (!match.ok) logOperationRefusal(platform, purpose, match.refusal, request);
  return match;
}

/** Fire-time check of one scheduled request: a check read or the write. Null when it may be sent. */
export async function scheduledRequestRefusal(platform: string, request: OperationRequest, stage: 'check' | 'write'): Promise<OperationRefusal | null> {
  const match = await resolveOperation(platform, request, stage === 'write' ? 'schedule-write' : 'schedule-check');
  return match.ok ? null : match.refusal;
}

/**
 * Registration-time check: every request the rule can send must be a schedulable operation of its platform (a
 * precondition read: of the platform it names).
 */
export async function scheduledRuleRefusal(rule: ScheduledRule): Promise<OperationRefusal | null> {
  let requests: ReturnType<typeof scheduledRuleRequests>;
  try {
    requests = scheduledRuleRequests(rule);
  } catch {
    return { reason: 'invalid_url' };
  }
  for (const { stage, request, platform } of requests) {
    const refusal = await scheduledRequestRefusal(platform ?? rule.platform, request, stage);
    if (refusal) return refusal;
  }
  return null;
}
