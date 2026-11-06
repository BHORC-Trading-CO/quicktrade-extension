import type { PageDnrRule, SiteBridgeMessage } from '@qts/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPageDnrRules, migrateLegacyPageDnrRules } from '../dnr-service';
import { handleSiteMessage } from '../handlers/site';

const rule: PageDnrRule = {
  id: 2001,
  priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] },
  condition: { urlFilter: '|https://cs.money/', resourceTypes: ['xmlhttprequest', 'other'] },
};
/** The extension's own requests only (QUICK-291): its host, as the `getURL` mock below names it. */
const OWN = { initiatorDomains: ['fixture-extension'] };
/** What the extension installs for `rule`: its own requests only, and T5 excludes the marketplace's own tab. */
const installedRule: PageDnrRule = { ...rule, condition: { ...rule.condition, ...OWN, excludedInitiatorDomains: ['cs.money'] } };
const contains = vi.fn();
const getURL = vi.fn();
const updateDynamicRules = vi.fn();
const getDynamicRules = vi.fn();
let storedRules: Map<number, { id: number }>;
let grantedOrigins: Set<string>;

beforeEach(() => {
  vi.resetAllMocks();
  storedRules = new Map([[1014, { id: 1014 }]]);
  grantedOrigins = new Set(['https://cs.money/*', 'https://csfloat.com/*', 'https://steamcommunity.com/*']);
  contains.mockImplementation(async ({ origins }: { origins: string[] }) => origins.every((origin) => grantedOrigins.has(origin)));
  getURL.mockReturnValue('chrome-extension://fixture-extension/');
  getDynamicRules.mockImplementation(async () => [...storedRules.values()]);
  updateDynamicRules.mockImplementation(async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: { id: number }[] }) => {
    // Atomic, like the browser: an added id that exists and is not removed in the same call fails the whole update.
    if (addRules.some(({ id }) => storedRules.has(id) && !removeRuleIds.includes(id))) throw new Error('Rule does not have a unique ID');
    removeRuleIds.forEach((id) => storedRules.delete(id));
    addRules.forEach((entry) => storedRules.set(entry.id, structuredClone(entry)));
  });
  vi.stubGlobal('browser', { permissions: { contains }, runtime: { getURL }, declarativeNetRequest: { getDynamicRules, updateDynamicRules } });
});
afterEach(() => vi.unstubAllGlobals());

