/** Page rules occupy a separate namespace from background-owned rules (including HaloSkins 1014). */
export const PAGE_DNR_MIN_ID = 2000;
export const PAGE_DNR_MAX_ID = 2999;
export const PAGE_DNR_MAX_RULES = 50;
/** Most entries in `initiatorDomains` / `excludedInitiatorDomains`, also after the T5 normalisation. */
export const PAGE_DNR_MAX_DOMAINS = 10;

export type DnrRejectionReason =
  | 'invalid_shape'
  | 'id_out_of_range'
  | 'duplicate_id'
  | 'action_not_allowed'
  | 'header_not_allowed'
  | 'operation_not_allowed'
  | 'value_not_allowed'
  | 'url_filter_not_allowed'
  | 'host_not_granted'
  | 'resource_type_not_allowed'
  | 'condition_not_allowed'
  | 'too_many_rules'
  | 'installation_failed';

export interface DnrRejection {
  /** Null for a malformed/missing id or a rejection of the entire payload. */
  id: number | null;
  reason: DnrRejectionReason;
}

export interface DnrRulesResult {
  status: 'ok' | 'partial' | 'rejected' | 'skipped';
  /** Only the page rules installed by this request; never background rule data. */
  installedIds: number[];
  rejected: DnrRejection[];
  reason?: 'no rules' | 'api_unavailable';
  apiAvailable?: boolean;
}

type RequestHeader = { header: string; operation: 'set'; value: string } | { header: string; operation: 'remove' };
type ResourceType = 'xmlhttprequest' | 'other';

export interface PageDnrRule {
  id: number;
  priority?: number;
  action: { type: 'modifyHeaders'; requestHeaders: RequestHeader[] };
  condition: {
    urlFilter: string;
    resourceTypes: ResourceType[];
    /** Always exactly the extension's own host on accepted rules (QUICK-291), whatever the page sent. */
    initiatorDomains?: string[];
    /** Always set on accepted rules: covers the request host (T5), see `excludedInitiatorsFor`. */
    excludedInitiatorDomains?: string[];
  };
}

// Derived from the web platform clients. No response headers or credential-bearing headers.
const HEADER_OPERATIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['origin', ['set', 'remove']],
  ['referer', ['set']],
  ['sec-fetch-site', ['set']],
  ['sec-fetch-mode', ['set']],
  ['sec-fetch-dest', ['set']],
  ['sec-ch-ua', ['set']],
  ['sec-ch-ua-mobile', ['set']],
  ['sec-ch-ua-platform', ['set']],
  ['accept-language', ['set']],
  ['content-language', ['set']],
  ['x-client-app', ['set']],
]);
const CONDITION_KEYS = ['urlFilter', 'resourceTypes', 'initiatorDomains', 'excludedInitiatorDomains'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key));
}

/** ASCII DNS labels, no URL syntax, wildcard, trailing dot, IP literal or numeric IP shorthand. */
function isHostname(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253 || /[^a-z0-9.-]/.test(value)) return false;
  const labels = value.split('.');
  // No Array.prototype.at: contracts are type-checked by every consumer, some with an ES2021 lib.
  const last = labels[labels.length - 1] ?? '';
  return (
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /[a-z]/.test(last) &&
    !/^0x[0-9a-f]+$/.test(last)
  );
}

function isDomainList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= PAGE_DNR_MAX_DOMAINS &&
    Array.from(value).every(isHostname)
  );
}

/**
 * The extension's own host as `runtime.getURL('/')` names it: Chrome's extension id, Firefox's per-install UUID (which
 * may be all digits and hyphens). One label, never a site's domain, so the pinned initiator cannot cover a web page.
 */
function isExtensionHost(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

/** Last two labels. Under a multi-label public suffix (co.uk) this over-excludes, which only narrows the rule. */
function registrableDomain(host: string): string {
  return host.split('.').slice(-2).join('.');
}

/**
 * T5: a page rule must not rewrite the marketplace's own tab (its XHRs keep their real Origin / Sec-Fetch-* / Referer),
 * whatever web build sent it. A list that already covers the request host (a domain list includes subdomains, as
 * QUICK-173's do) is kept as sent; otherwise the host and its registrable domain are appended. No duplicates; null when
 * the merged list would exceed PAGE_DNR_MAX_DOMAINS. The extension's own requests come from its extension host and still match.
 */
function excludedInitiatorsFor(host: string, sent: readonly string[] = []): string[] | null {
  const domains = [...new Set(sent)];
  if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    for (const domain of [host, registrableDomain(host)]) if (!domains.includes(domain)) domains.push(domain);
  }
  return domains.length <= PAGE_DNR_MAX_DOMAINS ? domains : null;
}

type AcceptedRule = { rule: PageDnrRule; host: string };

