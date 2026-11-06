import type { ConnectablePlatform, PlatformPermissionState } from '@qts/contracts';
import { PLATFORM_CONNECTIONS } from '@qts/contracts';

/**
 * Access to every bundled origin of the platform, some of them or none (QUICK-202). Read for the bundled origins, never
 * the page-published ones. A failing permissions API reads as no access.
 */
export async function platformPermission(platform: ConnectablePlatform): Promise<PlatformPermissionState> {
  const origins = PLATFORM_CONNECTIONS[platform].origins;
  const granted = await Promise.all(
    origins.map(async (origin) => {
      try {
        return await browser.permissions.contains({ origins: [origin] });
      } catch {
        return false;
      }
    })
  );
  const count = granted.filter(Boolean).length;
  if (count === origins.length) return 'granted';
  return count > 0 ? 'partial' : 'missing';
}

/** Access per platform, in the order given. */
export async function platformPermissions(platforms: readonly ConnectablePlatform[]): Promise<Partial<Record<ConnectablePlatform, PlatformPermissionState>>> {
  const states = await Promise.all(platforms.map(async (platform) => [platform, await platformPermission(platform)] as const));
  return Object.fromEntries(states);
}
