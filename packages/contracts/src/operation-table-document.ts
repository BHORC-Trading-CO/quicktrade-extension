/**
 * Signed operation table: request rules for already bundled, granted origins that the web can deliver to the
 * extension without an extension release.
 *
 * The operator signs a document `{ version, issuedAt, expiresAt, table }` (ECDSA P-256 / SHA-256) with a private key
 * that never enters the repository; the web serves the signed artifact (`apps/web/public/operations/`) and sends it
 * with `set_operation_table` to an extension that announces `signed_operation_table`. The extension verifies the
 * signature over the exact UTF-8 bytes of `document` with the public key bundled in its source, then parses and
 * validates the document here. A platform present in the signed table replaces that platform's bundled operations.
 *
 * What a signed table cannot do:
 *  - add a new marketplace or origin: a platform key must be a bundled connection (`PLATFORM_CONNECTION_TABLE`) and
 *    every operation host one of that platform's bundled origins (`platformOperationHosts`; Steam operations: the
 *    hosts of the bundled Steam allowlist), refused as `unknown_platform` / `unbundled_host`. The extension also
 *    checks host permission at request time (`browser.permissions.contains`). A new marketplace or origin needs an
 *    extension release;
 *  - remove a platform: there are no tombstones. A platform the signed table does not name keeps its bundled
 *    operations; to switch one off, sign it as an empty list (every request of it is then refused);
 *  - live longer than `OPERATION_TABLE_MAX_LIFETIME_MS`: `expiresAt` is required (re-sign before it passes; the
 *    extension falls back to the bundled table after it).
 *
 * The signature is the trust root, but some limits hold whatever it says (a compromised signing key or web app must
 * not turn the extension into a proxy on the app's own origin or a Steam account): see `OPERATION_TABLE_FORBIDDEN_HOSTS`,
 * the bundled Steam allowlist (`steam-operation-allowlist.ts`) and the `auth` scope rule. Pure, no browser APIs; also
 * used by the signing script so a document the extension would refuse is never signed.
 */
import { isOperationPathPattern } from './operation-policy';
import type { OperationTable, PlatformOperation } from './operation-types';
import { PLATFORM_CONNECTION_TABLE } from './platform-connections';
import {
  STEAM_SIGNED_OPERATION_ALLOWLIST,
  isAllowedSteamSignedOperation,
  isSteamHost,
} from './steam-operation-allowlist';

/**
 * The anti-rollback floor bundled into the extension: a signed table of a lower version is refused. Signing never
 * touches it (that would need a release per table). Raise it only in an extension release, at most to the committed
 * artifact's version, so fresh installs of that release never accept an older signed table; the artifact tests fail
 * if the artifact falls below it.
 */
export const BUNDLED_OPERATION_TABLE_VERSION = 2;

/** What travels: the exact signed string and its signature (IEEE P1363 `r || s`, 64 bytes, base64). */
export interface SignedOperationTable {
  document: string;
  signature: string;
}

export interface OperationTableDocument {
  /** Monotonic: the extension refuses a version lower than the highest it accepted or than the bundled floor. */
  version: number;
  /** Unix ms when it was signed. */
  issuedAt: number;
  /**
   * Unix ms after which the extension stops using it (falls back to the bundled table). Required, at most
   * `OPERATION_TABLE_MAX_LIFETIME_MS` after `issuedAt`.
   */
  expiresAt: number;
  table: OperationTable;
}

export type OperationTableRefusalReason =
  /** The build carries no real public key: signed tables are off, the bundled table applies. */
  | 'disabled'
  /** Not `{ document, signature }` strings, or a signature that is not 64 base64-encoded bytes. */
  | 'malformed'
  | 'too_large'
  | 'signature'
  | 'json'
  /** A field outside the document format (unknown key, wrong type or value). */
  | 'shape'
  /** An operation on the web app's own hosts, localhost or an IP address. */
  | 'forbidden_host'
  /** A platform key that is not a bundled connection (`PLATFORM_CONNECTION_TABLE`). */
  | 'unknown_platform'
  /** An operation host outside its platform's bundled origins (or, on Steam, the bundled Steam allowlist hosts). */
  | 'unbundled_host'
  /** An operation on a Steam host outside the bundled allowlist (`steam-operation-allowlist.ts`). */
  | 'steam_operation'
  /** An `auth` cookie outside the operation's own site or on a public suffix, or a header the page could also send. */
  | 'auth_scope'
  /** `auth.refresh.operation` does not name an internal operation of the same platform and site. */
  | 'auth_refresh'
  | 'expired'
  /** `expiresAt` more than `OPERATION_TABLE_MAX_LIFETIME_MS` after `issuedAt`. */
  | 'lifetime'
  /** `issuedAt` later than the extension's clock allows (`OPERATION_TABLE_CLOCK_SKEW_MS`). */
  | 'not_yet_valid'
  /** Lower than the highest version accepted or the bundled floor. */
  | 'rollback'
  /** The same version as the accepted one with different bytes. */
  | 'version_conflict'
  | 'storage';

