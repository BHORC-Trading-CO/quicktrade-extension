import { isRecord } from './wire';

/**
 * The account's working browser (QUICK-305): one browser of an account does the work nobody watches, so two browsers
 * never send the same marketplace requests twice. Its extension runs the scheduled rules (price ramps, one-shot
 * listings, price followers); its pages read the trade feeds in the background. Every other browser's extension keeps
 * its rules and waits, and its pages leave those background reads to the working one. What the user does by hand
 * (a Refresh, a listing, a competitor search) runs in any browser.
 *
 * The server keeps one lease per account (`active_browsers`). A page claims it for its browser: it gets it when nobody
 * holds a live lease, when its own browser holds it, when the user asks ("Run here"), or when a visible page asks while
 * the holder has had no page in front of the user for `ACTIVE_BROWSER_TAB_SEEN_MS` (the user moved to this browser).
 * The page hands the answer to its extension with a device token, which the extension uses alone, with every tab
 * closed: to renew the lease it holds, and on standby to take a lease that ran out (the other browser was closed). The
 * token can do nothing else.
 */

/** A lease not renewed for this long runs out: a server outage shorter than this never stops a running browser. */
export const ACTIVE_BROWSER_LEASE_TTL_MS = 15 * 60_000;
/** The holding extension renews at most this often while it works; a visible page claims this often. */
export const ACTIVE_BROWSER_RENEW_MS = 60_000;
/** How often an extension renews, or checks on standby, while it has nothing to do. */
export const ACTIVE_BROWSER_STANDBY_MS = 5 * 60_000;
/** A holder whose pages were not in front of the user for this long gives way to a visible page of another browser. */
export const ACTIVE_BROWSER_TAB_SEEN_MS = 2 * 60_000;
/**
 * "Run here" holds: for this long a visible page of another browser does not take the lease back on its own (the user
 * chose this browser; they take it back with "Run here" there). A lease that runs out ends it sooner.
 */
export const ACTIVE_BROWSER_TAKEOVER_HOLD_MS = 60 * 60_000;
/** Browsers an account keeps tokens for; the one seen longest ago goes first. */
export const ACTIVE_BROWSER_MAX_DEVICES = 10;
/** A browser not seen for this long is forgotten (its token stops working). */
export const ACTIVE_BROWSER_DEVICE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const ACTIVE_BROWSER_DEVICE_LABEL_MAX = 60;

export const ACTIVE_BROWSER_DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The server's device tokens: 32 random bytes, base64url. */
export const ACTIVE_BROWSER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LEASE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CLERK_ID = /^user_[A-Za-z0-9]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Who works for the account now. */
export interface ActiveBrowserHolder {
  deviceId: string;
  deviceLabel: string | null;
  renewedAt: number;
  expiresAt: number;
  /** The last time one of its pages claimed while in front of the user; null when none did. */
  tabSeenAt: number | null;
}

/** `GET /api/active-browser`. */
export interface ActiveBrowserStatus {
  serverNow: number;
  /** The live lease; null when none is live. */
  holder: ActiveBrowserHolder | null;
}

/** `POST /api/active-browser/claim`, by a page of the browser. */
export interface ActiveBrowserClaim {
  deviceId: string;
  deviceLabel?: string;
  /** The page is in front of the user. */
  visible: boolean;
  /** "Run here": take the lease from the browser that holds it. */
  takeover?: boolean;
  /** The extension has no token for this account: the answer carries a new one (the old one stops working). */
  wantToken?: boolean;
}

/** The claim's answer: whether this browser works now, and (when asked, or when the lease is new) its token. */
export interface ActiveBrowserClaimResult extends ActiveBrowserStatus {
  granted: boolean;
  /** The lease this browser holds; null when not granted. */
  leaseId: string | null;
  token?: string;
}

/** `POST /api/active-browser/renew`, by the extension alone (no session: the device token). */
export interface ActiveBrowserRenew {
  deviceId: string;
  token: string;
}

/**
 * The renew's answer. `holds`: the lease is this browser's (renewed, or taken because none was live); else another
 * browser works and this one waits. A token the server does not know is a 401 (the extension drops it).
 */
export interface ActiveBrowserRenewResult {
  serverNow: number;
  holds: boolean;
  leaseId: string | null;
  expiresAt: number | null;
}

// ─── Page ↔ extension (capability `active_browser`) ─────────────────────────────────────────────────

/**
 * The page's `set_active_browser`: the claim's answer for the signed-in account, with this computer's clock around the
 * request (the extension keeps the server's clock from it). Answered with `active_browser`.
 */
export interface ActiveBrowserPush {
  clerkId: string;
  holds: boolean;
  leaseId: string | null;
  expiresAt: number | null;
  serverNow: number;
  /** A new device token, when the server issued one. */
  token?: string;
  requestedAt: number;
  receivedAt: number;
}

