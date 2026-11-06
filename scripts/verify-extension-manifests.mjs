import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const requiredHosts = [
  'https://app.quicktrade.skin/*',
  'https://cs.money/*',
  'https://csfloat.com/*',
  'https://steamcommunity.com/*',
];
const optionalHosts = ['https://*/*'];
// Only APIs the extension calls; unlimitedStorage lifts the storage.local quota for scheduled rules (QUICK-175).
const apiPermissions = [
  'storage',
  'unlimitedStorage',
  'scripting',
  'cookies',
  'alarms',
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
];

// The 13 interface languages (QUICK-189) as browser _locales folders.
const extensionLocales = ['en', 'ru', 'uk', 'zh_CN', 'zh_TW', 'pt_BR', 'es', 'de', 'fr', 'pl', 'tr', 'ja', 'ko'];

async function readManifest(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

const chrome = await readManifest('../apps/extension/dist/chrome-mv3/manifest.json');
const firefox = await readManifest('../apps/extension/dist/firefox-mv2/manifest.json');

for (const manifest of [chrome, firefox]) {
  assert.ok(!JSON.stringify(manifest).includes('localhost'), 'Production manifest must not contain localhost');
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.matches),
    [['https://app.quicktrade.skin/*']]
  );
  // The bridge is never injected on server routes (JSON API, Swagger UI at /api/docs).
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.exclude_matches),
    [['https://app.quicktrade.skin/api/*']]
  );
  // No page may load extension files: any web-accessible resource lets sites detect the extension (QUICK-175).
  assert.equal(manifest.web_accessible_resources, undefined);
  // Name and description per browser language; a browser refuses a default_locale without its _locales (QUICK-189).
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.name, '__MSG_extName__');
  assert.equal(manifest.description, '__MSG_extDescription__');
}

for (const dist of ['chrome-mv3', 'firefox-mv2']) {
  const localesDir = new URL(`../apps/extension/dist/${dist}/_locales/`, import.meta.url);
  assert.deepEqual((await readdir(localesDir)).toSorted(), extensionLocales.toSorted(), `${dist} _locales`);
  for (const code of extensionLocales) {
    const messages = JSON.parse(await readFile(new URL(`${code}/messages.json`, localesDir), 'utf8'));
    assert.equal(messages.extName.message, 'QuickTrade.skin', `${dist} ${code} extName`);
    assert.ok(messages.extDescription.message, `${dist} ${code} extDescription`);
  }
}

assert.equal(chrome.manifest_version, 3);
// Page DNR rules always carry excludedInitiatorDomains (QUICK-172), which Chrome 95-100 rejects.
assert.equal(chrome.minimum_chrome_version, '101');
assert.deepEqual(chrome.permissions, apiPermissions);
assert.deepEqual(chrome.host_permissions, requiredHosts);
assert.deepEqual(chrome.optional_host_permissions, optionalHosts);
assert.equal(chrome.optional_permissions, undefined);
assert.equal(chrome.browser_specific_settings, undefined);

assert.equal(firefox.manifest_version, 2);
assert.equal(firefox.host_permissions, undefined);
assert.equal(firefox.optional_host_permissions, undefined);
assert.deepEqual(firefox.permissions, [...apiPermissions, ...requiredHosts]);
assert.deepEqual(firefox.optional_permissions, optionalHosts);
assert.deepEqual(firefox.browser_specific_settings.gecko, {
  id: 'quicktrade@bhorc.io',
  strict_min_version: '140.0',
  data_collection_permissions: {
    required: ['authenticationInfo', 'websiteContent'],
    optional: [],
  },
});

console.log('Built Chrome and Firefox marketplace permissions verified.');