/** Why a signed table was refused. `detail` is a field path or an operation id, never a value. */
export interface OperationTableRefusal {
  reason: OperationTableRefusalReason;
  detail?: string;
}

export type OperationTableParse =
  | { ok: true; document: OperationTableDocument }
  | { ok: false; refusal: OperationTableRefusal };

export const OPERATION_TABLE_LIMITS = {
  /** Characters of `document` (the bundled table serializes to roughly 60 000). */
  documentLength: 1_048_576,
  platforms: 64,
  operationsPerPlatform: 256,
  listLength: 64,
  stringLength: 512,
} as const;

/**
 * Hosts the signed table may never name (exact or any subdomain): the web app itself (the extension would proxy the
 * user's own session to it) and loopback. IP literals and single-label hosts are refused as well.
 */
export const OPERATION_TABLE_FORBIDDEN_HOSTS: readonly string[] = ['quicktrade.skin', 'localhost'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest a signed table may live (`expiresAt - issuedAt`); the signing script defaults to 30 days. */
export const OPERATION_TABLE_MAX_LIFETIME_MS = 60 * DAY_MS;

/**
 * How far `issuedAt` may lie ahead of the extension's clock. Without this bound a document dated into the future
 * would outlive `OPERATION_TABLE_MAX_LIFETIME_MS`.
 */
export const OPERATION_TABLE_CLOCK_SKEW_MS = DAY_MS;

/**
 * Public suffixes an `auth` cookie URL may never name (a cookie there would be shared by unrelated sites). A short,
 * hand-kept list, not the full Public Suffix List: with the two-label minimum it covers the multi-label suffixes a
 * marketplace host is plausibly under. Extend it when a marketplace lives under another such suffix.
 */
export const OPERATION_TABLE_PUBLIC_SUFFIXES: readonly string[] = [
  'co.uk',
  'org.uk',
  'com.ua',
  'org.ua',
  'kiev.ua',
  'com.br',
  'com.cn',
  'com.hk',
  'com.tw',
  'com.au',
  'com.ru',
  'com.tr',
  'com.pl',
  'co.jp',
  'co.kr',
  'co.in',
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'netlify.app',
  'vercel.app',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'appspot.com',
  'blogspot.com',
  'cloudfront.net',
  'azurewebsites.net',
];

/** Names that reach an object's prototype when used as a key: refused wherever the document names a key. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const OPERATION_KEYS = new Set([
  'id',
  'method',
  'host',
  'path',
  'query',
  'body',
  'headers',
  'mutates',
  'schedule',
  'graphql',
  'auth',
  'credentials',
  'redirects',
  'internal',
]);
const AUTH_KEYS = new Set(['cookieUrl', 'cookie', 'header', 'format', 'jsonField', 'refresh']);
const REFRESH_KEYS = new Set(['operation', 'body', 'headers', 'tokenPath']);
const GRAPHQL_KEYS = new Set(['type', 'name', 'fields']);
const DOCUMENT_KEYS = new Set(['version', 'issuedAt', 'expiresAt', 'table']);

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_KINDS = new Set(['none', 'json', 'form']);
const PLATFORM_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const OPERATION_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** RFC 9110 token, lower case (header names are compared lower case). */
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** RFC 9110 token in any case: cookie names and the auth header name. */
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/;
/** Printable ASCII without controls: query keys, JSON field names, refresh header values. */
const PRINTABLE = /^[\x20-\x7e]*$/;

class ShapeError extends Error {
  constructor(readonly refusal: OperationTableRefusal) {
    super(refusal.reason);
  }
}

function fail(reason: OperationTableRefusalReason, detail: string): never {
  throw new ShapeError({ reason, detail: detail.slice(0, 128) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, keys: ReadonlySet<string>, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail('shape', path);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail('shape', `${path}.${key.slice(0, 32)}`);
  return value;
}

function text(value: unknown, path: string, pattern: RegExp = PRINTABLE): string {
  if (typeof value !== 'string' || value.length > OPERATION_TABLE_LIMITS.stringLength || !pattern.test(value))
    fail('shape', path);
  return value;
}

function nonEmptyText(value: unknown, path: string, pattern: RegExp = PRINTABLE): string {
  const result = text(value, path, pattern);
  if (!result) fail('shape', path);
  return result;
}

function list<T>(value: unknown, path: string, item: (entry: unknown, path: string) => T, nonEmpty = false): T[] {
  if (!Array.isArray(value) || value.length > OPERATION_TABLE_LIMITS.listLength || (nonEmpty && !value.length))
    fail('shape', path);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value)) fail('shape', path);
  return value as T;
}

function optional<T>(source: Record<string, unknown>, key: string, read: (value: unknown) => T): T | undefined {
  return Object.prototype.hasOwnProperty.call(source, key) ? read(source[key]) : undefined;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('shape', path);
  return value;
}

function timestamp(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail('shape', path);
  return value;
}

/**
 * Lower-case DNS name with at least two labels, no trailing dot, and a top label that is not a number: the URL
 * parser reads a host whose last label is decimal or `0x` hex (`1.2.3.0x4`) as an IPv4 address.
 */
function isHostname(host: string): boolean {
  const labels = host.split('.');
  return (
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    !/^(?:[0-9]+|0x[0-9a-f]*)$/.test(labels[labels.length - 1] ?? '')
  );
}

/** A cookie host: a hostname that is not a listed public suffix (`OPERATION_TABLE_PUBLIC_SUFFIXES`). */
function isCookieHost(host: string): boolean {
  return isHostname(host) && !OPERATION_TABLE_PUBLIC_SUFFIXES.includes(host);
}

function withinHost(host: string, parent: string): boolean {
  return host === parent || host.endsWith(`.${parent}`);
}

/** The host of a bundled host-permission pattern (`https://<host>/*`). */
function originHost(origin: string): string {
  return origin.replace(/^https:\/\//, '').replace(/\/\*$/, '');
}

/**
 * The hosts a signed table may name for `platform`: its bundled connection origins, plus the hosts of the bundled
 * Steam allowlist when the platform is a Steam one (`api.steampowered.com` has no connection origin of its own).
 * Empty for an id that is not a bundled connection. The manifest's required marketplace hosts (cs.money, csfloat.com,
 * steamcommunity.com) are connection origins too, so they need no list of their own.
 */
export function platformOperationHosts(platform: string): readonly string[] {
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_CONNECTION_TABLE, platform)) return [];
  const origins: readonly string[] =
    PLATFORM_CONNECTION_TABLE[platform as keyof typeof PLATFORM_CONNECTION_TABLE].origins;
  const hosts = origins.map(originHost);
  if (!hosts.some(isSteamHost)) return hosts;
  return [...new Set([...hosts, ...STEAM_SIGNED_OPERATION_ALLOWLIST.map((rule) => rule.host)])];
}

