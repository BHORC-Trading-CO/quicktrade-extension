/**
 * The sell-mode panel caches (QUICK-210): the last answer of the item panel's Competitors, Instant sell and Sale history
 * tabs per asset, kept on the server under the Clerk account (`/api/panel-cache`). The payload is the web's own record,
 * opaque to the server: only the same account reads it back, and the web never renders it as HTML.
 */

/** The three right-panel tabs whose last answer is kept. */
export const PANEL_CACHE_KINDS = ['competitors', 'instantSell', 'saleHistory'] as const;
export type PanelCacheKind = (typeof PANEL_CACHE_KINDS)[number];

/** How long an entry is kept after `cachedAt` (also the server's TTL index). */
export const PANEL_CACHE_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Largest payload (UTF-8 bytes of its JSON) the server stores. A competitor record of a heavily listed skin is larger:
 * the web trims its longest lists until it fits rather than failing the save.
 */
export const PANEL_CACHE_MAX_PAYLOAD_BYTES = 768 * 1024;

/** Largest `scope` (sale history only): the account, the linked Steam identity and the policy of the search. */
export const PANEL_CACHE_MAX_SCOPE_LENGTH = 512;

/** `PUT /api/panel-cache/:kind/:assetId`. */
export interface PanelCacheWriteRequest {
  /** ms epoch, the client's clock: freshness and retention are measured from it. */
  cachedAt: number;
  /** Required for `saleHistory`, refused for the other kinds. */
  scope?: string;
  payload: Record<string, unknown>;
}

export interface PanelCacheEntry {
  kind: PanelCacheKind;
  assetId: string;
  cachedAt: number;
  scope?: string;
  payload: Record<string, unknown>;
}

/** `GET /api/panel-cache/:kind/:assetId[?scope=]`: null when nothing (or nothing in that scope) is kept. */
export interface PanelCacheReadResponse {
  entry: PanelCacheEntry | null;
}
