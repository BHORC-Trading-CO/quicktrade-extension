import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_HANDOFF_MAX_AVATAR_URL_LENGTH, AUTH_HANDOFF_MAX_DISPLAY_NAME_LENGTH, AUTH_HANDOFF_MAX_EMAIL_LENGTH, AUTH_HANDOFF_MAX_STORED_LENGTH, validateAuthHandoff } from '../auth-handoff-policy';
import { onRuntimeMessage } from '../runtime-router';

vi.mock('../handlers/popup', () => ({ handlePopupMessage: vi.fn() }));
vi.mock('../handlers/site', () => ({ handleSiteMessage: vi.fn() }));
vi.mock('../../shared/config', () => ({ BRIDGE_MODE: 'production' }));

const USER_ID = 'user_2abcDEF3ghiJKL4mnoPQR5stuVW';
const CLERK_AVATAR = 'https://img.clerk.com/eyJ0eXBlIjoicHJveHkiLCJzcmMiOiJodHRwczovL2V4YW1wbGUudGVzdCJ9';
const BACKSLASH = String.fromCharCode(92);
const withoutAvatar = { clerkId: USER_ID, email: 'trader@example.test', displayName: 'Alice B' };
const withoutName = { clerkId: USER_ID, email: 'trader@example.test', avatarUrl: CLERK_AVATAR };
const user = { ...withoutAvatar, avatarUrl: CLERK_AVATAR };
/** What the content script relays for the web's buildAuthHandoff output. */
const handoff = (auth: unknown, summary?: unknown) => ({ type: 'content:auth_handoff', auth, user: summary });
const keysOf = (keys: string | string[]) => (Array.isArray(keys) ? keys : [keys]);
const signedIn = (summary: unknown, userId = USER_ID) => ({ signedIn: true, auth: { userId }, user: summary });

