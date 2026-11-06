import { describe, expect, it } from 'vitest';

import {
  appExcludeMatchPatterns,
  appMatchPatterns,
  appOriginFromUrl,
  isAllowedAppOrigin,
  isAllowedPageMessage,
  isExcludedAppPath,
  isOwnExtensionPage,
  pageSenderError,
  pageTargetOrigin,
} from '../../shared/bridge-policy';

const trusted = { id: 'qts', tab: { id: 1 }, frameId: 0, origin: 'https://app.quicktrade.skin', url: 'https://app.quicktrade.skin/sell-mode' };
const LOOKALIKES = ['https://evil-quicktrade.skin', 'https://app.quicktrade.skin.evil.com', 'http://app.quicktrade.skin', 'https://quicktrade.skin.evil.com', 'https://x.app.quicktrade.skin'];

describe('bridge origin policy', () => {
  it.each(['https://app.quicktrade.skin'])('accepts the web app origin %s', (origin) => {
    expect(isAllowedAppOrigin(origin, 'production')).toBe(true);
    expect(isAllowedAppOrigin(origin, 'development')).toBe(true);
    expect(pageTargetOrigin(origin, 'production')).toBe(origin);
    expect(pageSenderError({ ...trusted, origin, url: `${origin}/sell-mode` }, 'qts', 'production')).toBeNull();
    expect(pageSenderError({ ...trusted, origin: undefined, url: `${origin}/sell-mode` }, 'qts', 'production')).toBeNull();
    expect(appMatchPatterns('production')).toContain(`${origin}/*`);
    expect(appExcludeMatchPatterns('production')).toContain(`${origin}/api/*`);
  });

  it.each([
    'https://evil.test',
    // The apex serves only the marketing landing since the QUICK-181 move.
    'https://quicktrade.skin',
    'https://quicktrade.skin.evil.test',
    'https://sub.quicktrade.skin',
    'http://quicktrade.skin',
    'https://quicktrade.skin:444',
    'https://app.quicktrade.skin:444',
    'null',
    'file:///',
    'https://quicktrade.skin/',
    'https://app.quicktrade.skin/',
    ...LOOKALIKES,
  ])('rejects %s', (origin) => {
    expect(isAllowedAppOrigin(origin, 'production')).toBe(false);
    expect(isAllowedAppOrigin(origin, 'development')).toBe(false);
    expect(pageTargetOrigin(origin, 'production')).toBeNull();
  });

  it.each(LOOKALIKES)('refuses a sender and page messages on the lookalike %s, also by URL when Firefox omits the origin', (origin) => {
    const page = {};
    expect(pageSenderError({ ...trusted, origin, url: `${origin}/sell-mode` }, 'qts', 'production')).toBe('bridge_forbidden_origin');
    expect(pageSenderError({ ...trusted, origin: undefined, url: `${origin}/sell-mode` }, 'qts', 'production')).toBe('bridge_forbidden_origin');
    expect(isAllowedPageMessage({ source: page, origin }, page, origin, 'production')).toBe(false);
  });

  it.each(['http://localhost', 'http://localhost:3000', 'http://localhost:51999'])('allows %s only in development', (origin) => {
    expect(isAllowedAppOrigin(origin, 'production')).toBe(false);
    expect(isAllowedAppOrigin(origin, 'development')).toBe(true);
    expect(pageSenderError({ ...trusted, origin }, 'qts', 'production')).toBe('bridge_forbidden_origin');
    expect(pageSenderError({ ...trusted, origin }, 'qts', 'development')).toBeNull();
    expect(appMatchPatterns('development')).toContain('http://localhost/*');
    expect(appMatchPatterns('production')).toEqual(['https://app.quicktrade.skin/*']);
  });

  it.each(['http://localhost.evil.test', 'http://127.0.0.1', 'https://localhost', 'http://localhost/path', 'http://user@localhost'])('rejects dev lookalike %s', (origin) => {
    expect(isAllowedAppOrigin(origin, 'development')).toBe(false);
  });

  it('fails closed for non-development modes', () => {
    expect(isAllowedAppOrigin('http://localhost:3000', 'staging')).toBe(false);
  });

  it('uses an exact parsed web origin for reinjection and Firefox URL fallback', () => {
    expect(appOriginFromUrl(trusted.url)).toBe(trusted.origin);
    expect(appOriginFromUrl('blob:https://quicktrade.skin/id')).toBe('');
    expect(appOriginFromUrl('bad URL')).toBe('');
    expect(pageSenderError({ ...trusted, origin: undefined }, 'qts', 'production')).toBeNull();
    expect(pageSenderError({ ...trusted, origin: 'null' }, 'qts', 'production')).toBe('bridge_forbidden_origin');
    expect(pageSenderError({ ...trusted, origin: undefined, url: 'https://quicktrade.skin.evil.test/' }, 'qts', 'production')).toBe('bridge_forbidden_origin');
  });

  it('accepts only this extension in a top-level tab frame', () => {
    expect(pageSenderError(trusted, 'qts', 'production')).toBeNull();
    expect(pageSenderError({ ...trusted, id: 'other-extension' }, 'qts', 'production')).toBe('bridge_untrusted_sender');
    expect(pageSenderError({ ...trusted, id: undefined }, 'qts', 'production')).toBe('bridge_untrusted_sender');
    expect(pageSenderError({ ...trusted, frameId: 1 }, 'qts', 'production')).toBe('bridge_not_top_frame');
    expect(pageSenderError({ ...trusted, frameId: undefined }, 'qts', 'production')).toBe('bridge_not_top_frame');
    expect(pageSenderError({ ...trusted, tab: undefined }, 'qts', 'production')).toBe('bridge_not_top_frame');
  });

  it('accepts a Chrome-prerendered main frame only when the browser reports it as outermost', () => {
    const prerendered = { ...trusted, frameId: 7, documentLifecycle: 'prerender', frameType: 'outermost_frame' };
    expect(pageSenderError(prerendered, 'qts', 'production')).toBeNull();
    // Chrome's MessageSender has no frameType today: without it the non-zero frameId is still refused.
    expect(pageSenderError({ ...prerendered, frameType: undefined }, 'qts', 'production')).toBe('bridge_not_top_frame');
    expect(pageSenderError({ ...prerendered, frameType: 'sub_frame' }, 'qts', 'production')).toBe('bridge_not_top_frame');
    expect(pageSenderError({ ...prerendered, frameType: 'fenced_frame' }, 'qts', 'production')).toBe('bridge_not_top_frame');
    expect(pageSenderError({ ...prerendered, documentLifecycle: 'active' }, 'qts', 'production')).toBe('bridge_not_top_frame');
    expect(pageSenderError({ ...prerendered, frameId: undefined }, 'qts', 'production')).toBe('bridge_not_top_frame');
    expect(pageSenderError({ ...prerendered, tab: undefined }, 'qts', 'production')).toBe('bridge_not_top_frame');
    // Origin and extension checks are unchanged for prerendered senders.
    expect(pageSenderError({ ...prerendered, origin: 'https://evil.test' }, 'qts', 'production')).toBe('bridge_forbidden_origin');
    expect(pageSenderError({ ...prerendered, id: 'other-extension' }, 'qts', 'production')).toBe('bridge_untrusted_sender');
    expect(pageSenderError({ ...trusted, documentLifecycle: 'prerender' }, 'qts', 'production')).toBeNull();
  });

  it('keeps the bridge off server routes (JSON API and Swagger UI)', () => {
    expect(appExcludeMatchPatterns('production')).toEqual(['https://app.quicktrade.skin/api/*']);
    expect(appExcludeMatchPatterns('development')).toEqual(['http://localhost/api/*', 'https://app.quicktrade.skin/api/*']);
    expect(isExcludedAppPath('/api/docs')).toBe(true);
    expect(isExcludedAppPath('/api/market/price-stats/x')).toBe(true);
    for (const path of ['/', '/sell-mode', '/apis', '/settings/api/']) expect(isExcludedAppPath(path)).toBe(false);
  });

  it('checks event source, event origin and the current page origin', () => {
    const page = {};
    expect(isAllowedPageMessage({ source: page, origin: trusted.origin }, page, trusted.origin, 'production')).toBe(true);
    expect(isAllowedPageMessage({ source: page, origin: 'https://evil.test' }, page, trusted.origin, 'production')).toBe(false);
    // A message must come from the page's own origin; the apex (landing only) is no web app origin either.
    expect(isAllowedPageMessage({ source: page, origin: 'https://quicktrade.skin' }, page, trusted.origin, 'production')).toBe(false);
    expect(isAllowedPageMessage({ source: {}, origin: trusted.origin }, page, trusted.origin, 'production')).toBe(false);
    expect(isAllowedPageMessage({ source: page, origin: 'http://localhost:3000' }, page, 'http://localhost:3000', 'production')).toBe(false);
    expect(isAllowedPageMessage({ source: page, origin: 'http://localhost:3000' }, page, 'http://localhost:3000', 'development')).toBe(true);
    expect(isAllowedPageMessage({ source: page, origin: 'http://localhost:3001' }, page, 'http://localhost:3000', 'development')).toBe(false);
    expect(pageTargetOrigin(trusted.origin, 'production')).toBe(trusted.origin);
  });

  it.each(['chrome-extension://qts/', 'moz-extension://qts/'])('accepts popup windows and popup tabs for %s', (root) => {
    expect(isOwnExtensionPage({ id: 'qts', url: `${root}popup.html` }, 'qts', root)).toBe(true);
    expect(isOwnExtensionPage({ id: 'qts', url: `${root}popup.html`, tab: { id: 2 }, frameId: 0 }, 'qts', root)).toBe(true);
    expect(isOwnExtensionPage(trusted, 'qts', root)).toBe(false);
    expect(isOwnExtensionPage({ id: 'qts', url: 'moz-extension://other/popup.html' }, 'qts', root)).toBe(false);
    expect(isOwnExtensionPage({ id: 'other', url: `${root}popup.html` }, 'qts', root)).toBe(false);
  });
});
