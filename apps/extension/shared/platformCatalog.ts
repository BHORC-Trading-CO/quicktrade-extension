// apps/extension/shared/platformCatalog.ts
import type { PlatformCatalogEntry } from '@qts/contracts';

import { storageGet, StorageKeys } from './storage';

/**
 * The platform catalog the web app published to storage (site:set_platform_catalog).
 * The web app is the single source of truth; until it has published once, this is empty
 * and the popup prompts the user to open the app.
 */
export async function getPlatformCatalog(): Promise<PlatformCatalogEntry[]> {
  const stored = await storageGet<Record<string, PlatformCatalogEntry[]>>(StorageKeys.platformCatalog);
  const catalog = stored[StorageKeys.platformCatalog];
  return Array.isArray(catalog) ? catalog : [];
}