function pathPattern(value: unknown, path: string): string {
  const pattern = text(value, path);
  if (!isOperationPathPattern(pattern)) fail('shape', path);
  return pattern;
}

/** A string later used as an object key (header names, the cookie JSON field, token path keys). */
function keyName(value: unknown, path: string, pattern: RegExp = PRINTABLE): string {
  const result = nonEmptyText(value, path, pattern);
  if (RESERVED_KEYS.has(result)) fail('shape', path);
  return result;
}

function headerName(value: unknown, path: string): string {
  return keyName(value, path, HEADER_NAME);
}

function stringMap(value: unknown, path: string): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > OPERATION_TABLE_LIMITS.listLength) fail('shape', path);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value))
    result[headerName(key, `${path}.key`)] = text(entry, `${path}.value`);
  return result;
}

function readGraphql(value: unknown, path: string): NonNullable<PlatformOperation['graphql']> {
  const source = record(value, GRAPHQL_KEYS, path);
  return {
    type: oneOf<'query' | 'mutation'>(source['type'], new Set(['query', 'mutation']), `${path}.type`),
    name: text(source['name'], `${path}.name`, GRAPHQL_NAME),
    fields: list(source['fields'], `${path}.fields`, (entry, at) => text(entry, at, GRAPHQL_NAME), true),
  };
}

