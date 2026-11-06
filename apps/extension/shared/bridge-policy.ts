/** One origin policy for manifests, content scripts and background sender checks. Exact origins only. */
const APP_ORIGINS: readonly string[] = ['https://app.quicktrade.skin'];

export function isDevelopmentMode(mode: string): boolean {
  return mode === 'development';
}

export function appMatchPatterns(mode: string): string[] {
  return [...(isDevelopmentMode(mode) ? ['http://localhost/*'] : []), ...APP_ORIGINS.map((origin) => `${origin}/*`)];
}

/** Server routes (JSON API, Swagger UI at /api/docs) are not app pages and never get the bridge. */
const APP_EXCLUDED_PATH = '/api/';

export function appExcludeMatchPatterns(mode: string): string[] {
  return appMatchPatterns(mode).map((pattern) => pattern.replace(/\/\*$/, `${APP_EXCLUDED_PATH}*`));
}

/** Same exclusion for injection paths that bypass the manifest (background re-injection). */
export function isExcludedAppPath(pathname: string): boolean {
  return pathname.startsWith(APP_EXCLUDED_PATH);
}

export function isAllowedAppOrigin(origin: string, mode: string): boolean {
  if (APP_ORIGINS.includes(origin)) return true;
  if (!isDevelopmentMode(mode)) return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === 'http:' && url.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Purchases (QUICK-226 `market_buy`) are asked only from the web app's own origin (plus localhost in development builds).
 * Since the apex left the bridge (QUICK-181) this equals `APP_ORIGINS`; it stays a separate list so an origin added to
 * the bridge later does not get purchases with it.
 */
const BUY_APP_ORIGINS: ReadonlySet<string> = new Set(['https://app.quicktrade.skin']);

export function isAllowedBuyOrigin(origin: string, mode: string): boolean {
  if (BUY_APP_ORIGINS.has(origin)) return true;
  return isDevelopmentMode(mode) && !APP_ORIGINS.includes(origin) && isAllowedAppOrigin(origin, mode);
}

export function appOriginFromUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

export interface BridgeSender {
  id?: string;
  tab?: { id?: number };
  frameId?: number;
  origin?: string;
  url?: string;
  /** Chrome 106+: 'prerender' while a speculatively loaded page waits for activation. */
  documentLifecycle?: string;
  /** Not part of Chrome's MessageSender today; honoured only if a browser sends it. */
  frameType?: string;
}

export type BridgeSenderError = 'bridge_untrusted_sender' | 'bridge_not_top_frame' | 'bridge_forbidden_origin';

export function pageSenderError(sender: BridgeSender, extensionId: string, mode: string): BridgeSenderError | null {
  if (!extensionId || sender.id !== extensionId) return 'bridge_untrusted_sender';
  if (!Number.isInteger(sender.tab?.id) || (sender.tab?.id ?? -1) < 0 || !isTopFrame(sender)) return 'bridge_not_top_frame';
  // Firefox MV2 may omit origin. An explicit opaque/foreign origin must never fall back to url.
  const origin = sender.origin ?? appOriginFromUrl(sender.url ?? '');
  return isAllowedAppOrigin(origin, mode) ? null : 'bridge_forbidden_origin';
}

/** `pageSenderError`, and for a purchase also the web app's own origin (`isAllowedBuyOrigin`). */
export function buySenderError(sender: BridgeSender, extensionId: string, mode: string): BridgeSenderError | null {
  const error = pageSenderError(sender, extensionId, mode);
  if (error) return error;
  const origin = sender.origin ?? appOriginFromUrl(sender.url ?? '');
  return isAllowedBuyOrigin(origin, mode) ? null : 'bridge_forbidden_origin';
}

/**
 * The primary main frame has frameId 0. Chrome gives a prerendered main frame a non-zero frameId until
 * activation; accept that only when the browser also reports the frame as outermost.
 */
function isTopFrame(sender: BridgeSender): boolean {
  if (sender.frameId === 0) return true;
  return Number.isInteger(sender.frameId) && sender.documentLifecycle === 'prerender' && sender.frameType === 'outermost_frame';
}

export function isOwnExtensionPage(sender: BridgeSender, extensionId: string, extensionRoot: string): boolean {
  if (!extensionId || sender.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    const root = new URL(extensionRoot);
    // URL.origin is "null" for extension schemes in some runtimes; compare scheme and host.
    return url.protocol === root.protocol && url.host === root.host;
  } catch {
    return false;
  }
}

export function isAllowedPageMessage(event: { source: unknown; origin: string }, page: unknown, pageOrigin: string, mode: string): boolean {
  return event.source === page && event.origin === pageOrigin && isAllowedAppOrigin(event.origin, mode);
}

export function pageTargetOrigin(origin: string, mode: string): string | null {
  return isAllowedAppOrigin(origin, mode) ? origin : null;
}
