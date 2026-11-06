import { type DnrRejectionReason, PAGE_DNR_MAX_DOMAINS, type PageDnrRule, validatePageDnrRules } from '@qts/contracts';
import { describe, expect, it } from 'vitest';

function validRule(): PageDnrRule {
  return {
    id: 2001,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] },
    condition: { urlFilter: '|https://cs.money/', resourceTypes: ['xmlhttprequest', 'other'] },
  };
}

/** The extension's own host, as `runtime.getURL('/')` names it (a Chrome id here). */
const EXT = 'abcdefghijklmnopabcdefghijklmnop';

function validate(payload: unknown) {
  return validatePageDnrRules(payload, EXT);
}

/** QUICK-291: an accepted rule rewrites only the extension's own requests. */
function own(rule: PageDnrRule): PageDnrRule {
  return { ...rule, condition: { ...rule.condition, initiatorDomains: [EXT] } };
}

/** What the validator hands to the browser: the extension as the only initiator, and T5 adds the request host's own initiators to the exclusions. */
function withExclusions(rule: PageDnrRule, excludedInitiatorDomains = ['cs.money']): PageDnrRule {
  return own({ ...rule, condition: { ...rule.condition, excludedInitiatorDomains } });
}

function ruleFor(host: string, excludedInitiatorDomains?: string[]): PageDnrRule {
  const condition = { ...validRule().condition, urlFilter: `|https://${host}/api/` };
  return { ...validRule(), condition: excludedInitiatorDomains ? { ...condition, excludedInitiatorDomains } : condition };
}

function rejects(rule: unknown, reason: DnrRejectionReason) {
  expect(validate({ rules: [rule] })).toMatchObject({ accepted: [], rejected: [{ reason }] });
}

