// apps/extension/background/permissions.ts
import { getPlatformCatalog } from '@/shared/platformCatalog';

/** Check (no prompt) whether a platform's origins are all already permitted. */
export async function hasPermission(platformId: string): Promise<boolean> {
  const catalog = await getPlatformCatalog();
  const entry = catalog.find((p) => p.id === platformId);
  if (!entry) return false;
  return browser.permissions.contains({ origins: entry.origins });
}

/** Returns { platformId: boolean } for all catalog platforms — true when ALL of a platform's origins are granted. */
export async function getAllPermissionsStatus(): Promise<Record<string, boolean>> {
  const catalog = await getPlatformCatalog();
  const entries = await Promise.all(catalog.map(async (p) => [p.id, await browser.permissions.contains({ origins: p.origins })] as const));
  return Object.fromEntries(entries);
}
