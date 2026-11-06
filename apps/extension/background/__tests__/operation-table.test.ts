import type { OperationTable, OperationTableDocument, PlatformOperation, SignedOperationTable } from '@qts/contracts';
import {
  BUNDLED_OPERATION_TABLE_VERSION,
  OPERATION_TABLE_CLOCK_SKEW_MS,
  OPERATION_TABLE_LIMITS,
  OPERATION_TABLE_MAX_LIFETIME_MS,
  parseOperationTableDocument,
  PLATFORM_OPERATIONS,
  platformOperationHosts,
  serializeOperationTableDocument,
  validateOperationTableDocument,
} from '@qts/contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OperationTablePublicKey } from '@/shared/operation-table-key';

import type { OperationTableAcceptance } from '../operation-table-policy';
import { verifySignedOperationTable } from '../operation-table-policy';

// Keys are generated per run: no private key, not even a test one, is ever stored in the repository.
let signingKey: CryptoKey;
let publicKey: OperationTablePublicKey;
let otherSigningKey: CryptoKey;

async function generate(): Promise<{ privateKey: CryptoKey; publicKey: OperationTablePublicKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x ?? '', y: jwk.y ?? '' } };
}

beforeAll(async () => {
  const main = await generate();
  signingKey = main.privateKey;
  publicKey = main.publicKey;
  otherSigningKey = (await generate()).privateKey;
});

async function signText(document: string, key: CryptoKey = signingKey): Promise<SignedOperationTable> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(document));
  return { document, signature: Buffer.from(signature).toString('base64') };
}

const NOW = 1_800_000_000_000;

const DAY = 24 * 60 * 60 * 1000;

/** A document issued at `overrides.issuedAt` (default just before NOW) that lives 30 days unless told otherwise. */
function doc(table: OperationTable, overrides: Partial<OperationTableDocument> = {}): OperationTableDocument {
  const issuedAt = overrides.issuedAt ?? NOW - 1000;
  return { version: 2, issuedAt, expiresAt: issuedAt + 30 * DAY, table, ...overrides };
}

async function sign(document: OperationTableDocument, key?: CryptoKey): Promise<SignedOperationTable> {
  return signText(serializeOperationTableDocument(document), key);
}

function options(overrides: Partial<OperationTableAcceptance> = {}): OperationTableAcceptance {
  return { publicKey, highestVersion: 0, acceptedDocument: null, now: NOW, ...overrides };
}

const CSFLOAT_NEW: PlatformOperation = { id: 'csfloat.new-endpoint', method: 'GET', host: 'csfloat.com', path: '/api/v1/new-endpoint/{id:int}', body: 'none', mutates: false };

function withOperation(operation: PlatformOperation, platform = 'csfloat.com'): OperationTable {
  return { [platform]: [operation] };
}

async function refusalOf(table: OperationTable): Promise<unknown> {
  const verdict = await verifySignedOperationTable(await sign(doc(table)), options());
  return verdict.ok ? null : verdict.refusal;
}

