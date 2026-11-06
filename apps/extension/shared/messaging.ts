/**
 * Typed runtime-message bridge between popup ↔ background service worker.
 * The background dispatches by `type` and returns the `response` payload.
 *
 * Shared envelope types for the page ↔ extension bridge live in
 * `@qts/contracts` (browser-API-free so the web app can import them too).
 */

import type { Platform, PlatformUser } from '@qts/contracts';
export type { Platform, PlatformUser };

export type RuntimeMessage =
  | { type: 'popup:get_platforms_status' }
  | { type: 'popup:refresh_inventory'; platforms?: Platform[] }
  | { type: 'popup:trigger_sync'; platforms?: Platform[] }
  | { type: 'popup:logout' };

export type RuntimeResponse<T> = { ok: true; data: T } | { ok: false; error: string };

export interface PlatformStatus {
  platform: Platform;
  user: PlatformUser;
  inventoryCount: number;
  onSaleCount: number;
}
