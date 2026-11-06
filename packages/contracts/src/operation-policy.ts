import type {
  OperationMatch,
  OperationPurpose,
  OperationRefusal,
  OperationRefusalReason,
  OperationRequest,
  OperationTable,
  PlatformOperation,
} from './operation-types';
import { PLATFORM_OPERATION_TABLE } from './platform-operations';

/** Typed path parameters: one segment each, never `/`, `%` (no encoded slash or dot) or an empty value. */
const PATH_PARAMS: Readonly<Record<string, RegExp>> = {
  int: /^[0-9]{1,20}$/,
  id: /^[A-Za-z0-9_-]{1,128}$/,
};

/** Order in which a request is compared with an operation; the refusal reports the furthest stage reached. */
const STAGES: readonly OperationRefusalReason[] = ['host', 'method', 'path', 'query', 'header', 'body', 'graphql'];

const MAX_DETAIL = 64;

const TABLE: OperationTable = PLATFORM_OPERATION_TABLE;

function refusal(reason: OperationRefusalReason, detail?: string): OperationRefusal {
  return detail === undefined ? { reason } : { reason, detail: detail.slice(0, MAX_DETAIL) };
}

/** The operations of a platform id in `table` (default: the bundled one); empty for an unknown id. */
export function platformOperations(platform: string, table: OperationTable = TABLE): readonly PlatformOperation[] {
  // Own keys only (no `constructor` / `__proto__` lookups); Object.hasOwn is not in the server's ES lib.
  return Object.prototype.hasOwnProperty.call(table, platform) ? (table[platform] ?? []) : [];
}

/** One operation by id (internal ones included) in `table` (default: the bundled one), or undefined. */
export function findPlatformOperation(
  platform: string,
  id: string,
  table: OperationTable = TABLE
): PlatformOperation | undefined {
  return platformOperations(platform, table).find((operation) => operation.id === id);
}

/** Whether `pattern` is a path pattern the matcher reads: absolute, literal segments or `{name:int|id}` ones. */
export function isOperationPathPattern(pattern: string): boolean {
  if (!pattern.startsWith('/') || pattern.length > 512) return false;
  return pattern
    .split('/')
    .slice(1)
    .every((segment) => {
      const param = /^\{[A-Za-z]+:([a-z]+)\}$/.exec(segment);
      if (param) return Object.prototype.hasOwnProperty.call(PATH_PARAMS, param[1] ?? '');
      // A literal segment as `URL.pathname` keeps it: no dot segment, escape, query or fragment character.
      return segment !== '.' && segment !== '..' && /^[A-Za-z0-9._~!$&'()*+,;=:@-]*$/.test(segment);
    });
}

/** https, no credentials, default port and no fragment; null otherwise. */
function parseOperationUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
}

/** Anchored, segment-by-segment path match; `{name:type}` segments are typed parameters. */
export function matchOperationPath(pattern: string, pathname: string): boolean {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    const value = actual[index] ?? '';
    const param = /^\{[A-Za-z]+:([a-z]+)\}$/.exec(segment);
    if (!param) return segment === value;
    const type = PATH_PARAMS[param[1] ?? ''];
    return type !== undefined && type.test(value);
  });
}

function queryRefusal(operation: PlatformOperation, url: URL): OperationRefusal | null {
  for (const key of new Set(url.searchParams.keys())) {
    if (!operation.query?.includes(key)) return refusal('query', key);
  }
  return null;
}

function contentType(headers: Readonly<Record<string, string>> | undefined): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type');
  return entry?.[1].toLowerCase();
}

function headerRefusal(operation: PlatformOperation, request: OperationRequest): OperationRefusal | null {
  if (request.headers !== undefined && (typeof request.headers !== 'object' || request.headers === null))
    return refusal('header');
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const lower = name.toLowerCase();
    if (typeof value !== 'string' || !operation.headers?.includes(lower)) return refusal('header', lower);
  }
  return null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function bodyRefusal(operation: PlatformOperation, request: OperationRequest): OperationRefusal | null {
  const type = contentType(request.headers);
  const { body } = request;
  if (body !== undefined && typeof body !== 'string') return refusal('body');
  switch (operation.body) {
    case 'none':
      return body === undefined || body === '' ? null : refusal('body', 'none');
    case 'json': {
      const parsed = body === undefined ? undefined : parseJson(body);
      if (typeof parsed !== 'object' || parsed === null) return refusal('body', 'json');
      return type === undefined || type.includes('application/json') ? null : refusal('body', 'content-type');
    }
    case 'form':
      if (body === undefined || body === '' || parseJson(body) !== undefined) return refusal('body', 'form');
      return type?.includes('application/x-www-form-urlencoded') ? null : refusal('body', 'content-type');
  }
}

// ─── GraphQL: which operations a document defines and their root fields ─────────────────────────────

type GraphqlToken = { kind: 'name' | 'punct' | 'value'; text: string };

const GRAPHQL_PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

