/**
 * How the scheduler paces one marketplace and how many items one of its writes may carry (QUICK-289).
 *
 * The web publishes it with the platform catalog (`PlatformCatalogEntry.scheduler`), so pacing changes ship with a
 * web deploy. It is a setting, not a trust boundary: which requests may be sent at all stays with the operation
 * table. The extension still clamps every value to `SCHEDULER_POLICY_LIMITS`, so no page can make the scheduler
 * faster or its writes larger than this build allows; a missing or malformed value takes the build's default.
 */
export interface PlatformSchedulerPolicy {
  /** Pause between two requests to the marketplace, ms. */
  gapMs?: number;
  /** Rules of this marketplace one pass attempts. Without it the marketplace shares the pass's global cap. */
  maxFiresPerPass?: number;
  /** First exponential backoff step after a rate limit or server error, ms (then doubled, up to `backoffMaxMs`). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Items one batched write may carry (rules whose template has a `batch`); 1 sends every item alone. */
  maxBatchItems?: number;
  /** How this marketplace's refusals are read (QUICK-289 PR 2); without it the scheduler's built-in status handling. */
  errors?: SchedulerErrorMap;
}

/**
 * What one refusal means for the scheduler:
 * - `transient`: nothing about the item; the rule retries soon (never counted) and the platform backs off;
 * - `item`: about this item only; one counted failure, the platform goes on (a refused batch is retried item by item);
 * - `auth`: the session or the account is refused (like 401/403): the platform is blocked for longer, the rule kept;
 * - `stop`: platform-wide; one counted strike and the platform stops for this pass (a terminal write status's default).
 */
export type SchedulerErrorOutcome = 'transient' | 'item' | 'auth' | 'stop';

export const SCHEDULER_ERROR_OUTCOMES: readonly SchedulerErrorOutcome[] = ['transient', 'item', 'auth', 'stop'];

export interface SchedulerErrorRule {
  /** The HTTP status it matches (400–599; a 2xx body error stays with the template's `platformError`). */
  status: number;
  /** Only an answer whose body carries this code (read at the map's `codePaths`); absent: any answer with the status. */
  code?: string | number;
  /** Only answers to this stage's requests; absent: both. */
  stage?: 'check' | 'write';
  outcome: SchedulerErrorOutcome;
  /**
   * A batched write answered so goes out again as two halves, and the platform's later batches of the pass are no
   * larger (cs.money code 134: too many items). One item is not split: it takes `outcome`.
   */
  halveBatch?: boolean;
}

export interface SchedulerErrorMap {
  /**
   * Where a refusal body carries its error codes, e.g. cs.money `{"errors":[{"code":134}]}` → `[['errors', 'code']]`.
   * A step that meets an array reads every row of it.
   */
  codePaths?: string[][];
  /** In order: the first rule that matches decides. */
  rules: SchedulerErrorRule[];
}

/** The decision of a matched rule, as the scheduler applies it. */
export interface SchedulerErrorVerdict {
  outcome: SchedulerErrorOutcome;
  halveBatch: boolean;
}

/** Bounds of an error map this build accepts; anything beyond is dropped, never an error. */
export const SCHEDULER_ERROR_MAP_LIMITS = {
  rules: 32,
  codePaths: 4,
  pathDepth: 6,
  segmentLength: 64,
  codeLength: 64,
  /** Codes read from one body at most. */
  codes: 32,
} as const;

export type ResolvedSchedulerPolicy = Required<Omit<PlatformSchedulerPolicy, 'errors'>> & {
  ownFireCap: boolean;
  /** Null without a (usable) map: the built-in handling. */
  errors: Required<SchedulerErrorMap> | null;
};

type NumericPolicyKey = Exclude<keyof PlatformSchedulerPolicy, 'errors'>;

interface PolicyLimit {
  min: number;
  max: number;
  default: number;
}

