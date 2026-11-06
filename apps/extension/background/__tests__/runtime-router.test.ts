import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleContentMessage } from '../handlers/content';
import { handlePopupMessage } from '../handlers/popup';
import { handleSiteMessage } from '../handlers/site';
import { onRuntimeMessage } from '../runtime-router';

vi.mock('../handlers/content', () => ({ handleContentMessage: vi.fn().mockResolvedValue({ ok: true, data: null }) }));
vi.mock('../handlers/popup', () => ({ handlePopupMessage: vi.fn().mockResolvedValue({ ok: true, data: null }) }));
vi.mock('../handlers/site', () => ({ handleSiteMessage: vi.fn().mockResolvedValue({ ok: true, data: null }) }));
vi.mock('../../shared/config', () => ({ BRIDGE_MODE: 'production' }));

const sender = { id: 'qts', tab: { id: 2 }, frameId: 0, origin: 'https://app.quicktrade.skin', url: 'https://app.quicktrade.skin/sell-mode' };
const LOOKALIKES = [
  'https://quicktrade.skin',
  'https://evil-quicktrade.skin',
  'https://app.quicktrade.skin.evil.com',
  'http://app.quicktrade.skin',
  'https://quicktrade.skin.evil.com',
  'https://x.app.quicktrade.skin',
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('browser', { runtime: { id: 'qts', getURL: () => 'chrome-extension://qts/' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('runtime router trust boundary', () => {
  it.each(['site:get_cookie', 'content:auth_handoff', 'site:set_listing_blocks'])('rejects untrusted %s before dispatch', (type) => {
    for (const untrusted of [
      { ...sender, origin: 'https://foreign.test' },
      { ...sender, origin: 'http://localhost:3000' },
      // A lookalike by its origin, and by its URL when Firefox omits the origin.
      ...LOOKALIKES.flatMap((origin) => [
        { ...sender, origin, url: `${origin}/sell-mode` },
        { ...sender, origin: undefined, url: `${origin}/sell-mode` },
      ]),
      { ...sender, frameId: 2 },
      { ...sender, frameId: 2, documentLifecycle: 'prerender' },
      { ...sender, id: 'other' },
      { ...sender, tab: undefined },
    ]) {
      const reply = vi.fn();
      expect(onRuntimeMessage({ type }, untrusted, reply)).toBe(false);
      expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.stringMatching(/^bridge_/) });
    }
    expect(handleSiteMessage).not.toHaveBeenCalled();
    expect(handleContentMessage).not.toHaveBeenCalled();
  });

  it.each(['https://app.quicktrade.skin'])('dispatches trusted site and Firefox content messages from %s', async (origin) => {
    const reply = vi.fn();
    const page = { ...sender, origin, url: `${origin}/sell-mode` };
    expect(onRuntimeMessage({ type: 'site:get_permissions' }, page, reply)).toBe(true);
    expect(onRuntimeMessage({ type: 'content:auth_handoff' }, { ...page, origin: undefined }, reply)).toBe(true);
    await Promise.resolve();
    expect(handleSiteMessage).toHaveBeenCalledOnce();
    expect(handleContentMessage).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('dispatches a prerendered outermost frame', async () => {
    const reply = vi.fn();
    expect(onRuntimeMessage({ type: 'site:get_permissions' }, { ...sender, frameId: 2, documentLifecycle: 'prerender', frameType: 'outermost_frame' }, reply)).toBe(true);
    await Promise.resolve();
    expect(handleSiteMessage).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
  });

  it('keeps popup-as-tab working and rejects page callers', () => {
    const reply = vi.fn();
    expect(onRuntimeMessage({ type: 'popup:logout' }, sender, reply)).toBe(false);
    expect(handlePopupMessage).not.toHaveBeenCalled();
    expect(onRuntimeMessage({ type: 'popup:logout' }, { ...sender, url: 'chrome-extension://qts/popup.html' }, reply)).toBe(true);
    expect(handlePopupMessage).toHaveBeenCalledOnce();
  });

  it.each([null, {}, { type: 42 }])('rejects malformed message %j', (message) => {
    const reply = vi.fn();
    expect(onRuntimeMessage(message, sender, reply)).toBe(false);
    expect(reply).toHaveBeenCalledWith({ ok: false, error: 'invalid message' });
  });
});

// QUICK-233: the buy-order engine is driven only from the web app's own origin, and a page never starts a rule's buy.
describe('runtime router: the buy-order engine', () => {
  const apex = { ...sender, origin: 'https://quicktrade.skin', url: 'https://quicktrade.skin/buy-orders' };

  it.each(['site:set_buy_orders', 'site:get_buy_orders_engine', 'site:set_buy_orders_lease', 'site:set_buy_orders_stopped', 'site:buy_orders_engine_answer'])(
    'refuses %s from the apex, which serves only the landing, before dispatch',
    (type) => {
      const reply = vi.fn();
      expect(onRuntimeMessage({ type, data: {} }, apex, reply)).toBe(false);
      expect(reply).toHaveBeenCalledWith({ ok: false, error: 'bridge_forbidden_origin' });
      expect(handleSiteMessage).not.toHaveBeenCalled();
    }
  );

  it.each(['site:set_buy_orders', 'site:get_buy_orders_engine', 'site:set_buy_orders_lease'])('dispatches %s from the web app', async (type) => {
    const reply = vi.fn();
    expect(onRuntimeMessage({ type, data: {} }, sender, reply)).toBe(true);
    await Promise.resolve();
    expect(handleSiteMessage).toHaveBeenCalledOnce();
  });

  it.each([{ kind: 'buy_order', ruleId: 'r1' }, { kind: 'anything' }])('answers a page purchase with origin %o as not sent, nothing dispatched', (origin) => {
    const reply = vi.fn();
    const data = { requestId: 'r', attemptId: '00000000-0000-4000-8000-000000000001', source: 'csfloat', listingId: '1', priceCents: 100, origin };
    expect(onRuntimeMessage({ type: 'site:market_buy', data }, sender, reply)).toBe(false);
    expect(reply).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining({ outcome: 'not_sent', sent: false, reason: 'origin_not_allowed' }) });
    expect(handleSiteMessage).not.toHaveBeenCalled();
  });
});