/** Lexes a GraphQL document; null on anything outside the GraphQL grammar's tokens. */
function lexGraphql(source: string): GraphqlToken[] | null {
  const tokens: GraphqlToken[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? '';
    if (/[\s,]/.test(char)) {
      i++;
    } else if (char === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
    } else if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', text: '...' });
      i += 3;
    } else if (GRAPHQL_PUNCTUATORS.has(char)) {
      tokens.push({ kind: 'punct', text: char });
      i++;
    } else if (source.startsWith('"""', i)) {
      // A block string ends at the first `"""` that is not escaped as `\"""` (its only escape), as the server reads it.
      let end = i + 3;
      while (end < source.length && !source.startsWith('"""', end)) end += source.startsWith('\\"""', end) ? 4 : 1;
      if (end >= source.length) return null;
      tokens.push({ kind: 'value', text: 'string' });
      i = end + 3;
    } else if (char === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\n' || source[i] === '\r') return null;
        i += source[i] === '\\' ? 2 : 1;
      }
      if (i >= source.length) return null;
      tokens.push({ kind: 'value', text: 'string' });
      i++;
    } else {
      const match = /^(?:[_A-Za-z][_0-9A-Za-z]*|-?[0-9][0-9.eE+-]*)/.exec(source.slice(i));
      if (!match) return null;
      tokens.push({ kind: /^[_A-Za-z]/.test(match[0]) ? 'name' : 'value', text: match[0] });
      i += match[0].length;
    }
  }
  return tokens;
}

/** Index after the group opened at `start` (`(`/`[`/`{`), or -1 when unbalanced. */
function skipGroup(tokens: readonly GraphqlToken[], start: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.kind !== 'punct') continue;
    const close = pairs[token.text];
    if (close) stack.push(close);
    else if (token.text === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    } else if (token.text === ')' || token.text === ']' || token.text === '}') return -1;
  }
  return -1;
}

/** Skips `@name(args)` directives; returns the next index. */
function skipDirectives(tokens: readonly GraphqlToken[], start: number): number {
  let i = start;
  while (tokens[i]?.text === '@' && tokens[i + 1]?.kind === 'name') {
    i += 2;
    if (tokens[i]?.text === '(') {
      i = skipGroup(tokens, i);
      if (i === -1) return -1;
    }
  }
  return i;
}

interface GraphqlOperationSummary {
  type: string;
  name: string | null;
  fields: string[];
}

/**
 * Root field names (aliases resolved) of the selection set opened at `start`, and the index after it.
 * Null when it cannot be read or when the root selection holds a fragment spread or inline fragment.
 */
function rootFields(tokens: readonly GraphqlToken[], start: number): { fields: string[]; next: number } | null {
  const fields: string[] = [];
  let i = start + 1;
  while (tokens[i] && tokens[i]?.text !== '}') {
    if (tokens[i]?.kind !== 'name') return null;
    let field = tokens[i]?.text ?? '';
    i++;
    if (tokens[i]?.text === ':') {
      if (tokens[i + 1]?.kind !== 'name') return null;
      field = tokens[i + 1]?.text ?? '';
      i += 2;
    }
    fields.push(field);
    if (tokens[i]?.text === '(') i = skipGroup(tokens, i);
    if (i === -1) return null;
    i = skipDirectives(tokens, i);
    if (i === -1) return null;
    if (tokens[i]?.text === '{') i = skipGroup(tokens, i);
    if (i === -1) return null;
  }
  return tokens[i]?.text === '}' ? { fields, next: i + 1 } : null;
}

/** The operations a GraphQL document defines (fragments skipped); null when it cannot be read. */
export function graphqlOperations(document: string): GraphqlOperationSummary[] | null {
  const tokens = lexGraphql(document);
  if (!tokens) return null;
  const operations: GraphqlOperationSummary[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token?.text === 'fragment' && token.kind === 'name') {
      const open = tokens.findIndex((candidate, index) => index > i && candidate.text === '{');
      i = open === -1 ? -1 : skipGroup(tokens, open);
      if (i === -1) return null;
      continue;
    }
    let type = 'query';
    let name: string | null = null;
    if (
      token?.kind === 'name' &&
      (token.text === 'query' || token.text === 'mutation' || token.text === 'subscription')
    ) {
      type = token.text;
      i++;
      if (tokens[i]?.kind === 'name') name = tokens[i++]?.text ?? null;
      if (tokens[i]?.text === '(') i = skipGroup(tokens, i);
      if (i === -1) return null;
      i = skipDirectives(tokens, i);
      if (i === -1) return null;
    }
    if (tokens[i]?.text !== '{') return null;
    const root = rootFields(tokens, i);
    if (!root) return null;
    operations.push({ type, name, fields: root.fields });
    i = root.next;
  }
  return operations;
}