/** The bounds this build allows; the defaults are the scheduler's behaviour before QUICK-289. */
export const SCHEDULER_POLICY_LIMITS: Readonly<Record<NumericPolicyKey, PolicyLimit>> = {
  gapMs: { min: 500, max: 60_000, default: 500 },
  maxFiresPerPass: { min: 1, max: 200, default: 50 },
  backoffBaseMs: { min: 1_000, max: 60_000, default: 1_000 },
  backoffMaxMs: { min: 300_000, max: 3_600_000, default: 300_000 },
  maxBatchItems: { min: 1, max: 100, default: 1 },
};

function clampInteger(value: unknown, limit: PolicyLimit): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limit.default;
  return Math.min(limit.max, Math.max(limit.min, Math.floor(value)));
}

/** The policy the scheduler applies to one marketplace: every field present and within this build's bounds. */
export function resolveSchedulerPolicy(policy: unknown): ResolvedSchedulerPolicy {
  const source = isRecord(policy) ? policy : {};
  const backoffBaseMs = clampInteger(source['backoffBaseMs'], SCHEDULER_POLICY_LIMITS.backoffBaseMs);
  return {
    gapMs: clampInteger(source['gapMs'], SCHEDULER_POLICY_LIMITS.gapMs),
    maxFiresPerPass: clampInteger(source['maxFiresPerPass'], SCHEDULER_POLICY_LIMITS.maxFiresPerPass),
    ownFireCap: typeof source['maxFiresPerPass'] === 'number' && Number.isFinite(source['maxFiresPerPass']),
    backoffBaseMs,
    backoffMaxMs: Math.max(backoffBaseMs, clampInteger(source['backoffMaxMs'], SCHEDULER_POLICY_LIMITS.backoffMaxMs)),
    maxBatchItems: clampInteger(source['maxBatchItems'], SCHEDULER_POLICY_LIMITS.maxBatchItems),
    errors: resolveErrorMap(source['errors']),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCode(value: unknown): value is string | number {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.length > 0 && value.length <= SCHEDULER_ERROR_MAP_LIMITS.codeLength)
  );
}

function resolveCodePath(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > SCHEDULER_ERROR_MAP_LIMITS.pathDepth) return null;
  const valid = value.every(
    (segment) =>
      typeof segment === 'string' && segment.length > 0 && segment.length <= SCHEDULER_ERROR_MAP_LIMITS.segmentLength
  );
  return valid ? (value as string[]) : null;
}

/** A rule as this build applies it, or null for a malformed one (dropped alone: the map's other rules still hold). */
function resolveErrorRule(value: unknown): SchedulerErrorRule | null {
  if (!isRecord(value)) return null;
  const { status, code, stage, outcome, halveBatch } = value;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return null;
  if (!SCHEDULER_ERROR_OUTCOMES.some((known) => known === outcome)) return null;
  if (code !== undefined && !isCode(code)) return null;
  if (stage !== undefined && stage !== 'check' && stage !== 'write') return null;
  return {
    status,
    outcome: outcome as SchedulerErrorOutcome,
    ...(code !== undefined ? { code } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(halveBatch === true ? { halveBatch: true } : {}),
  };
}

/** The usable part of a page-supplied error map (QUICK-289 PR 2), bounded by `SCHEDULER_ERROR_MAP_LIMITS`. */
export function resolveErrorMap(value: unknown): Required<SchedulerErrorMap> | null {
  if (!isRecord(value) || !Array.isArray(value['rules'])) return null;
  const rules = value['rules']
    .slice(0, SCHEDULER_ERROR_MAP_LIMITS.rules)
    .map(resolveErrorRule)
    .filter((rule): rule is SchedulerErrorRule => rule !== null);
  if (!rules.length) return null;
  const paths = Array.isArray(value['codePaths'])
    ? value['codePaths'].slice(0, SCHEDULER_ERROR_MAP_LIMITS.codePaths)
    : [];
  const codePaths = paths.map(resolveCodePath).filter((path): path is string[] => path !== null);
  return { codePaths, rules };
}

/** Every code at `path`, reading each row of an array met on the way (bounded by `out`'s cap). */
function collectCodes(value: unknown, path: readonly string[], out: Array<string | number>): void {
  if (out.length >= SCHEDULER_ERROR_MAP_LIMITS.codes) return;
  if (Array.isArray(value)) {
    for (const row of value.slice(0, SCHEDULER_ERROR_MAP_LIMITS.codes)) collectCodes(row, path, out);
    return;
  }
  if (path.length === 0) {
    if (isCode(value)) out.push(value);
    return;
  }
  // Own keys only, as `platformOperations` reads them: Object.hasOwn is not in the server's ES lib.
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, path[0])) return;
  collectCodes(value[path[0]], path.slice(1), out);
}