describe('auth handoff validation (QUICK-176)', () => {
  it("accepts the web's signed-in handoff and keeps only the contract fields", () => {
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, user))).toEqual(signedIn(user));
  });

  it('accepts a Sign in with Steam account: empty email, Steam nickname, undefined avatar kept as an own key', () => {
    const steam = { clerkId: USER_ID, email: '', displayName: 'steamy', avatarUrl: undefined };
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, steam))).toEqual(signedIn({ clerkId: USER_ID, email: '', displayName: 'steamy' }));
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, { clerkId: USER_ID, email: '' }))).toEqual(signedIn({ clerkId: USER_ID, email: '' }));
  });

  it.each([null, undefined])('accepts a signed-in handoff without a summary (user %s)', (summary) => {
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, summary))).toEqual(signedIn(null));
  });

  it.each([null, undefined])('accepts the sign-out handoff (user %s)', (summary) => {
    expect(validateAuthHandoff(handoff({}, summary))).toEqual({ signedIn: false });
    expect(validateAuthHandoff(handoff({ userId: undefined }, summary))).toEqual({ signedIn: false });
  });

  it.each([
    ['a non-object message', 'auth_handoff'],
    ['null', null],
    ['an array', [handoff({ userId: USER_ID }, user)]],
    ['another message type', { type: 'site:get_cookie', auth: {}, user: null }],
    ['an extra envelope field', { ...handoff({ userId: USER_ID }, user), plan: 'paid' }],
    ['a missing auth', { type: 'content:auth_handoff', user }],
    ['a non-object auth', handoff('user_x', user)],
    ['a class instance as auth', handoff(new Date(), user)],
    ['an extra auth field', handoff({ userId: USER_ID, token: 'x' }, user)],
    ['a user without a userId', handoff({}, user)],
    ['a non-object user', handoff({ userId: USER_ID }, USER_ID)],
    ['a subscription in the user', handoff({ userId: USER_ID }, { ...user, subscription: { status: 'active' } })],
    ['a Steam ID in the user', handoff({ userId: USER_ID }, { ...user, steamId: '76561198000000000' })],
    ['a plan in the user', handoff({ userId: USER_ID }, { ...user, tier: 'paid' })],
    ['a non-string avatar', handoff({ userId: USER_ID }, { ...user, avatarUrl: 42 })],
    ['a null avatar', handoff({ userId: USER_ID }, { ...user, avatarUrl: null })],
    ['a non-string display name', handoff({ userId: USER_ID }, { ...user, displayName: 42 })],
    ['a null display name', handoff({ userId: USER_ID }, { ...user, displayName: null })],
    ['a display name list', handoff({ userId: USER_ID }, { ...user, displayName: ['Alice'] })],
  ])('refuses %s as invalid_shape', (_name, message) => {
    expect(validateAuthHandoff(message)).toBe('invalid_shape');
  });

  it.each(['', 'u1', 'user_', 'user_abc/../x', 'User_abc', 'user_abc ', `user_${'a'.repeat(60)}`, 42, null, ['user_abc']])('refuses the user id %j', (userId) => {
    expect(validateAuthHandoff(handoff({ userId }, null))).toBe('invalid_user_id');
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, { ...user, clerkId: userId }))).toBe('invalid_user_id');
  });

  it("refuses a summary of another account than the handoff's user", () => {
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, { ...user, clerkId: 'user_other' }))).toBe('user_mismatch');
  });

  it.each([undefined, null, 42, 'no-at-sign', 'two@@example.test', 'a b@example.test', 'a@example.test\n', 'a\u202e@example.test', `${'a'.repeat(AUTH_HANDOFF_MAX_EMAIL_LENGTH)}@x`])(
    'refuses the email %j',
    (email) => {
      expect(validateAuthHandoff(handoff({ userId: USER_ID }, { ...user, email }))).toBe('invalid_email');
    }
  );

  it.each(['Ольга 🦊', 'נועה לוי', 'مرحبا', '👩\u200d💻 dev', 'José Müller-Łukasz', 'a'.repeat(AUTH_HANDOFF_MAX_DISPLAY_NAME_LENGTH)])('keeps the display name %j', (displayName) => {
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, { ...user, displayName }))).toEqual(signedIn({ ...user, displayName }));
  });

  // A name is display text only: one that fails the limits is dropped, and the user id still updates.
  it.each([
    '',
    'a'.repeat(AUTH_HANDOFF_MAX_DISPLAY_NAME_LENGTH + 1),
    'Alice\u0000',
    'Alice\nSupport',
    'Alice\u0085',
    'emordnilap\u202e',
    'evil\u202emoc.test',
    '\u2066Alice',
    '\u200fנועה Levi',
    '\u200eAlice',
    '\u061cAlice',
    'Alice\ud800',
  ])('drops the display name %j and keeps the rest', (displayName) => {
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, { ...user, displayName }))).toEqual(signedIn(withoutName));
  });

  it.each([
    'http://img.clerk.com/x',
    'https://evil.test/a.png',
    'https://img.clerk.com.evil.test/a.png',
    'https://avatars.steamstatic.com.evil.test/a.png',
    'https://user:secret@img.clerk.com/a.png',
    'https://img.clerk.com:8443/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,iVBORw0KGgo=',
    '//img.clerk.com/a.png',
    'not a url',
    `https://img.clerk.com/${'a'.repeat(AUTH_HANDOFF_MAX_AVATAR_URL_LENGTH)}`,
  ])('drops the avatar %s and keeps the rest', (avatarUrl) => {
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, { ...user, avatarUrl }))).toEqual(signedIn(withoutAvatar));
  });

  it.each([
    'https://avatars.steamstatic.com/abc_full.jpg',
    'https://avatars.akamai.steamstatic.com/abc_full.jpg',
    'https://avatars.cloudflare.steamstatic.com/abc_full.jpg',
    'https://avatars.fastly.steamstatic.com/abc_full.jpg',
    'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/ab/abc_full.jpg',
  ])('keeps the Steam avatar %s', (avatarUrl) => {
    expect(validateAuthHandoff(handoff({ userId: USER_ID }, { ...user, avatarUrl }))).toEqual(signedIn({ ...user, avatarUrl }));
  });

  describe('storage cap', () => {
    const userId = `user_${'a'.repeat(59)}`;
    // Quotes and backslashes double in JSON: the worst case for every text field.
    const largest = {
      clerkId: userId,
      email: `${'"'.repeat(AUTH_HANDOFF_MAX_EMAIL_LENGTH / 2)}@${BACKSLASH.repeat(AUTH_HANDOFF_MAX_EMAIL_LENGTH / 2 - 1)}`,
      displayName: '"'.repeat(AUTH_HANDOFF_MAX_DISPLAY_NAME_LENGTH),
    };
    // The URL parser keeps backslashes in the query, so this href is 2,048 characters and its JSON almost twice that.
    const backslashAvatar = `https://img.clerk.com/?${BACKSLASH.repeat(AUTH_HANDOFF_MAX_AVATAR_URL_LENGTH - 'https://img.clerk.com/?'.length)}`;
    const stored = (summary: unknown) => JSON.stringify({ auth: { userId }, user: summary }).length;

    it('keeps the largest fields with an avatar that fits', () => {
      const avatarUrl = `https://img.clerk.com/${'a'.repeat(AUTH_HANDOFF_MAX_AVATAR_URL_LENGTH - 'https://img.clerk.com/'.length)}`;
      expect(validateAuthHandoff(handoff({ userId }, { ...largest, avatarUrl }))).toEqual(signedIn({ ...largest, avatarUrl }, userId));
      expect(stored({ ...largest, avatarUrl })).toBeLessThanOrEqual(AUTH_HANDOFF_MAX_STORED_LENGTH);
    });

    it('drops an avatar that would take the stored identity over the cap, and keeps the rest', () => {
      expect(new URL(backslashAvatar).href).toBe(backslashAvatar);
      expect(stored({ ...largest, avatarUrl: backslashAvatar })).toBeGreaterThan(AUTH_HANDOFF_MAX_STORED_LENGTH);
      expect(validateAuthHandoff(handoff({ userId }, { ...largest, avatarUrl: backslashAvatar }))).toEqual(signedIn(largest, userId));
      expect(stored(largest)).toBeLessThan(1300);
      // Even with an ordinary name and email the avatar alone would cross the cap.
      expect(validateAuthHandoff(handoff({ userId: USER_ID }, { ...user, avatarUrl: backslashAvatar }))).toEqual(signedIn(withoutAvatar));
    });
  });
});