describe('page DNR policy', () => {
  it('accepts both id boundaries, optional priority and bounded priorities', () => {
    for (const id of [2000, 2999]) {
      for (const priority of [1, 10, undefined]) {
        const rule = { ...validRule(), id, ...(priority === undefined ? {} : { priority }) };
        if (priority === undefined) delete rule.priority;
        expect(validate({ rules: [rule] })).toEqual({ accepted: [{ rule: withExclusions(rule), host: 'cs.money' }], rejected: [] });
      }
    }
  });

  it.each(['Origin', 'Referer', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest', 'Sec-CH-UA', 'Sec-CH-UA-Mobile', 'Sec-CH-UA-Platform', 'Accept-Language', 'Content-Language', 'X-Client-App'])(
    'accepts case-insensitive set of %s and values up to 512 characters',
    (header) => {
      const rule = { ...validRule(), action: { type: 'modifyHeaders', requestHeaders: [{ header: header.toUpperCase(), operation: 'set', value: 'x'.repeat(512) }] } };
      expect(validate({ rules: [rule] }).rejected).toEqual([]);
      if (header !== 'Origin') rejects({ ...rule, action: { ...rule.action, requestHeaders: [{ header, operation: 'remove' }] } }, 'operation_not_allowed');
    }
  );

  it.each(['redirect', 'allow', 'allowAllRequests', 'block', 'upgradeScheme'])('rejects action %s', (type) => {
    rejects({ ...validRule(), action: { type } }, 'action_not_allowed');
  });
  it.each(['responseHeaders', 'redirect', 'unknown'])('rejects action key %s', (key) => {
    rejects({ ...validRule(), action: { ...validRule().action, [key]: [] } }, 'action_not_allowed');
  });
  it.each(['Cookie', 'Authorization', 'Proxy-Authorization', 'User-Agent', 'Host', 'X-Unknown', '__proto__', 'constructor', ' Origin'])('rejects header %s', (header) => {
    rejects({ ...validRule(), action: { type: 'modifyHeaders', requestHeaders: [{ header, operation: 'set', value: 'fixture' }] } }, 'header_not_allowed');
  });
  it.each(['append', 'SET', 'unknown', null])('rejects operation %s', (operation) => {
    rejects({ ...validRule(), action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation, value: 'fixture' }] } }, 'operation_not_allowed');
  });
  it.each(['a\r\nb', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(513), null, 42, undefined])('rejects unsafe or missing header value %#', (value) => {
    rejects({ ...validRule(), action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'set', value }] } }, 'value_not_allowed');
  });
  it('rejects values on remove and duplicate headers regardless of case', () => {
    rejects({ ...validRule(), action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove', value: '' }] } }, 'value_not_allowed');
    rejects(
      {
        ...validRule(),
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'remove' },
            { header: 'ORIGIN', operation: 'remove' },
          ],
        },
      },
      'header_not_allowed'
    );
  });
  it.each([1001, 1014, 1999, 3000, -1, 2000.5, NaN, Infinity, '2001', null, undefined])('rejects reserved or invalid id %s', (id) => {
    rejects({ ...validRule(), id }, 'id_out_of_range');
  });
  it.each([0, 11, -1, 1.5, NaN, '1', null, undefined])('rejects invalid priority %s', (priority) => {
    rejects({ ...validRule(), priority }, 'invalid_shape');
  });
  it.each(['regexFilter', 'requestDomains', 'excludedRequestDomains', 'tabIds', 'requestMethods', 'isUrlFilterCaseSensitive', 'domainType', 'unknown'])('rejects condition key %s', (key) => {
    rejects({ ...validRule(), condition: { ...validRule().condition, [key]: [] } }, 'condition_not_allowed');
  });
  it.each([
    '|http://cs.money/',
    'https://cs.money/',
    '||cs.money/',
    '|https://*.cs.money/',
    '|https://cs.money^/',
    '|https://cs.money:443/',
    '|https://user@cs.money/',
    '|https://cs.money@foreign.test/',
    '|https://cs.money',
    '|https://cs.money./',
    '|https://CS.MONEY/',
    '|https://cs.money\\@foreign.test/',
    '|https://cs.money%2fforeign.test/',
    '|https://cs.money/*',
    '|https://cs.money/^',
    '|https://cs.money/|',
    '|https://cs.money/\n',
    '|https://cs.money/\0',
    '|https://quicktrade.skin/',
    '|https://app.quicktrade.skin/',
    '|https://api.quicktrade.skin/',
    '|https://localhost/',
    '|https://api.localhost/',
    '|https://127.0.0.1/',
    '|https://127.1/',
    '|https://2130706433/',
    '|https://0x7f000001/',
    '|https://[::1]/',
    '|https://-bad.test/',
    '|https://bad-.test/',
    '|https://bad..test/',
    '|https://bad_host.test/',
    `|https://${'a'.repeat(64)}.test/`,
    `|https://cs.money/${'a'.repeat(2048)}`,
    null,
    undefined,
  ])('rejects unsafe URL filter %#', (urlFilter) => {
    rejects({ ...validRule(), condition: { ...validRule().condition, urlFilter } }, 'url_filter_not_allowed');
  });
  it.each([['main_frame'], ['sub_frame'], ['script'], ['xmlhttprequest', 'main_frame'], ['other', 'other'], [], 'other', null, undefined].map((value) => [value]))(
    'rejects unsafe resource types %#',
    (resourceTypes) => {
      rejects({ ...validRule(), condition: { ...validRule().condition, resourceTypes } }, 'resource_type_not_allowed');
    }
  );
  it.each(['initiatorDomains', 'excludedInitiatorDomains'])('accepts QUICK-173 plain hostname arrays in %s', (key) => {
    const rule = { ...validRule(), condition: { ...validRule().condition, [key]: ['cs.money', 'api.cs.money', 'extension-id'] } };
    // An exclusion list that covers the host is kept as sent; an initiator allowlist is replaced by the extension's own
    // host (QUICK-291) and still gets the T5 exclusion.
    const installed = key === 'excludedInitiatorDomains' ? own(rule) : withExclusions(rule);
    expect(validate({ rules: [rule] })).toEqual({ accepted: [{ rule: installed, host: 'cs.money' }], rejected: [] });
    for (const value of [
      [],
      Array(11).fill('cs.money'),
      ['*.cs.money'],
      ['https://cs.money'],
      ['cs.money:443'],
      ['CS.MONEY'],
      ['cs.money.'],
      ['a\n.test'],
      ['127.0.0.1'],
      [null],
      'cs.money',
      null,
      undefined,
    ]) {
      rejects({ ...rule, condition: { ...rule.condition, [key]: value } }, 'condition_not_allowed');
    }
    expect(validate({ rules: [{ ...rule, condition: { ...rule.condition, [key]: Array(10).fill('cs.money') } }] }).rejected).toEqual([]);
  });
  it.each([
    null,
    'rule',
    [],
    {},
    { id: 2001 },
    { ...validRule(), action: null },
    { ...validRule(), condition: 'condition' },
    { ...validRule(), unknown: true },
    Object.assign(new Date(), validRule()),
  ])('rejects malformed rule %#', (rule) => {
    expect(validate({ rules: [rule] }).accepted).toEqual([]);
  });
  it.each([null, 'payload', undefined, [], {}, { rules: null }, { rules: 'rules' }, { rules: [], removeRuleIds: [1014] }])('rejects malformed payload %#', (payload) => {
    expect(validate(payload)).toEqual({ accepted: [], rejected: [{ id: null, reason: 'invalid_shape' }] });
  });
  it.each([null, [], 'headers', [null], [{ header: 'Origin', operation: 'remove', unexpected: true }], Array(12).fill({ header: 'Origin', operation: 'remove' })].map((value) => [value]))(
    'rejects malformed headers %#',
    (requestHeaders) => {
      rejects({ ...validRule(), action: { type: 'modifyHeaders', requestHeaders } }, 'invalid_shape');
    }
  );
  it('bounds the batch before validation and returns no page data for an oversized batch', () => {
    const rules = Array.from({ length: 50 }, (_, index) => ({ ...validRule(), id: 2000 + index }));
    expect(validate({ rules }).accepted).toHaveLength(50);
    expect(validate({ rules: [...rules, validRule()] })).toEqual({ accepted: [], rejected: [{ id: null, reason: 'too_many_rules' }] });
  });
  it('keeps good rules in a partial batch and rejects duplicate ids without invalidating the first rule', () => {
    expect(validate({ rules: [validRule(), { ...validRule(), id: 1014 }, validRule(), null] })).toEqual({
      accepted: [{ rule: withExclusions(validRule()), host: 'cs.money' }],
      rejected: [
        { id: 1014, reason: 'id_out_of_range' },
        { id: 2001, reason: 'duplicate_id' },
        { id: null, reason: 'invalid_shape' },
      ],
    });
  });
  it('copies accepted data before asynchronous permission checks', () => {
    const rule = validRule();
    const result = validate({ rules: [rule] });
    rule.id = 1014;
    rule.action.requestHeaders[0] = { header: 'Cookie', operation: 'set', value: 'fixture' };
    rule.condition.resourceTypes.pop();
    expect(result.accepted[0]?.rule).toEqual(withExclusions(validRule()));
  });
});