describe('signed operation table: acceptance policy', () => {
  it('the bundled table is a valid signed document as is', () => {
    expect(validateOperationTableDocument(doc(PLATFORM_OPERATIONS))).toMatchObject({ ok: true });
  });

  it('accepts a table signed with the bundled key and returns it parsed', async () => {
    const verdict = await verifySignedOperationTable(await sign(doc(PLATFORM_OPERATIONS)), options());
    expect(verdict).toMatchObject({ ok: true, unchanged: false, document: { version: 2 } });
    expect(verdict.ok && verdict.document.table).toEqual(JSON.parse(JSON.stringify(PLATFORM_OPERATIONS)));
  });

  it('refuses everything while the key is the placeholder or not a public P-256 key', async () => {
    const envelope = await sign(doc(PLATFORM_OPERATIONS));
    expect(await verifySignedOperationTable(envelope, options({ publicKey: null }))).toEqual({ ok: false, refusal: { reason: 'disabled' } });
    const leaked = { ...publicKey, d: 'private' } as OperationTablePublicKey;
    expect(await verifySignedOperationTable(envelope, options({ publicKey: leaked }))).toEqual({ ok: false, refusal: { reason: 'disabled' } });
  });

  it('verifies the exact bytes: one changed character, another key or a re-encoded document fail', async () => {
    const envelope = await sign(doc(PLATFORM_OPERATIONS));
    const tampered = { ...envelope, document: envelope.document.replace('"csfloat.com"', '"csfloat.con"') };
    expect(await verifySignedOperationTable(tampered, options())).toMatchObject({ ok: false, refusal: { reason: 'signature' } });
    expect(await verifySignedOperationTable(await sign(doc(PLATFORM_OPERATIONS), otherSigningKey), options())).toMatchObject({ ok: false, refusal: { reason: 'signature' } });
    const reformatted = { ...envelope, document: JSON.stringify(JSON.parse(envelope.document), null, 2) };
    expect(await verifySignedOperationTable(reformatted, options())).toMatchObject({ ok: false, refusal: { reason: 'signature' } });
  });

  it('refuses a malformed envelope before verifying', async () => {
    const envelope = await sign(doc(PLATFORM_OPERATIONS));
    for (const value of [null, 'x', [], { document: envelope.document }, { ...envelope, extra: 1 }, { document: 1, signature: envelope.signature }]) {
      expect(await verifySignedOperationTable(value, options())).toMatchObject({ ok: false, refusal: { reason: 'malformed' } });
    }
    expect(await verifySignedOperationTable({ ...envelope, signature: 'AAAA' }, options())).toMatchObject({ ok: false, refusal: { reason: 'malformed' } });
  });

  it('refuses signed JSON that is not a document', async () => {
    expect(await verifySignedOperationTable(await signText('{not json'), options())).toMatchObject({ ok: false, refusal: { reason: 'json' } });
    expect(await verifySignedOperationTable(await signText(JSON.stringify({ ...doc({}), extra: true })), options())).toMatchObject({ ok: false, refusal: { reason: 'shape' } });
  });

  it.each([
    ['an unknown operation field', { ...CSFLOAT_NEW, proxyAnything: true }],
    ['a method outside the set', { ...CSFLOAT_NEW, method: 'TRACE' }],
    ['a path parameter type the matcher does not know', { ...CSFLOAT_NEW, path: '/api/{x:any}' }],
    ['an escaped path segment', { ...CSFLOAT_NEW, path: '/api/%2e%2e/x' }],
    ['an upper-case header name', { ...CSFLOAT_NEW, headers: ['Content-Type'] }],
    ['a GET with a body', { ...CSFLOAT_NEW, body: 'json' }],
    ['a scheduled write that does not mutate', { ...CSFLOAT_NEW, schedule: 'write' }],
    ['credentials other than omit', { ...CSFLOAT_NEW, credentials: 'include' }],
  ])('refuses %s (shape)', async (_name, operation) => {
    expect(await refusalOf(withOperation(operation as PlatformOperation))).toMatchObject({ reason: 'shape' });
  });

  it('refuses duplicate operation ids and malformed platform keys', async () => {
    expect(await refusalOf({ 'csfloat.com': [CSFLOAT_NEW, CSFLOAT_NEW] })).toMatchObject({ reason: 'shape' });
    expect(await refusalOf({ __proto__x: [CSFLOAT_NEW] } as OperationTable)).toMatchObject({ reason: 'shape' });
    for (const key of ['constructor', 'prototype']) expect(await refusalOf({ [key]: [CSFLOAT_NEW] })).toMatchObject({ reason: 'shape', detail: 'table.key' });
  });

  it('refuses prototype names wherever the document names an object key', async () => {
    const auth = { cookieUrl: 'https://csfloat.com', cookie: 'session', header: 'Authorization', format: 'bearer' } as const;
    const minter: PlatformOperation = { id: 'csfloat.mint', method: 'POST', host: 'csfloat.com', path: '/mint', body: 'json', mutates: false, internal: true };
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, headers: [name] }))).toMatchObject({ reason: 'shape' });
      expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, auth: { ...auth, jsonField: name } }))).toMatchObject({ reason: 'shape' });
      const refresh = { operation: 'csfloat.mint', body: '{}', headers: {}, tokenPath: [name] };
      expect(await refusalOf({ 'csfloat.com': [{ ...CSFLOAT_NEW, auth: { ...auth, refresh } }, minter] })).toMatchObject({ reason: 'shape' });
    }
    // `__proto__` as an own key of a refresh header map (JSON.parse creates it as an own property).
    const document = serializeOperationTableDocument(
      doc({ 'csfloat.com': [{ ...CSFLOAT_NEW, auth: { ...auth, refresh: { operation: 'csfloat.mint', body: '{}', headers: { 'x-a': '1' }, tokenPath: ['t'] } } }, minter] })
    ).replace('"x-a"', '"__proto__"');
    expect(await verifySignedOperationTable(await signText(document), options())).toMatchObject({ ok: false, refusal: { reason: 'shape' } });
  });

  it.each([
    'app.quicktrade.skin',
    'quicktrade.skin',
    'api.quicktrade.skin',
    'localhost',
    'app.localhost',
    '127.0.0.1',
    'intranet',
    '1.2.3.0x4',
    '1.2.3.0X4',
    'csfloat.0x7f',
    'csfloat.com.',
    'CSFLOAT.COM',
    'CsFloat.com',
    '[::1]',
    '[2001:db8::1]',
    '::1',
    '2130706433',
    '',
  ])('never adds an operation on %j', async (host) => {
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host }))).toMatchObject({ reason: expect.stringMatching(/^(forbidden_host|shape)$/) });
  });

  it.each(['1.2.3.0x4', 'csfloat.0x7f', 'csfloat.com.', 'CSFLOAT.COM', '[::1]', '2130706433'])('reports %j as a forbidden host', async (host) => {
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host }))).toMatchObject({ reason: 'forbidden_host' });
  });

  it('Steam operations must fit the bundled allowlist (steam-operation-allowlist.test.ts has the cases)', async () => {
    const accept: PlatformOperation = { id: 'steam.accept', method: 'POST', host: 'steamcommunity.com', path: '/tradeoffer/{id:int}/accept', body: 'form', headers: ['content-type'], mutates: true };
    expect(await refusalOf(withOperation(accept, 'steamcommunity.com'))).toBeNull();
    expect(await refusalOf(withOperation({ ...accept, path: '/tradeoffer/{id:int}/decline' }, 'steamcommunity.com'))).toMatchObject({ reason: 'steam_operation', detail: 'steam.accept' });
    // On any platform key: the floor follows the host.
    expect(await refusalOf(withOperation({ ...accept, path: '/dev/registerkey' }))).toMatchObject({ reason: 'steam_operation' });
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host: 'steamcommunity.com' }, 'steamcommunity.com'))).toMatchObject({ reason: 'steam_operation' });
  });

  it('auth may read a cookie of the operation own site only, under a header the page cannot send', async () => {
    const auth = { cookieUrl: 'https://csfloat.com', cookie: 'session', header: 'Authorization', format: 'bearer' } as const;
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, auth }))).toBeNull();
    // A parent-site cookie for an API host of the platform (dmarket.com for api.dmarket.com).
    const dmarketAuth = { ...auth, cookieUrl: 'https://dmarket.com' };
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host: 'api.dmarket.com', auth: dmarketAuth }, 'dmarket.com'))).toBeNull();
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, auth: { ...auth, cookieUrl: 'https://steamcommunity.com' } }))).toMatchObject({ reason: 'auth_scope' });
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, auth: { ...auth, cookieUrl: 'https://evil-csfloat.com' } }))).toMatchObject({ reason: 'auth_scope' });
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, auth: { ...auth, cookieUrl: 'https://api.csfloat.com' } }))).toMatchObject({ reason: 'auth_scope' });
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, auth: { ...auth, cookieUrl: 'http://csfloat.com' } }))).toMatchObject({ reason: 'auth_scope' });
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, headers: ['authorization'], auth }))).toMatchObject({ reason: 'auth_scope' });
  });

  it.each([
    ['co.uk', 'market.co.uk'],
    ['com.ua', 'skins.com.ua'],
    ['github.io', 'csfloat.github.io'],
  ])('auth may not read a cookie of the public suffix %s', async (suffix, host) => {
    const auth = { cookieUrl: `https://${suffix}`, cookie: 'session', header: 'Authorization', format: 'bearer' } as const;
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host, auth }))).toMatchObject({ reason: 'auth_scope' });
    // Its own-site cookie passes the auth scope; the host is still no bundled origin of the platform.
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host, auth: { ...auth, cookieUrl: `https://${host}` } }))).toMatchObject({ reason: 'unbundled_host' });
  });

  it('refuses a document over the size limit before parsing it', async () => {
    const padded = serializeOperationTableDocument(doc({})).replace('{', `{${' '.repeat(OPERATION_TABLE_LIMITS.documentLength)}`);
    expect(await verifySignedOperationTable(await signText(padded), options())).toMatchObject({ ok: false, refusal: { reason: 'too_large' } });
    expect(parseOperationTableDocument(padded)).toEqual({ ok: false, refusal: { reason: 'too_large' } });
  });

  it('refuses more platforms than the limit as too_large', async () => {
    const table = Object.fromEntries(Array.from({ length: OPERATION_TABLE_LIMITS.platforms + 1 }, (_, index) => [`p${index}.com`, []]));
    expect(await refusalOf(table)).toMatchObject({ reason: 'too_large' });
  });

  it('a platform key must be a bundled connection', async () => {
    expect(await refusalOf({ 'evil.example': [] })).toMatchObject({ reason: 'unknown_platform', detail: 'table.evil.example' });
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host: 'evil.example' }, 'evil.example'))).toMatchObject({ reason: 'unknown_platform' });
    expect(await refusalOf({ 'csfloat.com': [] })).toBeNull();
  });

  it.each([
    ['a host no connection bundles', 'csfloat.com', 'api.csfloat.com'],
    ['an unrelated marketplace host', 'csfloat.com', 'evil.example'],
    ['another platform own origin', 'csfloat.com', 'cs.money'],
    ['a subdomain of a bundled origin', 'dmarket.com', 'www.dmarket.com'],
  ])('refuses %s as unbundled_host', async (_name, platform, host) => {
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host }, platform))).toMatchObject({ reason: 'unbundled_host' });
  });

  it('accepts each platform own bundled origins and, on Steam, the allowlist hosts', async () => {
    expect(platformOperationHosts('dmarket.com')).toEqual(['dmarket.com', 'api.dmarket.com']);
    expect(platformOperationHosts('steamcommunity.com')).toEqual(['steamcommunity.com', 'api.steampowered.com']);
    expect(platformOperationHosts('__proto__')).toEqual([]);
    expect(await refusalOf(withOperation({ ...CSFLOAT_NEW, host: 'api.dmarket.com' }, 'dmarket.com'))).toBeNull();
    const offers: PlatformOperation = {
      id: 'steam.offers',
      method: 'GET',
      host: 'api.steampowered.com',
      path: '/IEconService/GetTradeOffers/v1/',
      query: ['access_token'],
      body: 'none',
      mutates: false,
    };
    expect(await refusalOf(withOperation(offers, 'steamcommunity.com'))).toBeNull();
    // An allowlisted Steam operation on a non-Steam platform: the Steam hosts belong to the Steam platform only.
    expect(await refusalOf(withOperation(offers))).toMatchObject({ reason: 'unbundled_host' });
  });

  it('auth.refresh must name an internal operation of the same platform and site', async () => {
    const refresh = { operation: 'csfloat.mint', body: '{}', headers: { 'content-type': 'application/json' }, tokenPath: ['token'] };
    const auth = { cookieUrl: 'https://csfloat.com', cookie: 'session', header: 'Authorization', format: 'bearer', refresh } as const;
    const minter: PlatformOperation = { id: 'csfloat.mint', method: 'POST', host: 'csfloat.com', path: '/mint', body: 'json', headers: ['content-type'], mutates: false, internal: true };
    expect(await refusalOf({ 'csfloat.com': [{ ...CSFLOAT_NEW, auth }, minter] })).toBeNull();
    expect(await refusalOf({ 'csfloat.com': [{ ...CSFLOAT_NEW, auth }] })).toMatchObject({ reason: 'auth_refresh' });
    expect(
      await refusalOf({
        'csfloat.com': [
          { ...CSFLOAT_NEW, auth },
          { ...minter, internal: false },
        ],
      })
    ).toMatchObject({ reason: 'auth_refresh' });
    expect(
      await refusalOf({
        'csfloat.com': [
          { ...CSFLOAT_NEW, auth },
          { ...minter, host: 'mint.example.com' },
        ],
      })
    ).toMatchObject({ reason: 'auth_refresh' });
  });

  it('expiry and the version floor: no rollback, no second document under one version', async () => {
    const expired = await sign(doc({}, { expiresAt: NOW }));
    expect(await verifySignedOperationTable(expired, options())).toMatchObject({ ok: false, refusal: { reason: 'expired' } });
    const v2 = await sign(doc({}));
    expect(await verifySignedOperationTable(v2, options({ highestVersion: 3 }))).toMatchObject({ ok: false, refusal: { reason: 'rollback' } });
    expect(await verifySignedOperationTable(v2, options({ highestVersion: 2, acceptedDocument: v2.document }))).toMatchObject({ ok: true, unchanged: true });
    const otherV2 = await sign(doc(withOperation(CSFLOAT_NEW)));
    expect(await verifySignedOperationTable(otherV2, options({ highestVersion: 2, acceptedDocument: v2.document }))).toMatchObject({ ok: false, refusal: { reason: 'version_conflict' } });
    expect(await verifySignedOperationTable(otherV2, options({ highestVersion: 2, acceptedDocument: null }))).toMatchObject({ ok: false, refusal: { reason: 'version_conflict' } });
    expect(BUNDLED_OPERATION_TABLE_VERSION).toBeGreaterThanOrEqual(1);
    expect(await verifySignedOperationTable(await sign(doc({}, { version: 0 })), options())).toMatchObject({ ok: false, refusal: { reason: 'shape' } });
  });

  it('expiresAt is required, after issuedAt and at most the maximum lifetime away', async () => {
    const withoutExpiry: Record<string, unknown> = { ...doc({}) };
    delete withoutExpiry['expiresAt'];
    expect(validateOperationTableDocument(withoutExpiry)).toMatchObject({ ok: false, refusal: { reason: 'shape', detail: 'expiresAt' } });
    expect(validateOperationTableDocument(doc({}, { expiresAt: NOW - 1000 }))).toMatchObject({ ok: false, refusal: { reason: 'shape', detail: 'expiresAt' } });
    const issuedAt = NOW - 1000;
    expect(validateOperationTableDocument(doc({}, { expiresAt: issuedAt + OPERATION_TABLE_MAX_LIFETIME_MS }))).toMatchObject({ ok: true });
    expect(validateOperationTableDocument(doc({}, { expiresAt: issuedAt + OPERATION_TABLE_MAX_LIFETIME_MS + 1 }))).toMatchObject({ ok: false, refusal: { reason: 'lifetime' } });
    expect(OPERATION_TABLE_MAX_LIFETIME_MS).toBe(60 * DAY);
  });

  it('refuses a document dated ahead of the clock beyond the skew (it would outlive the maximum lifetime)', async () => {
    const ahead = NOW + OPERATION_TABLE_CLOCK_SKEW_MS + 1;
    expect(await verifySignedOperationTable(await sign(doc({}, { issuedAt: ahead })), options())).toMatchObject({ ok: false, refusal: { reason: 'not_yet_valid' } });
    const withinSkew = NOW + OPERATION_TABLE_CLOCK_SKEW_MS;
    expect(await verifySignedOperationTable(await sign(doc({}, { issuedAt: withinSkew })), options())).toMatchObject({ ok: true });
  });
});