function validateRule(input: unknown, extensionHost: string): AcceptedRule | DnrRejectionReason {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ['id', 'priority', 'action', 'condition'])) return 'invalid_shape';
  const { id, priority, action, condition } = input;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < PAGE_DNR_MIN_ID || id > PAGE_DNR_MAX_ID)
    return 'id_out_of_range';
  if (
    'priority' in input &&
    (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 10)
  )
    return 'invalid_shape';
  if (!isPlainObject(action) || !isPlainObject(condition)) return 'invalid_shape';
  if (action['type'] !== 'modifyHeaders' || !hasOnlyKeys(action, ['type', 'requestHeaders']))
    return 'action_not_allowed';
  const headers = action['requestHeaders'];
  if (!Array.isArray(headers) || headers.length === 0 || headers.length > HEADER_OPERATIONS.size)
    return 'invalid_shape';
  const requestHeaders: RequestHeader[] = [];
  const seenHeaders = new Set<string>();
  for (const entry of headers) {
    if (!isPlainObject(entry) || !hasOnlyKeys(entry, ['header', 'operation', 'value'])) return 'invalid_shape';
    const { header, operation, value } = entry;
    if (typeof header !== 'string') return 'header_not_allowed';
    const name = header.toLowerCase();
    const operations = HEADER_OPERATIONS.get(name);
    if (!operations || seenHeaders.has(name)) return 'header_not_allowed';
    if (typeof operation !== 'string' || !operations.includes(operation)) return 'operation_not_allowed';
    if (operation === 'set') {
      if (
        typeof value !== 'string' ||
        value.length > 512 ||
        value.includes('\r') ||
        value.includes('\n') ||
        value.includes('\0')
      )
        return 'value_not_allowed';
      requestHeaders.push({ header, operation, value });
    } else {
      if ('value' in entry) return 'value_not_allowed';
      requestHeaders.push({ header, operation: 'remove' });
    }
    seenHeaders.add(name);
  }
  if (!hasOnlyKeys(condition, CONDITION_KEYS)) return 'condition_not_allowed';
  const urlFilter = condition['urlFilter'];
  if (typeof urlFilter !== 'string' || urlFilter.length > 2048) return 'url_filter_not_allowed';
  // A literal leading URL and slash fix the host boundary. Only simple literal paths are needed by
  // the web today; DNR metacharacters, URL credentials, ports, escapes and query syntax are excluded.
  const match = /^\|https:\/\/([^/]+)(\/[a-zA-Z0-9/._~-]*)$/.exec(urlFilter);
  if (match?.[0] !== urlFilter) return 'url_filter_not_allowed';
  const host = match?.[1];
  if (
    !isHostname(host) ||
    host === 'quicktrade.skin' ||
    host.endsWith('.quicktrade.skin') ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  )
    return 'url_filter_not_allowed';
  const resourceTypes = condition['resourceTypes'];
  if (!Array.isArray(resourceTypes) || resourceTypes.length === 0 || resourceTypes.length > 2)
    return 'resource_type_not_allowed';
  const resources: ResourceType[] = [];
  for (const resource of resourceTypes) {
    if ((resource !== 'xmlhttprequest' && resource !== 'other') || resources.includes(resource))
      return 'resource_type_not_allowed';
    resources.push(resource);
  }
  const domains: Pick<PageDnrRule['condition'], 'initiatorDomains' | 'excludedInitiatorDomains'> = {};
  for (const key of ['initiatorDomains', 'excludedInitiatorDomains'] as const) {
    if (!(key in condition)) continue;
    const value = condition[key];
    if (!isDomainList(value)) return 'condition_not_allowed';
    domains[key] = [...value];
  }
  // QUICK-291: the rule rewrites only the extension's own (background) requests, whatever list the page sent. Without
  // it the browser also rewrote the requests any other page or extension makes to that marketplace. No usable host,
  // no rule: never an unrestricted one.
  if (!isExtensionHost(extensionHost)) return 'condition_not_allowed';
  domains.initiatorDomains = [extensionHost];
  const excludedInitiatorDomains = excludedInitiatorsFor(host, domains.excludedInitiatorDomains);
  if (!excludedInitiatorDomains) return 'condition_not_allowed';
  domains.excludedInitiatorDomains = excludedInitiatorDomains;
  return {
    host,
    // Copy validated fields: never hand the page's object directly to the browser API.
    rule: {
      id,
      ...(typeof priority === 'number' ? { priority } : {}),
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { urlFilter, resourceTypes: resources, ...domains },
    },
  };
}

/**
 * Pure syntax/policy validation plus the initiator normalisation: `extensionHost` (the hostname of
 * `runtime.getURL('/')`) becomes every accepted rule's only initiator (QUICK-291) and T5 excludes the request host's
 * own tab (`excludedInitiatorsFor`). The extension MUST check current host grants before a page install.
 */
export function validatePageDnrRules(
  payload: unknown,
  extensionHost: string
): { accepted: AcceptedRule[]; rejected: DnrRejection[] } {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, ['rules']) || !Array.isArray(payload['rules'])) {
    return { accepted: [], rejected: [{ id: null, reason: 'invalid_shape' }] };
  }
  if (payload['rules'].length > PAGE_DNR_MAX_RULES) {
    return { accepted: [], rejected: [{ id: null, reason: 'too_many_rules' }] };
  }
  const accepted: AcceptedRule[] = [];
  const rejected: DnrRejection[] = [];
  const seenIds = new Set<number>();
  for (const input of payload['rules']) {
    const result = validateRule(input, extensionHost);
    const id =
      isPlainObject(input) && typeof input['id'] === 'number' && Number.isInteger(input['id']) ? input['id'] : null;
    if (typeof result === 'string') rejected.push({ id, reason: result });
    else if (seenIds.has(result.rule.id)) rejected.push({ id, reason: 'duplicate_id' });
    else {
      seenIds.add(result.rule.id);
      accepted.push(result);
    }
  }
  return { accepted, rejected };
}