function others(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `other${index}.test`);
}

describe('T5 initiator normalisation', () => {
  it.each([
    ['cs.money', ['cs.money']],
    ['steamcommunity.com', ['steamcommunity.com']],
    ['api.skinswap.com', ['api.skinswap.com', 'skinswap.com']],
    ['buff.163.com', ['buff.163.com', '163.com']],
  ])('excludes the own tab of %s when an older web build sends no list', (host, expected) => {
    expect(validate({ rules: [ruleFor(host)] })).toEqual({ accepted: [{ rule: own(ruleFor(host, expected)), host }], rejected: [] });
  });

  // The lists QUICK-173 (#36) adds to the 14 platform rules, by request host: each already covers its host.
  it.each([
    ['cs.money', ['cs.money']],
    ['csfloat.com', ['csfloat.com']],
    ['steamcommunity.com', ['steamcommunity.com']],
    ['skinport.com', ['skinport.com']],
    ['skinbaron.de', ['skinbaron.de', 'skinbaron.com']],
    ['api.shadowpay.com', ['shadowpay.com']],
    ['api.skin.place', ['skin.place']],
    ['api.skinflow.gg', ['skinflow.gg']],
    ['skinout.gg', ['skinout.gg']],
    ['api.skinswap.com', ['skinswap.com']],
    ['skinsell.gg', ['skinsell.gg']],
    ['waxpeer.com', ['waxpeer.com']],
    ['api.buff.market', ['buff.market']],
    ['buff.163.com', ['buff.163.com']],
  ])('keeps the QUICK-173 list for %s unchanged', (host, sent) => {
    expect(validate({ rules: [ruleFor(host, sent)] })).toEqual({ accepted: [{ rule: own(ruleFor(host, sent)), host }], rejected: [] });
  });

  it('merges a list that does not cover the host, without duplicates', () => {
    const accepted = (sent: string[]) => validate({ rules: [ruleFor('api.skinswap.com', sent)] }).accepted[0]?.rule.condition.excludedInitiatorDomains;
    expect(accepted(['other.test'])).toEqual(['other.test', 'api.skinswap.com', 'skinswap.com']);
    expect(accepted(['other.test', 'skinswap.test', 'other.test'])).toEqual(['other.test', 'skinswap.test', 'api.skinswap.com', 'skinswap.com']);
    expect(accepted(['api.skinswap.com'])).toEqual(['api.skinswap.com']);
    expect(accepted(['www.skinswap.com'])).toEqual(['www.skinswap.com', 'api.skinswap.com', 'skinswap.com']);
  });

  it('keeps the merged list within the enforced maximum', () => {
    expect(PAGE_DNR_MAX_DOMAINS).toBe(10);
    expect(validate({ rules: [ruleFor('cs.money', others(9))] }).accepted[0]?.rule.condition.excludedInitiatorDomains).toEqual([...others(9), 'cs.money']);
    expect(validate({ rules: [ruleFor('api.skinswap.com', others(8))] }).accepted[0]?.rule.condition.excludedInitiatorDomains).toHaveLength(10);
    rejects(ruleFor('cs.money', others(10)), 'condition_not_allowed');
    rejects(ruleFor('api.skinswap.com', others(9)), 'condition_not_allowed');
    expect(validate({ rules: [ruleFor('cs.money', [...others(9), 'cs.money'])] }).rejected).toEqual([]);
  });

  it('copies the sent list', () => {
    const sent = ['other.test'];
    const result = validate({ rules: [ruleFor('cs.money', sent)] });
    sent.push('cs.money');
    expect(result.accepted[0]?.rule.condition.excludedInitiatorDomains).toEqual(['other.test', 'cs.money']);
  });
});

