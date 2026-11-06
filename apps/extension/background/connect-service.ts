// apps/extension/background/connect-service.ts
//
// QUICK-202: removing access needs no user gesture, so `disconnect_platforms` runs here directly. Granting it does:
// see toolbar-connect.ts (the click on the toolbar icon, extension 1.6.0).
import type { ConnectablePlatform } from '@qts/contracts';
import { connectionOrigins, PLATFORM_CONNECTIONS } from '@qts/contracts';

/**
 * Asks the browser for these platforms' bundled domains at once. Must be called synchronously from the message that
 * carried the page's click: it resolves when the browser showed its prompt (whatever the answer), and false when the
 * browser refused to ask without a gesture.
 */
export function promptFromPageClick(platforms: readonly ConnectablePlatform[]): Promise<boolean> {
  return browser.permissions.request({ origins: connectionOrigins(platforms) }).then(
    (granted) => {
      console.info('[qts connect] browser prompt from the page click answered', { granted });
      return true;
    },
    (error: unknown) => {
      console.info('[qts connect] browser refused a prompt from the page click; waiting for the toolbar icon', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  );
}

/**
 * Removes the extension's optional access to these platforms, by their bundled origins. Access granted at install
 * (manifest host_permissions) cannot be removed and is skipped. The marketplace sign-in is untouched.
 */
export async function disconnectPlatforms(platforms: readonly ConnectablePlatform[]): Promise<ConnectablePlatform[]> {
  const removed: ConnectablePlatform[] = [];
  for (const platform of platforms) {
    const connection = PLATFORM_CONNECTIONS[platform];
    if (connection.defaultGranted) continue;
    try {
      if (await browser.permissions.remove({ origins: [...connection.origins] })) removed.push(platform);
    } catch {
      // The browser kept the access: reported as not removed.
    }
  }
  return removed;
}