function readAuth(value: unknown, path: string): NonNullable<PlatformOperation['auth']> {
  const source = record(value, AUTH_KEYS, path);
  const auth: NonNullable<PlatformOperation['auth']> = {
    cookieUrl: nonEmptyText(source['cookieUrl'], `${path}.cookieUrl`),
    cookie: text(source['cookie'], `${path}.cookie`, TOKEN),
    header: text(source['header'], `${path}.header`, TOKEN),
    format: oneOf<'bearer' | 'raw'>(source['format'], new Set(['bearer', 'raw']), `${path}.format`),
  };
  const jsonField = optional(source, 'jsonField', (entry) => keyName(entry, `${path}.jsonField`));
  if (jsonField !== undefined) auth.jsonField = jsonField;
  const refresh = optional(source, 'refresh', (entry) => {
    const inner = record(entry, REFRESH_KEYS, `${path}.refresh`);
    return {
      operation: text(inner['operation'], `${path}.refresh.operation`, OPERATION_ID),
      body: text(inner['body'], `${path}.refresh.body`),
      headers: stringMap(inner['headers'], `${path}.refresh.headers`),
      tokenPath: list(inner['tokenPath'], `${path}.refresh.tokenPath`, (key, at) => keyName(key, at), true),
    };
  });
  if (refresh !== undefined) auth.refresh = refresh;
  return auth;
}

function readOperation(value: unknown, path: string): PlatformOperation {
  const source = record(value, OPERATION_KEYS, path);
  const operation: PlatformOperation = {
    id: text(source['id'], `${path}.id`, OPERATION_ID),
    method: oneOf<PlatformOperation['method']>(source['method'], METHODS, `${path}.method`),
    host: nonEmptyText(source['host'], `${path}.host`),
    path: pathPattern(source['path'], `${path}.path`),
    body: oneOf<PlatformOperation['body']>(source['body'], BODY_KINDS, `${path}.body`),
    mutates: boolean(source['mutates'], `${path}.mutates`),
  };
  const query = optional(source, 'query', (entry) => list(entry, `${path}.query`, (key, at) => nonEmptyText(key, at)));
  if (query !== undefined) operation.query = query;
  const headers = optional(source, 'headers', (entry) => list(entry, `${path}.headers`, headerName));
  if (headers !== undefined) operation.headers = headers;
  const schedule = optional(source, 'schedule', (entry) =>
    oneOf<'check' | 'write'>(entry, new Set(['check', 'write']), `${path}.schedule`)
  );
  if (schedule !== undefined) operation.schedule = schedule;
  const graphql = optional(source, 'graphql', (entry) => readGraphql(entry, `${path}.graphql`));
  if (graphql !== undefined) operation.graphql = graphql;
  const auth = optional(source, 'auth', (entry) => readAuth(entry, `${path}.auth`));
  if (auth !== undefined) operation.auth = auth;
  const credentials = optional(source, 'credentials', (entry) =>
    oneOf<'omit'>(entry, new Set(['omit']), `${path}.credentials`)
  );
  if (credentials !== undefined) operation.credentials = credentials;
  const redirects = optional(source, 'redirects', (entry) => list(entry, `${path}.redirects`, pathPattern));
  if (redirects !== undefined) operation.redirects = redirects;
  const internal = optional(source, 'internal', (entry) => boolean(entry, `${path}.internal`));
  if (internal !== undefined) operation.internal = internal;
  return operation;
}