describe('QUICK-291: page rules rewrite only the extension’s own requests', () => {
  // Without an initiator list a rule rewrote the Origin / Referer / Sec-Fetch-* of every request any page or extension
  // in the browser made to that marketplace, not only the extension's proxied ones.
  it.each([
    ['no list (every web build)', undefined],
    ['another site', ['csfloat.com']],
    ['the extension and another site', [EXT, 'other.test']],
  ])('pins initiatorDomains to the extension host when the page sends %s', (_name, initiatorDomains) => {
    const rule = { ...validRule(), condition: { ...validRule().condition, ...(initiatorDomains ? { initiatorDomains } : {}) } };
    expect(validate({ rules: [rule] }).accepted.map((entry) => entry.rule.condition.initiatorDomains)).toEqual([[EXT]]);
  });

  it('pins every accepted rule of a batch', () => {
    const rules = ['cs.money', 'csfloat.com', 'steamcommunity.com', 'api.skinswap.com'].map((host, index) => ({ ...ruleFor(host), id: 2001 + index }));
    const { accepted, rejected } = validate({ rules });
    expect(rejected).toEqual([]);
    expect(accepted.map(({ rule }) => rule.condition.initiatorDomains)).toEqual(rules.map(() => [EXT]));
  });

  it.each(['3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', '12345678-1234-4123-8123-123456789012'])('takes a Firefox per-install UUID (%s) as the extension host', (uuid) => {
    expect(validatePageDnrRules({ rules: [validRule()] }, uuid).accepted[0]?.rule.condition.initiatorDomains).toEqual([uuid]);
  });

  it.each(['', 'cs.money', 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP', 'chrome-extension://abc', '-abc', 'a b', 'x'.repeat(64)])(
    'refuses every rule rather than install one without a usable extension host (%j)',
    (host) => {
      expect(validatePageDnrRules({ rules: [validRule()] }, host)).toEqual({ accepted: [], rejected: [{ id: 2001, reason: 'condition_not_allowed' }] });
    }
  );
});