/** The extension's `active_browser`: what it holds. */
export interface ActiveBrowserView {
  requestId?: string;
  deviceId: string;
  /** The account it works for; null before a page told it one (it then runs its rules as before QUICK-305). */
  clerkId: string | null;
  holds: boolean;
  /** It runs scheduled rules now (holds a live lease, or was never told about one). */
  working: boolean;
  expiresAt: number | null;
  /** It has a device token for `clerkId`. */
  hasToken: boolean;
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isActiveBrowserDeviceId(value: unknown): value is string {
  return typeof value === 'string' && ACTIVE_BROWSER_DEVICE_ID_PATTERN.test(value);
}

/** A device label as the server keeps it: one line, at most `ACTIVE_BROWSER_DEVICE_LABEL_MAX` characters; else null. */
export function cleanActiveBrowserLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (!label || label.length > ACTIVE_BROWSER_DEVICE_LABEL_MAX || CONTROL.test(label)) return null;
  return label;
}

function parseHolder(value: unknown): ActiveBrowserHolder | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { deviceId, deviceLabel, renewedAt, expiresAt, tabSeenAt } = value;
  if (!isActiveBrowserDeviceId(deviceId) || !time(renewedAt) || !time(expiresAt)) return undefined;
  if (deviceLabel !== null && cleanActiveBrowserLabel(deviceLabel) === null) return undefined;
  if (tabSeenAt !== null && !time(tabSeenAt)) return undefined;
  return {
    deviceId: deviceId.toLowerCase(),
    deviceLabel: deviceLabel as string | null,
    renewedAt,
    expiresAt,
    tabSeenAt: tabSeenAt as number | null,
  };
}

/** The server's status answer; null when it is not one. */
export function parseActiveBrowserStatus(value: unknown): ActiveBrowserStatus | null {
  if (!isRecord(value) || !time(value['serverNow'])) return null;
  const holder = parseHolder(value['holder']);
  if (holder === undefined) return null;
  return { serverNow: value['serverNow'], holder };
}

/** The server's claim answer; null when it is not one. */
export function parseActiveBrowserClaimResult(value: unknown): ActiveBrowserClaimResult | null {
  const status = parseActiveBrowserStatus(value);
  if (!status || !isRecord(value)) return null;
  const { granted, leaseId, token } = value;
  if (typeof granted !== 'boolean') return null;
  if (granted ? typeof leaseId !== 'string' || !LEASE_ID.test(leaseId) : leaseId !== null) return null;
  if (token !== undefined && (typeof token !== 'string' || !ACTIVE_BROWSER_TOKEN_PATTERN.test(token))) return null;
  return { ...status, granted, leaseId: leaseId as string | null, ...(token !== undefined ? { token } : {}) };
}

/** The server's renew answer; null when it is not one. */
export function parseActiveBrowserRenewResult(value: unknown): ActiveBrowserRenewResult | null {
  if (!isRecord(value)) return null;
  const { serverNow, holds, leaseId, expiresAt } = value;
  if (!time(serverNow) || typeof holds !== 'boolean') return null;
  if (
    holds
      ? typeof leaseId !== 'string' || !LEASE_ID.test(leaseId) || !time(expiresAt)
      : leaseId !== null || expiresAt !== null
  )
    return null;
  return { serverNow, holds, leaseId: leaseId as string | null, expiresAt: expiresAt as number | null };
}

/** The page's `set_active_browser`; null when it is not one (the extension keeps what it had). */
export function parseActiveBrowserPush(value: unknown): ActiveBrowserPush | null {
  if (!isRecord(value)) return null;
  const { clerkId, holds, leaseId, expiresAt, serverNow, token, requestedAt, receivedAt } = value;
  if (typeof clerkId !== 'string' || !CLERK_ID.test(clerkId) || typeof holds !== 'boolean') return null;
  if (!time(serverNow) || !time(requestedAt) || !time(receivedAt) || receivedAt < requestedAt) return null;
  if (
    holds
      ? typeof leaseId !== 'string' || !LEASE_ID.test(leaseId) || !time(expiresAt)
      : leaseId !== null || expiresAt !== null
  )
    return null;
  if (token !== undefined && (typeof token !== 'string' || !ACTIVE_BROWSER_TOKEN_PATTERN.test(token))) return null;
  return {
    clerkId,
    holds,
    leaseId: leaseId as string | null,
    expiresAt: expiresAt as number | null,
    serverNow,
    ...(token !== undefined ? { token } : {}),
    requestedAt,
    receivedAt,
  };
}

/** The extension's `active_browser`; null when it is not one. */
export function parseActiveBrowserView(value: unknown): ActiveBrowserView | null {
  if (!isRecord(value)) return null;
  const { requestId, deviceId, clerkId, holds, working, expiresAt, hasToken } = value;
  if (requestId !== undefined && typeof requestId !== 'string') return null;
  if (
    !isActiveBrowserDeviceId(deviceId) ||
    (clerkId !== null && (typeof clerkId !== 'string' || !CLERK_ID.test(clerkId)))
  )
    return null;
  if (typeof holds !== 'boolean' || typeof working !== 'boolean' || typeof hasToken !== 'boolean') return null;
  if (expiresAt !== null && !time(expiresAt)) return null;
  return {
    ...(requestId !== undefined ? { requestId } : {}),
    deviceId: deviceId.toLowerCase(),
    clerkId: clerkId as string | null,
    holds,
    working,
    expiresAt: expiresAt as number | null,
    hasToken,
  };
}