/** The error codes a refusal body carries at the map's paths. */
export function schedulerErrorCodes(map: Pick<SchedulerErrorMap, 'codePaths'>, data: unknown): Array<string | number> {
  const out: Array<string | number> = [];
  for (const path of map.codePaths ?? []) collectCodes(data, path, out);
  return out;
}

/**
 * How a platform's error map reads one answer: the first rule whose status, stage and (when it names one) code match;
 * null when there is no map or no rule matches, and the scheduler's built-in handling applies.
 */
export function classifySchedulerError(
  map: Required<SchedulerErrorMap> | null,
  stage: 'check' | 'write',
  status: number,
  data: unknown
): SchedulerErrorVerdict | null {
  if (!map) return null;
  let codes: Array<string | number> | undefined;
  for (const rule of map.rules) {
    if (rule.status !== status || (rule.stage !== undefined && rule.stage !== stage)) continue;
    if (rule.code !== undefined) {
      codes ??= schedulerErrorCodes(map, data);
      // A numeric code matches its string form as well: marketplaces are not consistent about it.
      if (!codes.some((code) => String(code) === String(rule.code))) continue;
    }
    return { outcome: rule.outcome, halveBatch: rule.halveBatch === true };
  }
  return null;
}

/** The n-th consecutive backoff step (n ≥ 1) under a resolved policy. */
export function schedulerBackoffMs(
  policy: Pick<ResolvedSchedulerPolicy, 'backoffBaseMs' | 'backoffMaxMs'>,
  step: number
): number {
  return Math.min(policy.backoffMaxMs, 2 ** Math.max(1, step) * policy.backoffBaseMs);
}

/** Where a batched write's body takes its items, joined by commas. */
export const BATCH_ITEMS_TOKEN = '__ITEMS__';

/**
 * How several rules' writes become one request (cs.money `POST /1.0/market/sell-orders` takes `{"items":[…]}`).
 * `item` is the rule's own item, with the same tokens as `bodyTemplate`; `wrapper` carries `__ITEMS__` once.
 * A rule is batched only when `wrapper` with its `item` is exactly its `bodyTemplate`, so a batch sends what the
 * rules would have sent alone, together.
 */
export interface RepriceBatch {
  /** Rules with the same key (and the same URL, method, headers and wrapper) may share a write. */
  key: string;
  wrapper: string;
  item: string;
}

interface BatchableTemplate {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyTemplate: string;
  batch?: RepriceBatch;
}

/** The write's body with `items` in place of `__ITEMS__`; a wrapper without exactly one token is returned as is. */
export function composeBatchBody(wrapper: string, items: readonly string[]): string {
  const parts = wrapper.split(BATCH_ITEMS_TOKEN);
  return parts.length === 2 ? `${parts[0]}${items.join(',')}${parts[1]}` : wrapper;
}

/**
 * The group a rule's write may share, or null when it is written alone: no or a malformed `batch`, or one whose
 * wrapper and item do not rebuild the rule's own body (`filledBody` and `filledItem` are both with the run's tokens
 * replaced).
 */
export function batchGroupKey(template: BatchableTemplate, filledBody: string, filledItem: string): string | null {
  const { batch } = template;
  if (
    !batch ||
    typeof batch.key !== 'string' ||
    !batch.key ||
    typeof batch.wrapper !== 'string' ||
    typeof batch.item !== 'string'
  )
    return null;
  if (
    batch.wrapper.split(BATCH_ITEMS_TOKEN).length !== 2 ||
    composeBatchBody(batch.wrapper, [filledItem]) !== filledBody
  )
    return null;
  const headers = Object.entries(template.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([batch.key, template.url, template.method, headers, batch.wrapper]);
}
