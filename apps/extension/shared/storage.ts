/**
 * Thin wrapper over browser.storage.local with typed get/set.
 * Used by the popup and the background service worker alike.
 */

export async function storageGet<T = Record<string, unknown>>(keys?: string | string[]): Promise<Partial<T>> {
  const result = (await browser.storage.local.get((keys ?? null) as never)) as Partial<T>;
  return result;
}

export async function storageSet(values: Record<string, unknown>): Promise<void> {
  await browser.storage.local.set(values);
}

export const StorageKeys = {
  // Page-supplied identity (QUICK-176): written by handlers/content.ts, cleared by services/auth.ts, read by nothing.
  authToken: 'qts_auth_token',
  user: 'qts_user',
  userPlatformData: 'user_platform_data',
  inventorySnapshots: 'qts_inventory_snapshots',
  platformCatalog: 'qts_platform_catalog',
  /** The account's QTS buy orders as the web last pushed them (QUICK-232, background/buy-orders-store.ts). */
  buyOrders: 'qts_buy_orders',
  /** The last three accounts' sold-elsewhere sets, pushed by the web (QUICK-217). */
  listingBlocks: 'qts_listing_blocks',
  /** The accepted signed operation table and the highest version ever accepted (operation-table-store.ts). */
  operationTable: 'qts_operation_table',
  /** The web app's interface language, kept for the removed consent tab (QUICK-202); dropped at start since 1.6.0. */
  siteLocale: 'qts_site_locale',
} as const;

export interface InventorySnapshot {
  total: number;
  onSale: number;
  updatedAt: number;
}