describe('auth handoff through the runtime entry point (QUICK-176)', () => {
  const sender = { id: 'qts', tab: { id: 2 }, frameId: 0, origin: 'https://app.quicktrade.skin', url: 'https://app.quicktrade.skin/sell-mode' };
  const pageOn = (origin: string) => ({ ...sender, origin, url: `${origin}/sell-mode` });
  let store: Record<string, unknown>;
  const previous = { qts_auth_token: { userId: 'user_previous' }, qts_user: { clerkId: 'user_previous', email: 'old@example.test' } };

  async function send(message: unknown, origin = sender.origin): Promise<unknown> {
    const reply = vi.fn();
    expect(onRuntimeMessage(message, pageOn(origin), reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    return reply.mock.calls[0]?.[0];
  }

  beforeEach(() => {
    store = { ...previous, other: 1 };
    vi.stubGlobal('browser', {
      runtime: { id: 'qts', getURL: () => 'chrome-extension://qts/' },
      storage: {
        local: {
          set: vi.fn(async (values: Record<string, unknown>) => void Object.assign(store, structuredClone(values))),
          remove: vi.fn(async (keys: string | string[]) => keysOf(keys).forEach((key) => delete store[key])),
        },
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores only the validated subset', async () => {
    expect(await send(handoff({ userId: USER_ID }, { ...user, avatarUrl: 'https://tracker.evil.test/pixel.png' }))).toEqual({ ok: true, data: null });
    expect(store).toEqual({ qts_auth_token: { userId: USER_ID }, qts_user: withoutAvatar, other: 1 });
  });

  it('stores the new account without a display name it cannot show', async () => {
    expect(await send(handoff({ userId: USER_ID }, { ...user, displayName: 'evil\u202emoc.test' }))).toEqual({ ok: true, data: null });
    expect(store).toEqual({ qts_auth_token: { userId: USER_ID }, qts_user: withoutName, other: 1 });
  });

  it.each([
    ['invalid_shape', handoff({ userId: USER_ID }, { ...user, subscription: { status: 'active' } })],
    ['invalid_user_id', handoff({ userId: 'admin' }, null)],
    ['user_mismatch', handoff({ userId: USER_ID }, { ...user, clerkId: 'user_other' })],
    ['invalid_email', handoff({ userId: USER_ID }, { ...user, email: 'x'.repeat(100_000) })],
  ])('refuses %s with a typed error and leaves storage unchanged', async (reason, message) => {
    expect(await send(message)).toEqual({ ok: false, error: `auth_handoff_refused:${reason}` });
    expect(store).toEqual({ ...previous, other: 1 });
  });

  it('clears the identity on sign-out', async () => {
    expect(await send(handoff({}, null))).toEqual({ ok: true, data: null });
    expect(store).toEqual({ other: 1 });
  });

  it("never keeps the previous account's summary when the new one comes without it", async () => {
    expect(await send(handoff({ userId: USER_ID }, null))).toEqual({ ok: true, data: null });
    expect(store).toEqual({ qts_auth_token: { userId: USER_ID }, other: 1 });
  });

  it.each(['https://app.quicktrade.skin'])('stores the handoff from the web app on %s', async (origin) => {
    expect(await send(handoff({ userId: USER_ID }, user), origin)).toEqual({ ok: true, data: null });
    expect(store).toEqual({ qts_auth_token: { userId: USER_ID }, qts_user: user, other: 1 });
  });

  it.each([
    'https://evil.test',
    'https://quicktrade.skin',
    'https://evil-quicktrade.skin',
    'https://app.quicktrade.skin.evil.com',
    'http://app.quicktrade.skin',
    'https://quicktrade.skin.evil.com',
    'https://x.app.quicktrade.skin',
  ])('refuses the handoff from %s before validating it', async (origin) => {
    const reply = vi.fn();
    expect(onRuntimeMessage(handoff({ userId: USER_ID }, user), pageOn(origin), reply)).toBe(false);
    expect(reply).toHaveBeenCalledWith({ ok: false, error: 'bridge_forbidden_origin' });
    expect(store).toEqual({ ...previous, other: 1 });
  });
});

// ─── The stored identity is write-only: nothing in the extension reads it (QUICK-176) ─────────────────────────────

const IDENTITY_KEYS = new Set(['authToken', 'user']);
const IDENTITY_VALUES = new Set(['qts_auth_token', 'qts_user']);
const IDENTITY_TYPES = new Set(['AuthState', 'AuthUserSummary']);

/** `StorageKeys`, or `<namespace>.StorageKeys`. */
function isStorageKeys(node: ts.Node): boolean {
  return (ts.isIdentifier(node) && node.text === 'StorageKeys') || (ts.isPropertyAccessExpression(node) && node.name.text === 'StorageKeys');
}

/** `StorageKeys` used other than for a static member, its declaration or a plain import: spread, destructured, enumerated, renamed, re-exported. */
function isWholeObjectUse(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isIdentifier(node)) {
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
    if (ts.isImportSpecifier(parent)) return parent.propertyName !== undefined;
  }
  return !((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node);
}

/** The key declaration itself: `StorageKeys = { authToken: 'qts_auth_token', user: 'qts_user', … } as const`. */
function isKeyDeclaration(literal: ts.StringLiteralLike): boolean {
  const property = literal.parent;
  if (!ts.isPropertyAssignment(property) || property.initializer !== literal) return false;
  let holder: ts.Node = property.parent.parent;
  while (ts.isAsExpression(holder) || ts.isSatisfiesExpression(holder) || ts.isParenthesizedExpression(holder)) holder = holder.parent;
  return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) && holder.name.text === 'StorageKeys';
}

/** Every way a source file can reach the stored identity, read from its syntax tree (comments do not count). */
function identityReferences(fileName: string, text: string): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isStorageKeys(node.expression)) {
      if (IDENTITY_KEYS.has(node.name.text)) found.add(`StorageKeys.${node.name.text}`);
    } else if (ts.isElementAccessExpression(node) && isStorageKeys(node.expression)) {
      const key = node.argumentExpression;
      if (!ts.isStringLiteralLike(key)) found.add('StorageKeys[computed]');
      else if (IDENTITY_KEYS.has(key.text)) found.add(`StorageKeys.${key.text}`);
    } else if (isStorageKeys(node) && isWholeObjectUse(node)) {
      found.add('StorageKeys as a whole');
    } else if (ts.isStringLiteralLike(node) && IDENTITY_VALUES.has(node.text) && !isKeyDeclaration(node)) {
      found.add(`'${node.text}'`);
    } else if (ts.isIdentifier(node) && IDENTITY_TYPES.has(node.text)) {
      found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return [...found].toSorted();
}

describe('the page-supplied identity is write-only (QUICK-176)', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.output', '.wxt', '__tests__', 'public', 'data']);
  // Every source file that may reach the identity, and what it may reach. The key declaration in shared/storage.ts
  // is not a reference; anything else there (a helper, a re-exported type) would be.
  const EXPECTED: Record<string, string[]> = {
    'background/auth-handoff-policy.ts': ['AuthUserSummary'], // validates the page message
    'background/handlers/content.ts': ['StorageKeys.authToken', 'StorageKeys.user'], // stores the validated subset
    'background/services/auth.ts': ['StorageKeys.authToken', 'StorageKeys.user'], // clears it on sign-out
  };

  function sources(dir: string, relativePath = relative): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sources(join(dir, entry.name), relativePath);
      return /\.tsx?$/.test(entry.name) ? [relativePath(root, join(dir, entry.name)).replace(/\\/g, '/')] : [];
    });
  }
  const read = (file: string) => readFileSync(join(root, file), 'utf8');

  it.each([
    ['native', relative],
    ['Windows', win32.relative],
  ] as const)('is reached only by the handoff writer, sign-out clearing and the validator (%s paths)', (_name, relativePath) => {
    const files = sources(root, relativePath);
    expect(files).toEqual(expect.arrayContaining(['background/scheduler.ts', 'entrypoints/content.ts', 'shared/storage.ts']));
    const references = Object.fromEntries(files.map((file) => [file, identityReferences(file, read(file))]).filter(([, found]) => found.length > 0));
    expect(references).toEqual(EXPECTED);
  });

  it('is never read: the writer, sign-out and the validator do not read storage', () => {
    for (const file of Object.keys(EXPECTED)) expect(read(file)).not.toMatch(/storage\.local\.get|storageGet|onChanged/);
  });

  it('is only declared in shared/storage.ts, which exposes no reader of it', () => {
    const storage = read('shared/storage.ts');
    expect(identityReferences('shared/storage.ts', storage)).toEqual([]);
    // The declaration is still there (the scan above is not vacuous), and nothing else in the module names the keys.
    expect(storage.match(/'qts_auth_token'|'qts_user'/g)).toEqual(['qts_auth_token', 'qts_user'].map((key) => `'${key}'`));
    expect(storage).not.toMatch(/AuthState|AuthUserSummary|onChanged/);
  });

  it.each([
    ['dot access', 'storageGet(StorageKeys.user);'],
    ['bracket access', "browser.storage.local.get(StorageKeys['authToken']);"],
    ['double-quoted bracket access', 'StorageKeys["user"];'],
    ['optional chaining', 'StorageKeys?.user;'],
    ['a computed key', 'StorageKeys[name];'],
    ['destructuring', 'const { user } = StorageKeys;'],
    ['enumerating the keys', 'Object.values(StorageKeys);'],
    ['a renamed import', "import { StorageKeys as Keys } from '@/shared/storage';"],
    ['a namespace import', "import * as storage from '@/shared/storage'; storage.StorageKeys.user;"],
    ['a re-export', "export { StorageKeys } from '@/shared/storage';"],
    ['the raw key', "browser.storage.local.get('qts_user');"],
    ['the raw key in a template', 'browser.storage.local.get(`qts_auth_token`);'],
    ['the identity type', "import type { AuthState } from '@qts/contracts';"],
  ])('the scan catches %s', (_name, code) => {
    expect(identityReferences('probe.tsx', code)).not.toEqual([]);
  });

  it('the scan ignores the other keys, a plain import and comments', () => {
    const code = "import { StorageKeys } from '@/shared/storage';\n// StorageKeys.user\nstorageGet(StorageKeys.loginStatuses);\nStorageKeys['platformCatalog'];";
    expect(identityReferences('probe.ts', code)).toEqual([]);
  });
});
