import type { AuthUserSummary } from '@qts/contracts';

/**
 * `qts:auth_handoff` (QUICK-176). Any script on the web origin can post one, so the identity in it is never trusted:
 * plan and access are enforced by the server and the web, and nothing in the extension reads the stored identity
 * (asserted in auth-handoff.test.ts). Hence no signed token: the background stores only this strictly validated,
 * size-capped subset. A malformed shape, id or email refuses the handoff and leaves what is stored unchanged; a display
 * name or an avatar that fails its limits is dropped and the rest is stored.
 */
export type AuthHandoffRefusal = 'invalid_shape' | 'invalid_user_id' | 'user_mismatch' | 'invalid_email' | 'too_large';

export type AuthHandoff = { signedIn: false } | { signedIn: true; auth: { userId: string }; user: AuthUserSummary | null };

/**
 * Bound on the stored identity (auth + user as JSON). Without the avatar the field limits keep it near 1,200 characters
 * at most; an avatar that would take it over the bound is dropped (a URL keeps backslashes in its query, which JSON
 * doubles), so `too_large` is only a backstop.
 */
export const AUTH_HANDOFF_MAX_STORED_LENGTH = 4096;
export const AUTH_HANDOFF_MAX_EMAIL_LENGTH = 254;
export const AUTH_HANDOFF_MAX_DISPLAY_NAME_LENGTH = 256;
export const AUTH_HANDOFF_MAX_AVATAR_URL_LENGTH = 2048;

/** Clerk user ids: `user_` and base62 (27 characters today). */
const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,59}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
/** Controls, lone surrogates and bidi marks: nothing a name or an address needs, and bidi marks reorder displayed text. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/** Avatar hosts the web itself trusts: Clerk's image CDN (its CSP) and Steam's avatar CDNs (the server's Steam profile client). */
const AVATAR_HOSTS: ReadonlySet<string> = new Set([
  'img.clerk.com',
  'avatars.steamstatic.com',
  'avatars.akamai.steamstatic.com',
  'avatars.cloudflare.steamstatic.com',
  'avatars.fastly.steamstatic.com',
  'steamcdn-a.akamaihd.net',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An own key holding `undefined` counts as absent: Firefox's structured clone keeps it, Chrome's JSON drops it. */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && (keys.includes(key) || value[key] === undefined));
}

function isClerkUserId(value: unknown): value is string {
  return typeof value === 'string' && CLERK_USER_ID.test(value);
}

function isEmail(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || (value.length <= AUTH_HANDOFF_MAX_EMAIL_LENGTH && EMAIL.test(value) && !UNSAFE_TEXT.test(value)));
}

/** A name within the limits; any other name is dropped, never a reason to refuse the handoff. */
function shownName(value: string): string | undefined {
  return value.length > 0 && value.length <= AUTH_HANDOFF_MAX_DISPLAY_NAME_LENGTH && !UNSAFE_TEXT.test(value) ? value : undefined;
}

/** An https URL on a known avatar host (no credentials or port), normalized; anything else is dropped, not refused. */
function shownAvatarUrl(value: string): string | undefined {
  if (value.length > AUTH_HANDOFF_MAX_AVATAR_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !AVATAR_HOSTS.has(url.hostname)) return undefined;
    return url.href.length <= AUTH_HANDOFF_MAX_AVATAR_URL_LENGTH ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The summary without its avatar, and the avatar kept apart so the size bound can drop it alone. */
function validateUser(user: unknown, userId: string): { summary: AuthUserSummary; avatarUrl: string | undefined } | AuthHandoffRefusal {
  if (!isPlainObject(user) || !hasOnlyKeys(user, ['clerkId', 'email', 'displayName', 'avatarUrl'])) return 'invalid_shape';
  const { clerkId, email, displayName, avatarUrl } = user;
  if (!isClerkUserId(clerkId)) return 'invalid_user_id';
  if (clerkId !== userId) return 'user_mismatch';
  if (!isEmail(email)) return 'invalid_email';
  if ((displayName !== undefined && typeof displayName !== 'string') || (avatarUrl !== undefined && typeof avatarUrl !== 'string')) return 'invalid_shape';
  const name = displayName === undefined ? undefined : shownName(displayName);
  return { summary: { clerkId, email, ...(name === undefined ? {} : { displayName: name }) }, avatarUrl: avatarUrl === undefined ? undefined : shownAvatarUrl(avatarUrl) };
}

function storedLength(auth: { userId: string }, user: AuthUserSummary | null): number {
  return JSON.stringify({ auth, user }).length;
}

/** The `content:auth_handoff` runtime message the content script relays: `{ type, auth, user? }`. */
export function validateAuthHandoff(message: unknown): AuthHandoff | AuthHandoffRefusal {
  if (!isPlainObject(message) || !hasOnlyKeys(message, ['type', 'auth', 'user']) || message['type'] !== 'content:auth_handoff') return 'invalid_shape';
  const { auth, user } = message;
  if (!isPlainObject(auth) || !hasOnlyKeys(auth, ['userId'])) return 'invalid_shape';
  const { userId } = auth;
  // Signed out: an empty auth, and no user with it.
  if (userId === undefined) return user === undefined || user === null ? { signedIn: false } : 'invalid_shape';
  if (!isClerkUserId(userId)) return 'invalid_user_id';
  const stored = { userId };
  if (user === undefined || user === null) return { signedIn: true, auth: stored, user: null };
  const checked = validateUser(user, userId);
  if (typeof checked === 'string') return checked;
  const withAvatar = checked.avatarUrl === undefined ? checked.summary : { ...checked.summary, avatarUrl: checked.avatarUrl };
  const summary = storedLength(stored, withAvatar) <= AUTH_HANDOFF_MAX_STORED_LENGTH ? withAvatar : checked.summary;
  return storedLength(stored, summary) <= AUTH_HANDOFF_MAX_STORED_LENGTH ? { signedIn: true, auth: stored, user: summary } : 'too_large';
}

export function authHandoffRefusedError(reason: AuthHandoffRefusal): string {
  return `auth_handoff_refused:${reason}`;
}
