import { PLATFORM_CONNECTIONS } from '@qts/contracts';
import { describe, expect, it } from 'vitest';

import manifest from '../../manifest';

describe('extension marketplace permissions', () => {
  it.each(['chrome', 'firefox'] as const)('allows localhost only in development (%s)', (browser) => {
    expect(manifest({ browser, mode: 'development' }).host_permissions).toContain('http://localhost/*');
    for (const mode of ['production', 'test', 'staging']) {
      expect(JSON.stringify(manifest({ browser, mode }))).not.toContain('localhost');
    }
  });
  it('grants only the web app and core marketplaces by default', () => {
    const chromeManifest = manifest({ browser: 'chrome', mode: 'production' });

    expect(chromeManifest.host_permissions).toEqual(['https://app.quicktrade.skin/*', 'https://cs.money/*', 'https://csfloat.com/*', 'https://steamcommunity.com/*']);
    expect(chromeManifest.optional_host_permissions).toEqual(['https://*/*']);
  });

  it('grants at install exactly the marketplaces the connection table marks as default (QUICK-202)', () => {
    const defaults = Object.values(PLATFORM_CONNECTIONS).flatMap((connection) => ('defaultGranted' in connection && connection.defaultGranted ? connection.origins : []));
    const marketplaceHosts = manifest({ browser: 'chrome', mode: 'production' }).host_permissions?.filter((origin) => !origin.includes('quicktrade.skin'));
    expect(marketplaceHosts?.toSorted()).toEqual(defaults.toSorted());
  });

  it.each(['chrome', 'firefox'] as const)('declares only the APIs it calls and no web-accessible resources (%s)', (browser) => {
    // QUICK-175: webRequest and activeTab were never called; unlimitedStorage stays for the scheduler's rule storage.
    for (const mode of ['production', 'development']) {
      const built = manifest({ browser, mode });
      expect(built.permissions).toEqual(['storage', 'unlimitedStorage', 'scripting', 'cookies', 'alarms', 'declarativeNetRequest', 'declarativeNetRequestWithHostAccess']);
      // Any web-accessible resource lets a site load chrome-extension://<fixed id>/… and detect the extension.
      expect(built).not.toHaveProperty('web_accessible_resources');
    }
  });

  it.each(['chrome', 'firefox'] as const)('takes its name and description from _locales, English by default (%s)', (browser) => {
    // QUICK-189: public/_locales/<code>/messages.json; the name is QuickTrade.skin in every language.
    expect(manifest({ browser, mode: 'production' })).toMatchObject({ name: '__MSG_extName__', description: '__MSG_extDescription__', default_locale: 'en' });
  });

  it('requires the Chrome that supports DNR initiator domains', () => {
    // Every page DNR rule carries excludedInitiatorDomains (QUICK-172 T5); Chrome 95-100 rejects the key.
    expect(manifest({ browser: 'chrome', mode: 'production' }).minimum_chrome_version).toBe('101');
  });

  it('keeps the cross-browser permission contract equivalent', () => {
    const chromeManifest = manifest({ browser: 'chrome', mode: 'production' });
    const firefoxManifest = manifest({ browser: 'firefox', mode: 'production' });

    expect(firefoxManifest.permissions).toEqual(chromeManifest.permissions);
    expect(firefoxManifest.host_permissions).toEqual(chromeManifest.host_permissions);
    expect(firefoxManifest.optional_host_permissions).toEqual(chromeManifest.optional_host_permissions);
    expect(chromeManifest).not.toHaveProperty('browser_specific_settings');
    expect(firefoxManifest.browser_specific_settings?.gecko).toEqual({
      id: 'quicktrade@bhorc.io',
      strict_min_version: '140.0',
      data_collection_permissions: {
        required: ['authenticationInfo', 'websiteContent'],
        optional: [],
      },
    });
  });
});
