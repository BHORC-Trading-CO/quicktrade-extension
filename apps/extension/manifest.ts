import type { ConfigEnv, UserManifest } from 'wxt';

import { version } from './package.json';
import { appMatchPatterns } from './shared/bridge-policy';

const CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnH7sZla3PIvz0oZTBTWwDeOiPLrl1RLCE6XxKYUaSTQLGAAxWDIy0Y45MIbz4NuiFXljnf7C/Ls2cRB2GrByHavsHgVn3Ng/qMFBoHTrHsJALesCtn2XG0MkP7du7LlpDSO5nKG7AeBLKwgrddy/rke1JnJhTvzMAntYZxJT9bQwlIwzkv9j600QkL9ujoqFuHPf5ao/Cf0lVgdxS8flaaQ01RgHgmc10LfQRX01GlZg405it6ZSMgxw6pHtdeOJahKuJU4hU1o6Q5nKByjiOL72snMn2eFzOLLUpZM+tOoXy/6DYMB8M+ZmByfUqoBlg5weL1ndFlfoLYWso7sVpQIDAQAB';

export const OPTIONAL_MARKETPLACE_ORIGINS = ['https://*/*'] as const;

export default function manifest({ browser, mode }: Pick<ConfigEnv, 'browser' | 'mode'>): UserManifest {
  const isChrome = browser === 'chrome';

  return {
    manifest_version: 3,
    // Name and description per browser language (QUICK-189): public/_locales/<code>/messages.json. The name is
    // QuickTrade.skin in every language; English is the fallback.
    name: '__MSG_extName__',
    version,
    description: '__MSG_extDescription__',
    default_locale: 'en',
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      64: 'icons/64.png',
      128: 'icons/128.png',
    },
    action: {
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        64: 'icons/64.png',
        128: 'icons/128.png',
      },
    },
    // Only APIs the extension calls (QUICK-175). `unlimitedStorage` is not an API: it lifts the storage.local
    // quota (5 MB before Chrome 114, 10 MB after) for the scheduler, which keeps one ~1.2-1.6 KB rule per
    // item and marketplace with no count limit, plus retired rules for 7 days and paused ones for 30.
    // No web_accessible_resources: no page loads extension files, and declaring any lets every site probe
    // the fixed Chrome id to detect the extension.
    permissions: ['storage', 'unlimitedStorage', 'scripting', 'cookies', 'alarms', 'declarativeNetRequest', 'declarativeNetRequestWithHostAccess'],
    // Host permissions granted at install:
    //  - the web app's own origins, so the background can re-inject the content script into open app
    //    tabs when the extension is re-enabled (scripting.executeScript + tabs.query need host access);
    //  - cs.money, csfloat.com and steamcommunity.com, the ACTIVE_PLATFORMS, are granted by default so
    //    the core selling flow (plus the Steam profile / inventory / market lookups it depends on) works
    //    out of the box. Every other marketplace stays optional and is granted by the user from the
    //    popup (optional_host_permissions below).
    host_permissions: [...appMatchPatterns(mode), 'https://cs.money/*', 'https://csfloat.com/*', 'https://steamcommunity.com/*'],
    optional_host_permissions: [...OPTIONAL_MARKETPLACE_ORIGINS],
    ...(isChrome
      ? {
          key: CHROME_KEY,
          incognito: 'split',
          // DNR initiatorDomains / excludedInitiatorDomains (every page rule and HaloSkins 1014) need Chrome 101.
          minimum_chrome_version: '101',
        }
      : {
          browser_specific_settings: {
            gecko: {
              id: 'quicktrade@bhorc.io',
              // Firefox 140 provides the built-in consent prompt for these required data uses.
              strict_min_version: '140.0',
              data_collection_permissions: {
                required: ['authenticationInfo', 'websiteContent'],
                optional: [],
              },
            },
          },
        }),
  };
}