function graphqlRefusal(operation: PlatformOperation, request: OperationRequest): OperationRefusal | null {
  const spec = operation.graphql;
  if (!spec) return null;
  const body = typeof request.body === 'string' ? parseJson(request.body) : undefined;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refusal('graphql');
  const record = body as Record<string, unknown>;
  // `extensions` (persisted queries) could run a stored document instead of the one checked here.
  if (Object.keys(record).some((key) => key !== 'query' && key !== 'variables' && key !== 'operationName'))
    return refusal('graphql', 'key');
  if (record['operationName'] !== spec.name || typeof record['query'] !== 'string')
    return refusal('graphql', 'operationName');
  const operations = graphqlOperations(record['query']);
  const only = operations?.length === 1 ? operations[0] : undefined;
  if (!only || only.type !== spec.type || only.name !== spec.name) return refusal('graphql', 'document');
  if (only.fields.length === 0 || only.fields.some((field) => !spec.fields.includes(field)))
    return refusal('graphql', 'field');
  return null;
}

/** Null when `request` is an instance of `operation`, else the first mismatch. */
function operationRefusal(operation: PlatformOperation, url: URL, request: OperationRequest): OperationRefusal | null {
  if (url.host !== operation.host) return refusal('host');
  if (typeof request.method !== 'string' || request.method.toUpperCase() !== operation.method) return refusal('method');
  if (!matchOperationPath(operation.path, url.pathname)) return refusal('path');
  return (
    queryRefusal(operation, url) ??
    headerRefusal(operation, request) ??
    bodyRefusal(operation, request) ??
    graphqlRefusal(operation, request)
  );
}

function allowedFor(operation: PlatformOperation, purpose: OperationPurpose): boolean {
  if (operation.internal) return purpose === 'internal';
  switch (purpose) {
    case 'page':
      return true;
    case 'login':
      return !operation.mutates;
    case 'schedule-check':
      return operation.schedule === 'check' && !operation.mutates;
    case 'schedule-write':
      return operation.schedule === 'write' && operation.mutates;
    case 'internal':
      return false;
  }
}

export interface MatchOperationOptions {
  /** Defaults to `page`. */
  purpose?: OperationPurpose;
  /** A narrower set of ids (a catalog entry's `operations`); it can only remove operations of the table. */
  allowedIds?: readonly string[];
  /** The table to match against; defaults to the bundled `PLATFORM_OPERATIONS`. */
  table?: OperationTable;
}

/**
 * Matches a request against the operations of `platform` (bundled unless `options.table`): host, method, path, query keys, header
 * names, body kind and (GraphQL) the one operation of the document. Pure; never throws.
 */
export function matchPlatformOperation(
  platform: string,
  request: OperationRequest,
  options: MatchOperationOptions = {}
): OperationMatch {
  const purpose = options.purpose ?? 'page';
  const operations = platformOperations(platform, options.table);
  if (!operations.length) return { ok: false, refusal: refusal('unknown_platform') };
  const url = parseOperationUrl(request?.url);
  if (!url) return { ok: false, refusal: refusal('invalid_url') };
  let closest: OperationRefusal = refusal('host');
  let excluded: OperationRefusal | null = null;
  for (const operation of operations) {
    const mismatch = operationRefusal(operation, url, request);
    if (mismatch) {
      if (STAGES.indexOf(mismatch.reason) > STAGES.indexOf(closest.reason)) closest = mismatch;
      continue;
    }
    if (!allowedFor(operation, purpose)) {
      excluded ??= refusal('purpose', operation.id);
      continue;
    }
    if (options.allowedIds && !options.allowedIds.includes(operation.id)) {
      excluded = refusal('narrowed', operation.id);
      continue;
    }
    return { ok: true, operation };
  }
  return { ok: false, refusal: excluded ?? closest };
}

/**
 * Whether the browser may follow an operation's redirects (QUICK-292): only a GET read that declares `redirects` and
 * carries no background auth header (Steam's profile and history reads, the cs.money market page). Any other operation
 * is fetched with `redirect: 'manual'`, so a 3xx goes no further than its own answer. A hop cannot be checked before
 * the browser follows it: an extension's fetch hides an opaque redirect's Location too.
 */
export function followsOperationRedirects(operation: PlatformOperation): boolean {
  return (
    operation.method === 'GET' &&
    !operation.mutates &&
    !operation.internal &&
    !operation.auth &&
    (operation.redirects?.length ?? 0) > 0
  );
}

/**
 * Whether a followed redirect may be answered: the final URL stays on the operation's host and lands on
 * one of its declared `redirects` paths, or is itself a non-mutating GET operation of the platform.
 */
export function isAllowedOperationRedirect(
  platform: string,
  operation: PlatformOperation,
  finalUrl: string,
  table: OperationTable = TABLE
): boolean {
  const url = parseOperationUrl(finalUrl);
  if (!url || url.host !== operation.host) return false;
  if (operation.redirects?.some((pattern) => matchOperationPath(pattern, url.pathname))) return true;
  return platformOperations(platform, table).some(
    (candidate) =>
      !candidate.internal &&
      !candidate.mutates &&
      candidate.method === 'GET' &&
      candidate.host === url.host &&
      matchOperationPath(candidate.path, url.pathname) &&
      queryRefusal(candidate, url) === null
  );
}

/** `operation_refused:<reason>` for `proxy_response.error`. */
export function operationRefusedError(refused: OperationRefusal): string {
  return `operation_refused:${refused.reason}`;
}