// ─── The background: effective table for proxy, scheduler and storage across worker restarts ─────────────

const stored = new Map<string, unknown>();
const fetchMock = vi.fn();
const warn = vi.fn();
let keyForBuild: OperationTablePublicKey | null = null;

function json(data: unknown) {
  return { ok: true, status: 200, redirected: false, url: '', headers: new Headers({ 'content-type': 'application/json' }), json: async () => data, text: async () => JSON.stringify(data) };
}

function storageGetStub(keys?: string | string[] | null): Promise<Record<string, unknown>> {
  const wanted = keys == null ? [...stored.keys()] : Array.isArray(keys) ? keys : [keys];
  return Promise.resolve(Object.fromEntries(wanted.filter((key) => stored.has(key)).map((key) => [key, JSON.parse(JSON.stringify(stored.get(key)))])));
}

function storageSetStub(values: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(values)) stored.set(key, JSON.parse(JSON.stringify(value)));
  return Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  stored.clear();
  keyForBuild = publicKey;
  vi.doMock('@/shared/operation-table-key', () => ({ OPERATION_TABLE_PUBLIC_KEY: keyForBuild }));
  fetchMock.mockImplementation(async () => json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(warn);
  vi.stubGlobal('browser', {
    permissions: { contains: vi.fn(async () => true) },
    cookies: { get: vi.fn(async () => null) },
    storage: { local: { get: vi.fn(storageGetStub), set: vi.fn(storageSetStub) } },
  });
});
afterEach(() => {
  vi.doUnmock('@/shared/operation-table-key');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function site(type: string, data: unknown) {
  const { handleSiteMessage } = await import('../handlers/site');
  return handleSiteMessage({ type, data } as Parameters<typeof handleSiteMessage>[0]);
}

const NEW_URL = 'https://csfloat.com/api/v1/new-endpoint/42';
const EDIT = { url: 'https://csfloat.com/api/v1/listings/987654321', method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"price":1234}' };

function signedCsfloat(extra: PlatformOperation[], overrides: Partial<OperationTableDocument> = {}): OperationTableDocument {
  return doc({ 'csfloat.com': [...PLATFORM_OPERATIONS['csfloat.com'], ...extra] }, { issuedAt: Date.now() - 1000, ...overrides });
}

describe('signed operation table: the background', () => {
  it('a newly signed endpoint works without an extension release; before it, it is refused', async () => {
    expect(await site('site:proxy_request', { requestId: 'a', platform: 'csfloat.com', request: { url: NEW_URL, method: 'GET' } })).toMatchObject({
      data: { status: 403, error: 'operation_refused:path' },
    });
    expect(await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW])))).toEqual({ ok: true, data: { version: 2, unchanged: false } });
    expect(await site('site:proxy_request', { requestId: 'b', platform: 'csfloat.com', request: { url: NEW_URL, method: 'GET' } })).toMatchObject({ data: { ok: true, status: 200 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('replaces a platform as a whole and leaves the others bundled', async () => {
    await site('site:set_operation_table', await sign(doc({ 'csfloat.com': [CSFLOAT_NEW] }, { issuedAt: Date.now() - 1000 })));
    expect(await site('site:proxy_request', { requestId: 'a', platform: 'csfloat.com', request: EDIT })).toMatchObject({ data: { status: 403, error: 'operation_refused:method' } });
    const skinport = await site('site:proxy_request', { requestId: 'b', platform: 'skinport.com', request: { url: 'https://skinport.com/api/v1/nothing', method: 'GET' } });
    expect(skinport).toMatchObject({ data: { status: 403 } });
    const { getEffectiveOperationTable } = await import('../operation-table-store');
    expect((await getEffectiveOperationTable())['skinport.com']).toEqual(PLATFORM_OPERATIONS['skinport.com']);
  });

  it('the page catalog still narrows a signed platform', async () => {
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW])));
    stored.set('qts_platform_catalog', [{ id: 'csfloat.com', operations: ['csfloat.listings.search'] }]);
    expect(await site('site:proxy_request', { requestId: 'a', platform: 'csfloat.com', request: { url: NEW_URL, method: 'GET' } })).toMatchObject({ data: { error: 'operation_refused:narrowed' } });
  });

  it('the scheduler checks against the effective table', async () => {
    const write: PlatformOperation = {
      id: 'csfloat.new-write',
      method: 'PUT',
      host: 'csfloat.com',
      path: '/api/v1/new-write/{id:int}',
      body: 'json',
      headers: ['content-type'],
      mutates: true,
      schedule: 'write',
    };
    const request = { url: 'https://csfloat.com/api/v1/new-write/7', method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' };
    const before = await import('../operation-policy');
    expect(await before.scheduledRequestRefusal('csfloat.com', request, 'write')).toMatchObject({ reason: 'method' });
    await site('site:set_operation_table', await sign(signedCsfloat([write])));
    const { scheduledRequestRefusal } = await import('../operation-policy');
    expect(await scheduledRequestRefusal('csfloat.com', request, 'write')).toBeNull();
  });

  it('survives a worker restart: the stored copy is verified again before use', async () => {
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW])));
    vi.resetModules();
    expect(await site('site:proxy_request', { requestId: 'a', platform: 'csfloat.com', request: { url: NEW_URL, method: 'GET' } })).toMatchObject({ data: { ok: true } });
  });

  it('a tampered stored copy is dropped at start, its version floor kept', async () => {
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW], { version: 5 })));
    const record = stored.get('qts_operation_table') as { envelope: SignedOperationTable; highestVersion: number };
    stored.set('qts_operation_table', { ...record, envelope: { ...record.envelope, document: record.envelope.document.replace('new-endpoint', 'new-endpoinT') } });
    vi.resetModules();
    expect(await site('site:proxy_request', { requestId: 'a', platform: 'csfloat.com', request: { url: NEW_URL, method: 'GET' } })).toMatchObject({ data: { status: 403 } });
    expect(stored.get('qts_operation_table')).toEqual({ highestVersion: 5 });
    expect(await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW], { version: 4 })))).toEqual({ ok: false, error: 'operation_table_refused:rollback' });
    expect(warn).toHaveBeenCalledWith('[qts background] operation table refused', { source: 'storage', reason: 'signature' });
  });

  it('an expired copy falls back to the bundled table', async () => {
    const expiresAt = Date.now() + 60_000;
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW], { expiresAt })));
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    expect(await site('site:proxy_request', { requestId: 'a', platform: 'csfloat.com', request: { url: NEW_URL, method: 'GET' } })).toMatchObject({ data: { status: 403 } });
  });

  it('refuses a forbidden table and logs no values', async () => {
    const evil = await sign(doc({ 'cs.money': [{ ...CSFLOAT_NEW, host: 'app.quicktrade.skin', path: '/api/auth/me' }] }, { issuedAt: Date.now() - 1000 }));
    expect(await site('site:set_operation_table', evil)).toEqual({ ok: false, error: 'operation_table_refused:forbidden_host' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('app.quicktrade.skin');
    expect(stored.has('qts_operation_table')).toBe(false);
  });

  it('with the placeholder key nothing is accepted or read, and the capability is not announced', async () => {
    keyForBuild = null;
    expect(await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW])))).toEqual({ ok: false, error: 'operation_table_refused:disabled' });
    const { EXTENSION_CAPABILITIES } = await import('@/shared/capabilities');
    expect(EXTENSION_CAPABILITIES).not.toContain('signed_operation_table');
  });

  it('an expiry reload racing an accept keeps the newly accepted table and its floor', async () => {
    const expiresAt = Date.now() + 60_000;
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW], { expiresAt })));
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    const NEWER: PlatformOperation = { ...CSFLOAT_NEW, id: 'csfloat.newer', path: '/api/v1/newer/{id:int}' };
    const v3 = await sign(signedCsfloat([NEWER], { version: 3 }));
    const { acceptOperationTable, getEffectiveOperationTable } = await import('../operation-table-store');
    const [, accepted, after] = await Promise.all([getEffectiveOperationTable(), acceptOperationTable(v3), getEffectiveOperationTable()]);
    expect(accepted).toEqual({ ok: true, version: 3, unchanged: false });
    expect(after['csfloat.com']?.some((operation) => operation.id === 'csfloat.newer')).toBe(true);
    expect(stored.get('qts_operation_table')).toEqual({ envelope: v3, highestVersion: 3 });
    // And again once everything settled: the reload never dropped v3.
    expect((await getEffectiveOperationTable())['csfloat.com']?.some((operation) => operation.id === 'csfloat.newer')).toBe(true);
  });

  it('a drop re-reads storage and removes only the envelope it verified', async () => {
    const expiresAt = Date.now() + 60_000;
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW], { expiresAt })));
    vi.resetModules();
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    const NEWER: PlatformOperation = { ...CSFLOAT_NEW, id: 'csfloat.newer', path: '/api/v1/newer/{id:int}' };
    const v3 = { envelope: await sign(signedCsfloat([NEWER], { version: 3 })), highestVersion: 3 };
    // Another context stores v3 right after this worker read the (expired) v2 copy.
    const get = vi.fn(async (keys?: string | string[] | null) => {
      const result = await storageGetStub(keys);
      if (get.mock.calls.length === 1) stored.set('qts_operation_table', v3);
      return result;
    });
    (browser.storage.local as unknown as { get: typeof get }).get = get;
    const { getEffectiveOperationTable } = await import('../operation-table-store');
    const table = await getEffectiveOperationTable();
    expect(stored.get('qts_operation_table')).toEqual(v3);
    expect(table['csfloat.com']?.some((operation) => operation.id === 'csfloat.newer')).toBe(true);
    expect(warn).toHaveBeenCalledWith('[qts background] operation table refused', { source: 'storage', reason: 'expired' });
  });

  it('dropping an expired copy never lowers the floor below the one this worker holds', async () => {
    const expiresAt = Date.now() + 60_000;
    const v5 = await sign(signedCsfloat([CSFLOAT_NEW], { version: 5, expiresAt }));
    await site('site:set_operation_table', v5);
    // The stored floor went missing (another context, a partial write): the worker still holds 5.
    stored.set('qts_operation_table', { envelope: v5, highestVersion: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    const { getEffectiveOperationTable, acceptOperationTable } = await import('../operation-table-store');
    expect((await getEffectiveOperationTable())['csfloat.com']).toEqual(PLATFORM_OPERATIONS['csfloat.com']);
    expect(stored.get('qts_operation_table')).toEqual({ highestVersion: 5 });
    expect(await acceptOperationTable(await sign(signedCsfloat([CSFLOAT_NEW], { version: 4 })))).toMatchObject({ ok: false, refusal: { reason: 'rollback' } });
  });

  it('an accept never stores below a higher floor another context stored', async () => {
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW])));
    stored.set('qts_operation_table', { highestVersion: 9 });
    expect(await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW], { version: 3 })))).toEqual({ ok: false, error: 'operation_table_refused:rollback' });
    expect(stored.get('qts_operation_table')).toEqual({ highestVersion: 9 });
  });

  it('identical envelopes in flight (several tabs) share one verification and one write', async () => {
    const envelope = await sign(signedCsfloat([CSFLOAT_NEW]));
    const { acceptOperationTable } = await import('../operation-table-store');
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const first = acceptOperationTable(envelope);
    const second = acceptOperationTable({ ...envelope });
    expect(second).toBe(first);
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, version: 2, unchanged: false },
      { ok: true, version: 2, unchanged: false },
    ]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
    // Once settled, the same envelope is verified again (and found unchanged).
    expect(await acceptOperationTable(envelope)).toEqual({ ok: true, version: 2, unchanged: true });
  });

  it('an accept arriving while an expiry reload waits on storage runs after it and is kept', async () => {
    const expiresAt = Date.now() + 60_000;
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW], { expiresAt })));
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    const NEWER: PlatformOperation = { ...CSFLOAT_NEW, id: 'csfloat.newer', path: '/api/v1/newer/{id:int}' };
    const v3 = await sign(signedCsfloat([NEWER], { version: 3 }));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = vi.fn(async (keys?: string | string[] | null) => {
      if (get.mock.calls.length === 1) await gate;
      return storageGetStub(keys);
    });
    (browser.storage.local as unknown as { get: typeof get }).get = get;
    const { acceptOperationTable, getEffectiveOperationTable } = await import('../operation-table-store');
    const reload = getEffectiveOperationTable();
    const accepted = acceptOperationTable(v3);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The accept waits behind the reload: nothing verified or written yet.
    expect(verify).not.toHaveBeenCalled();
    expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
    release();
    expect((await reload)['csfloat.com']).toEqual(PLATFORM_OPERATIONS['csfloat.com']);
    expect(await accepted).toEqual({ ok: true, version: 3, unchanged: false });
    expect(stored.get('qts_operation_table')).toEqual({ envelope: v3, highestVersion: 3 });
    expect((await getEffectiveOperationTable())['csfloat.com']?.some((operation) => operation.id === 'csfloat.newer')).toBe(true);
  });

  it('two identical deliveries during a reload share one in-flight check', async () => {
    const envelope = await sign(signedCsfloat([CSFLOAT_NEW]));
    const { acceptOperationTable, getEffectiveOperationTable } = await import('../operation-table-store');
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const load = getEffectiveOperationTable();
    const first = acceptOperationTable(envelope);
    const second = acceptOperationTable(JSON.parse(JSON.stringify(envelope)));
    expect(second).toBe(first);
    await load;
    expect(await first).toEqual({ ok: true, version: 2, unchanged: false });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('a failed storage read falls back to the bundled table for a minute, then loads again', async () => {
    await site('site:set_operation_table', await sign(signedCsfloat([CSFLOAT_NEW])));
    vi.resetModules();
    const get = vi.fn(async (keys?: string | string[] | null) => {
      if (get.mock.calls.length === 1) throw new Error('storage unavailable');
      return storageGetStub(keys);
    });
    (browser.storage.local as unknown as { get: typeof get }).get = get;
    const { getEffectiveOperationTable, STORAGE_RETRY_MS } = await import('../operation-table-store');
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    expect((await getEffectiveOperationTable())['csfloat.com']).toEqual(PLATFORM_OPERATIONS['csfloat.com']);
    expect(warn).toHaveBeenCalledWith('[qts background] operation table refused', { source: 'storage', reason: 'storage' });
    now.mockReturnValue(start + STORAGE_RETRY_MS - 1);
    expect((await getEffectiveOperationTable())['csfloat.com']).toEqual(PLATFORM_OPERATIONS['csfloat.com']);
    expect(get).toHaveBeenCalledTimes(1);
    now.mockReturnValue(start + STORAGE_RETRY_MS);
    expect((await getEffectiveOperationTable())['csfloat.com']?.some((operation) => operation.id === CSFLOAT_NEW.id)).toBe(true);
  });

  it('an auth refresh needs the grant of its own origin before the credentialed fetch', async () => {
    const auth = {
      cookieUrl: 'https://white.market',
      cookie: 'access-token',
      header: 'Authorization',
      format: 'bearer',
      refresh: { operation: 'wm.mint', body: '{}', headers: { 'content-type': 'application/json' }, tokenPath: ['token'] },
    } as const;
    const main: PlatformOperation = { id: 'wm.read', method: 'GET', host: 'white.market', path: '/api/read', body: 'none', mutates: false, auth };
    const minter: PlatformOperation = { id: 'wm.mint', method: 'POST', host: 'api.white.market', path: '/mint', body: 'json', headers: ['content-type'], mutates: false, internal: true };
    expect(await site('site:set_operation_table', await sign(doc({ 'white.market': [main, minter] }, { issuedAt: Date.now() - 1000 })))).toMatchObject({ ok: true });
    const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins[0] === 'https://white.market/*');
    (browser.permissions as unknown as { contains: typeof contains }).contains = contains;
    const request = { requestId: 'a', platform: 'white.market', request: { url: 'https://white.market/api/read', method: 'GET' } };
    expect(await site('site:proxy_request', request)).toMatchObject({ data: { ok: false, status: 403, error: 'permission_denied: https://api.white.market/*' } });
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.white.market/*'] });
    expect(fetchMock).not.toHaveBeenCalled();
    // Granted: the token is minted, then the request goes out with it.
    contains.mockImplementation(async () => true);
    fetchMock.mockResolvedValueOnce(json({ token: 'fixture-minted' })).mockResolvedValueOnce(json({ ok: true }));
    expect(await site('site:proxy_request', { ...request, requestId: 'b' })).toMatchObject({ data: { ok: true, status: 200 } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.white.market/mint');
    expect(fetchMock.mock.calls[1]?.[1].headers).toMatchObject({ Authorization: 'Bearer fixture-minted' });
  });

  it('a build with a real key announces the capability', async () => {
    const { EXTENSION_CAPABILITIES } = await import('@/shared/capabilities');
    expect(EXTENSION_CAPABILITIES).toContain('signed_operation_table');
  });
});