/** The checks a signature cannot override, and the ones that keep the operation consistent for the matcher. */
function checkOperation(
  operation: PlatformOperation,
  operations: readonly PlatformOperation[],
  hosts: readonly string[],
  path: string
): void {
  const { host } = operation;
  if (!isHostname(host) || OPERATION_TABLE_FORBIDDEN_HOSTS.some((forbidden) => withinHost(host, forbidden)))
    fail('forbidden_host', `${path}.host`);
  if (isSteamHost(host) && !isAllowedSteamSignedOperation(operation)) fail('steam_operation', operation.id);
  if (operation.schedule === 'write' && !operation.mutates) fail('shape', `${path}.schedule`);
  if (operation.schedule === 'check' && operation.mutates) fail('shape', `${path}.schedule`);
  if (operation.internal && operation.schedule) fail('shape', `${path}.schedule`);
  if (operation.graphql && operation.body !== 'json') fail('shape', `${path}.graphql`);
  if (operation.method === 'GET' && operation.body !== 'none') fail('shape', `${path}.body`);
  const { auth } = operation;
  if (auth) {
    let cookieHost = '';
    try {
      const url = new URL(auth.cookieUrl);
      const origin = url.origin;
      if (url.protocol === 'https:' && (auth.cookieUrl === origin || auth.cookieUrl === `${origin}/`))
        cookieHost = url.host;
    } catch {
      cookieHost = '';
    }
    // The cookie belongs to the operation's own site: its host or a parent of it (dmarket.com for api.dmarket.com).
    if (!cookieHost || !isCookieHost(cookieHost) || !withinHost(host, cookieHost))
      fail('auth_scope', `${path}.auth.cookieUrl`);
    // The page must never be able to send the header itself.
    if (operation.headers?.includes(auth.header.toLowerCase())) fail('auth_scope', `${path}.auth.header`);
    if (auth.refresh) {
      const minter = operations.find((candidate) => candidate.id === auth.refresh?.operation);
      if (!minter?.internal || !withinHost(minter.host, cookieHost)) fail('auth_refresh', operation.id);
    }
  }
  // Last, so the more specific reasons above are reported first: no host outside the platform's bundled origins.
  if (!hosts.includes(host)) fail('unbundled_host', `${path}.host`);
}

function readTable(value: unknown): OperationTable {
  if (!isRecord(value)) fail('shape', 'table');
  const entries = Object.entries(value);
  if (entries.length > OPERATION_TABLE_LIMITS.platforms) fail('too_large', 'table');
  const table: Record<string, readonly PlatformOperation[]> = {};
  for (const [platform, raw] of entries) {
    if (!PLATFORM_ID.test(platform) || RESERVED_KEYS.has(platform)) fail('shape', 'table.key');
    const path = `table.${platform}`;
    const hosts = platformOperationHosts(platform);
    if (!hosts.length) fail('unknown_platform', path);
    if (!Array.isArray(raw) || raw.length > OPERATION_TABLE_LIMITS.operationsPerPlatform) fail('shape', path);
    const operations = raw.map((entry, index) => readOperation(entry, `${path}[${index}]`));
    const ids = new Set(operations.map((operation) => operation.id));
    if (ids.size !== operations.length) fail('shape', `${path}.id`);
    operations.forEach((operation, index) => checkOperation(operation, operations, hosts, `${path}[${index}]`));
    table[platform] = operations;
  }
  return table;
}

/**
 * Validates a parsed document strictly: every field as `operation-types.ts` describes it, nothing else, and the
 * limits a signature cannot override. Pure; never throws.
 */
export function validateOperationTableDocument(value: unknown): OperationTableParse {
  try {
    const source = record(value, DOCUMENT_KEYS, 'document');
    const version = source['version'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) fail('shape', 'version');
    const issuedAt = timestamp(source['issuedAt'], 'issuedAt');
    const expiresAt = timestamp(source['expiresAt'], 'expiresAt');
    if (expiresAt <= issuedAt) fail('shape', 'expiresAt');
    if (expiresAt - issuedAt > OPERATION_TABLE_MAX_LIFETIME_MS) fail('lifetime', 'expiresAt');
    const document: OperationTableDocument = { version, issuedAt, expiresAt, table: readTable(source['table']) };
    return { ok: true, document };
  } catch (error) {
    if (error instanceof ShapeError) return { ok: false, refusal: error.refusal };
    return { ok: false, refusal: { reason: 'shape' } };
  }
}

/** Parses the exact signed string (after its signature was verified) and validates it. */
export function parseOperationTableDocument(signed: string): OperationTableParse {
  if (signed.length > OPERATION_TABLE_LIMITS.documentLength) return { ok: false, refusal: { reason: 'too_large' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(signed) as unknown;
  } catch {
    return { ok: false, refusal: { reason: 'json' } };
  }
  return validateOperationTableDocument(parsed);
}

/**
 * The string the signing script signs. Any deterministic serialization works, because the verifier checks the bytes
 * it receives and never re-serializes; this one keeps the field order of the source table.
 */
export function serializeOperationTableDocument(document: OperationTableDocument): string {
  return JSON.stringify(document);
}

/** The table a document yields on top of `bundled`: each platform it names is replaced as a whole. */
export function effectiveOperationTable(bundled: OperationTable, signed: OperationTable): OperationTable {
  return { ...bundled, ...signed };
}

/** `operation_table_refused:<reason>` for the bridge answer and logs. */
export function operationTableRefusedError(refusal: OperationTableRefusal): string {
  return `operation_table_refused:${refusal.reason}`;
}