describe('page DNR installation', () => {
  it('uses real browser grants for required and optional hosts, never the page catalog', async () => {
    const optional = { ...rule, id: 2010, condition: { ...rule.condition, urlFilter: '|https://api.skinswap.com/' } };
    expect(await installPageDnrRules({ rules: [optional] })).toEqual({ status: 'rejected', installedIds: [], rejected: [{ id: 2010, reason: 'host_not_granted' }] });
    expect(updateDynamicRules).not.toHaveBeenCalled();
    grantedOrigins.add('https://api.skinswap.com/*');
    expect(await installPageDnrRules({ rules: [rule, optional] })).toEqual({ status: 'ok', installedIds: [2001, 2010], rejected: [] });
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.skinswap.com/*'] });
    expect(contains).toHaveBeenCalledWith({ origins: ['https://cs.money/*'] });
    expect(getDynamicRules).not.toHaveBeenCalled(); // no background-rule data in replies
  });
  it('installs only accepted rules and never removes rejected or reserved ids', async () => {
    storedRules.set(2002, { id: 2002 });
    const rules = [rule, { ...rule, id: 1014 }, { ...rule, id: 1001 }, { ...rule, id: 2002, action: { type: 'redirect' } }];
    const reply = await handleSiteMessage({ type: 'site:set_dnr_rules', data: { rules } });
    expect(reply).toEqual({
      ok: true,
      data: {
        status: 'partial',
        installedIds: [2001],
        rejected: [
          { id: 1014, reason: 'id_out_of_range' },
          { id: 1001, reason: 'id_out_of_range' },
          { id: 2002, reason: 'action_not_allowed' },
        ],
      },
    });
    expect(updateDynamicRules).toHaveBeenCalledExactlyOnceWith({ removeRuleIds: [2001], addRules: [installedRule] });
    expect([...storedRules.keys()]).toEqual([1014, 2002, 2001]);
  });
  it('excludes the marketplace tab for older web builds and keeps QUICK-173 lists as sent', async () => {
    grantedOrigins.add('https://api.skinswap.com/*');
    const skinswap = { ...rule, id: 2010, condition: { ...rule.condition, urlFilter: '|https://api.skinswap.com/', excludedInitiatorDomains: ['skinswap.com'] } };
    expect(await installPageDnrRules({ rules: [rule, skinswap] })).toEqual({ status: 'ok', installedIds: [2001, 2010], rejected: [] });
    expect(storedRules.get(2001)).toEqual(installedRule);
    expect(storedRules.get(2010)).toEqual({ ...skinswap, condition: { ...skinswap.condition, ...OWN } });
  });
  it.each(['foreign.test', 'cs.money.foreign.test', 'api.cs.money'])('rejects non-granted %s without broadening a grant', async (host) => {
    expect(await installPageDnrRules({ rules: [{ ...rule, condition: { ...rule.condition, urlFilter: `|https://${host}/` } }] })).toMatchObject({
      status: 'rejected',
      rejected: [{ reason: 'host_not_granted' }],
    });
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
  it.each(['app.quicktrade.skin', 'quicktrade.skin', 'localhost', 'fixture-extension'])('protects %s even if permissions say yes', async (host) => {
    contains.mockResolvedValue(true);
    expect(await installPageDnrRules({ rules: [{ ...rule, condition: { ...rule.condition, urlFilter: `|https://${host}/` } }] })).toMatchObject({ status: 'rejected' });
    expect(contains).not.toHaveBeenCalled();
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
  it('rejects all old-tab ids and oversized batches without any browser mutation', async () => {
    expect(await installPageDnrRules({ rules: [{ ...rule, id: 1001 }] })).toEqual({ status: 'rejected', installedIds: [], rejected: [{ id: 1001, reason: 'id_out_of_range' }] });
    expect(await installPageDnrRules({ rules: Array(51).fill(rule) })).toEqual({ status: 'rejected', installedIds: [], rejected: [{ id: null, reason: 'too_many_rules' }] });
    expect(contains).not.toHaveBeenCalled();
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
  it.each([null, 'payload', undefined, {}, { rules: 'rules' }])('returns typed rejection for malformed bridge payload %#', async (payload) => {
    expect(await handleSiteMessage({ type: 'site:set_dnr_rules', data: payload as SiteBridgeMessage['data'] })).toEqual({
      ok: true,
      data: { status: 'rejected', installedIds: [], rejected: [{ id: null, reason: 'invalid_shape' }] },
    });
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
  it('preserves empty-batch and unavailable-API skips', async () => {
    expect(await installPageDnrRules({ rules: [] })).toEqual({ status: 'skipped', reason: 'no rules', apiAvailable: true, installedIds: [], rejected: [] });
    vi.stubGlobal('browser', { runtime: { getURL } });
    expect(await installPageDnrRules({ rules: [rule] })).toEqual({ status: 'skipped', reason: 'api_unavailable', apiAvailable: false, installedIds: [], rejected: [] });
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
  it('fails closed on permission errors without returning browser text', async () => {
    contains.mockRejectedValue(new Error('fixture-private-browser-text'));
    const result = await installPageDnrRules({ rules: [rule] });
    expect(result).toEqual({ status: 'rejected', installedIds: [], rejected: [{ id: 2001, reason: 'host_not_granted' }] });
    expect(JSON.stringify(result)).not.toContain('fixture-private');
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
  it('does not expose header values or browser errors when atomic installation fails', async () => {
    updateDynamicRules.mockRejectedValue(new Error('invalid header value: fixture-private-browser-text'));
    const result = await handleSiteMessage({ type: 'site:set_dnr_rules', data: { rules: [rule] } });
    expect(result).toEqual({ ok: true, data: { status: 'rejected', installedIds: [], rejected: [{ id: 2001, reason: 'installation_failed' }] } });
    expect(JSON.stringify(result)).not.toContain('fixture-private');
    expect([...storedRules.keys()]).toEqual([1014]);
  });
});

// Rules as the web built them before QUICK-172 (ids 1001/1002/1007), as left installed by extension 1.0.56.
const csMoneyHeaders: PageDnrRule['action']['requestHeaders'] = [
  { header: 'Referer', operation: 'set', value: 'https://cs.money/csgo/trade/' },
  { header: 'Origin', operation: 'remove' },
  { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
  { header: 'X-Client-App', operation: 'set', value: 'web' },
];
const csFloatHeaders: PageDnrRule['action']['requestHeaders'] = [
  { header: 'Origin', operation: 'set', value: 'https://csfloat.com' },
  { header: 'Referer', operation: 'set', value: 'https://csfloat.com/' },
  { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
  { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
];
function pageRule(id: number, host: string, requestHeaders: PageDnrRule['action']['requestHeaders'], extra: Partial<PageDnrRule['condition']> = {}): PageDnrRule {
  return { id, priority: 1, action: { type: 'modifyHeaders', requestHeaders }, condition: { urlFilter: `|https://${host}/`, resourceTypes: ['xmlhttprequest', 'other'], ...extra } };
}
const legacyCsMoney = pageRule(1001, 'cs.money', csMoneyHeaders);
const legacyCsFloat = pageRule(1002, 'csfloat.com', csFloatHeaders);
const legacySkinport = pageRule(1007, 'skinport.com', [{ header: 'Origin', operation: 'set', value: 'https://skinport.com' }]);
const haloSkins = {
  id: 1014,
  priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'set', value: 'fixture' }] },
  condition: { urlFilter: '|https://www.haloskins.com/api/' },
};
/** Pre-WXT background rules (same Chrome id): deprecated `domains` and wildcard filters. */
const preWxt = [1, 50, 51, 100].map((id) => ({
  id,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://cs.money/market/sell/' }] },
  condition: { domains: ['fixture-extension'], urlFilter: 'https://cs.money/1.0/market/sell-orders*', resourceTypes: ['xmlhttprequest'] },
}));

function store(...rules: { id: number }[]) {
  storedRules = new Map(rules.map((entry) => [entry.id, structuredClone(entry)]));
}
function sortedIds() {
  return [...storedRules.keys()].toSorted((a, b) => a - b);
}
const noop = () => undefined;

describe('legacy DNR migration', () => {
  it('keeps background flows working after the auto-update, with no web visit: one atomic move to 20xx', async () => {
    store(haloSkins, legacyCsMoney, legacyCsFloat, legacySkinport);
    const snapshots: number[][] = [];
    updateDynamicRules.mockImplementationOnce(async (update: { removeRuleIds: number[]; addRules: { id: number }[] }) => {
      update.removeRuleIds.forEach((id) => storedRules.delete(id));
      update.addRules.forEach((entry) => storedRules.set(entry.id, entry));
      snapshots.push(sortedIds());
    });
    await migrateLegacyPageDnrRules();
    // A single update both removes the 10xx rules and adds their replacements: never a moment without the rewrites.
    expect(updateDynamicRules).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([[1014, 2001, 2002, 2007]]);
    // Same headers and filter (auto-reprice: cs.money sell-orders, CSFloat PATCH Origin), plus the T5 exclusion.
    expect(storedRules.get(2001)).toEqual(pageRule(2001, 'cs.money', csMoneyHeaders, { ...OWN, excludedInitiatorDomains: ['cs.money'] }));
    expect(storedRules.get(2002)).toEqual(pageRule(2002, 'csfloat.com', csFloatHeaders, { ...OWN, excludedInitiatorDomains: ['csfloat.com'] }));
    // Not granted in this profile: kept (inert without host access) so a later grant needs no web visit either.
    expect(storedRules.get(2007)).toMatchObject({ condition: { urlFilter: '|https://skinport.com/', ...OWN, excludedInitiatorDomains: ['skinport.com'] } });
    expect(storedRules.get(1014)).toEqual(haloSkins);
    expect(contains).not.toHaveBeenCalled();
    // Idempotent: the next worker start changes nothing.
    await migrateLegacyPageDnrRules();
    expect(updateDynamicRules).toHaveBeenCalledOnce();
  });

  it('re-validates every stored id and removes only invalid rules or the loser of a slot', async () => {
    const current = pageRule(2001, 'cs.money', csMoneyHeaders, { ...OWN, excludedInitiatorDomains: ['cs.money'] });
    const kept = pageRule(2999, 'csfloat.com', csFloatHeaders, { ...OWN, excludedInitiatorDomains: ['csfloat.com'] });
    const redirect = { ...pageRule(2500, 'cs.money', csMoneyHeaders), action: { type: 'redirect', redirect: { url: 'https://foreign.test/' } } };
    const responseHeaders = { ...pageRule(2600, 'cs.money', csMoneyHeaders), action: { type: 'modifyHeaders', responseHeaders: [{ header: 'Content-Security-Policy', operation: 'remove' }] } };
    store(
      haloSkins,
      ...preWxt,
      legacyCsMoney, // loses slot 2001 to the rule the new web already installed there
      current,
      legacyCsFloat, // takes slot 2002 from the invalid rule below
      pageRule(2002, 'csfloat.com', [{ header: 'Cookie', operation: 'set', value: 'fixture' }]),
      redirect,
      responseHeaders,
      pageRule(2700, 'fixture-extension', csMoneyHeaders),
      pageRule(1013, 'quicktrade.skin', csMoneyHeaders),
      pageRule(3005, 'steamcommunity.com', [{ header: 'Origin', operation: 'remove' }]), // valid: moves to 2005
      pageRule(999, 'cs.money', csMoneyHeaders), // valid, but slot 2999 is taken
      kept
    );
    await migrateLegacyPageDnrRules();
    expect(updateDynamicRules).toHaveBeenCalledExactlyOnceWith({
      removeRuleIds: [1, 50, 51, 100, 1001, 1002, 2002, 2500, 2600, 2700, 1013, 3005, 999],
      addRules: [
        pageRule(2002, 'csfloat.com', csFloatHeaders, { ...OWN, excludedInitiatorDomains: ['csfloat.com'] }),
        pageRule(2005, 'steamcommunity.com', [{ header: 'Origin', operation: 'remove' }], { ...OWN, excludedInitiatorDomains: ['steamcommunity.com'] }),
      ],
    });
    expect(sortedIds()).toEqual([1014, 2001, 2002, 2005, 2999]);
    expect(storedRules.get(2001)).toEqual(current);
    expect(storedRules.get(2999)).toEqual(kept);
  });

  it('normalises a 20xx rule the new web installed through extension 1.0.56 (no initiator exclusion yet)', async () => {
    store(pageRule(2001, 'cs.money', csMoneyHeaders));
    await migrateLegacyPageDnrRules();
    expect(updateDynamicRules).toHaveBeenCalledExactlyOnceWith({ removeRuleIds: [2001], addRules: [pageRule(2001, 'cs.money', csMoneyHeaders, { ...OWN, excludedInitiatorDomains: ['cs.money'] })] });
  });

  it('reads browser echoes of absent fields (Firefox nulls, the case flag) without dropping the rule or churning', async () => {
    const firefoxShaped = {
      id: 1001,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: csMoneyHeaders.map((header) => ({ value: null, ...header })), responseHeaders: null, redirect: null },
      condition: {
        ...legacyCsMoney.condition,
        isUrlFilterCaseSensitive: false,
        regexFilter: null,
        requestDomains: null,
        initiatorDomains: null,
        excludedInitiatorDomains: null,
        domainType: null,
        tabIds: null,
      },
    };
    store(firefoxShaped);
    await migrateLegacyPageDnrRules();
    expect(storedRules.get(2001)).toEqual(pageRule(2001, 'cs.money', csMoneyHeaders, { ...OWN, excludedInitiatorDomains: ['cs.money'] }));
    // The browser echoes the stored rule with its defaults filled in: nothing to change on the next start.
    const stored = storedRules.get(2001) as PageDnrRule;
    store({ ...stored, condition: { ...stored.condition, isUrlFilterCaseSensitive: false, tabIds: null } } as unknown as PageDnrRule);
    await migrateLegacyPageDnrRules();
    expect(updateDynamicRules).toHaveBeenCalledOnce();
  });

  it('serialises with page installs, so neither overwrites the other', async () => {
    store(haloSkins, legacyCsMoney);
    let release: () => void = noop;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    getDynamicRules.mockImplementationOnce(async () => {
      const snapshot = [...storedRules.values()];
      await pending;
      return snapshot;
    });
    const fresh = { ...rule, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'set', value: 'https://cs.money' }] } };
    const migration = migrateLegacyPageDnrRules();
    const install = installPageDnrRules({ rules: [fresh] });
    release();
    await migration;
    expect(await install).toMatchObject({ status: 'ok', installedIds: [2001] });
    expect(sortedIds()).toEqual([1014, 2001]);
    expect(storedRules.get(2001)).toEqual({ ...fresh, condition: { ...fresh.condition, ...OWN, excludedInitiatorDomains: ['cs.money'] } });
  });

  it('skips an unavailable DNR API', async () => {
    vi.stubGlobal('browser', {});
    await expect(migrateLegacyPageDnrRules()).resolves.toBeUndefined();
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
  it.each(['read', 'update'])('retries failed %s on the next startup without exposing browser text or losing rules', async (stage) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      storedRules.set(1001, structuredClone(legacyCsMoney));
      (stage === 'read' ? getDynamicRules : updateDynamicRules).mockRejectedValueOnce(new Error('fixture-private-browser-text'));
      await expect(migrateLegacyPageDnrRules()).resolves.toBeUndefined();
      expect(storedRules.get(1001)).toEqual(legacyCsMoney);
      expect(warn).toHaveBeenCalledExactlyOnceWith('[qts background] Legacy DNR cleanup failed');
      await migrateLegacyPageDnrRules();
      expect(sortedIds()).toEqual([1014, 2001]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('QUICK-291: page rules are limited to the extension as initiator', () => {
  /** The acceptance check: every page rule the browser holds rewrites only the extension's own requests. */
  function expectEveryPageRuleOwn(host = 'fixture-extension') {
    const pageRules = [...storedRules.values()].filter(({ id }) => id !== 1014) as PageDnrRule[];
    expect(pageRules.length).toBeGreaterThan(0);
    for (const stored of pageRules) expect(stored.condition.initiatorDomains).toEqual([host]);
  }

  it('installs a page rule for the extension host only, whatever initiator list the page sent', async () => {
    const sent = { ...rule, condition: { ...rule.condition, initiatorDomains: ['csfloat.com', 'fixture-extension'] } };
    expect(await installPageDnrRules({ rules: [sent] })).toEqual({ status: 'ok', installedIds: [2001], rejected: [] });
    expect(storedRules.get(2001)).toEqual(installedRule);
    expectEveryPageRuleOwn();
  });

  it('limits the rules extension 1.11.0 left installed, in one atomic update, on the next worker start', async () => {
    // As 1.11.0 stored them: the T5 exclusion but no initiator list, or one a page sent for another site.
    store(
      haloSkins,
      pageRule(2001, 'cs.money', csMoneyHeaders, { excludedInitiatorDomains: ['cs.money'] }),
      pageRule(2002, 'csfloat.com', csFloatHeaders, { excludedInitiatorDomains: ['csfloat.com'] }),
      pageRule(2005, 'steamcommunity.com', [{ header: 'Origin', operation: 'remove' }], { initiatorDomains: ['evil.test'], excludedInitiatorDomains: ['steamcommunity.com'] })
    );
    await migrateLegacyPageDnrRules();
    expect(updateDynamicRules).toHaveBeenCalledExactlyOnceWith({
      removeRuleIds: [2001, 2002, 2005],
      addRules: [
        pageRule(2001, 'cs.money', csMoneyHeaders, { ...OWN, excludedInitiatorDomains: ['cs.money'] }),
        pageRule(2002, 'csfloat.com', csFloatHeaders, { ...OWN, excludedInitiatorDomains: ['csfloat.com'] }),
        pageRule(2005, 'steamcommunity.com', [{ header: 'Origin', operation: 'remove' }], { ...OWN, excludedInitiatorDomains: ['steamcommunity.com'] }),
      ],
    });
    expectEveryPageRuleOwn();
    expect(storedRules.get(1014)).toEqual(haloSkins);
    await migrateLegacyPageDnrRules();
    expect(updateDynamicRules).toHaveBeenCalledOnce();
  });

  it('uses the Firefox per-install UUID, the initiator host of its background page', async () => {
    const uuid = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    getURL.mockReturnValue(`moz-extension://${uuid}/`);
    store(pageRule(2001, 'cs.money', csMoneyHeaders, { initiatorDomains: ['0e0e0e0e-0000-4000-8000-000000000000'], excludedInitiatorDomains: ['cs.money'] }));
    await migrateLegacyPageDnrRules();
    expectEveryPageRuleOwn(uuid);
    expect(await installPageDnrRules({ rules: [{ ...rule, id: 2002, condition: { ...rule.condition, urlFilter: '|https://csfloat.com/' } }] })).toMatchObject({ status: 'ok' });
    expectEveryPageRuleOwn(uuid);
  });
});
