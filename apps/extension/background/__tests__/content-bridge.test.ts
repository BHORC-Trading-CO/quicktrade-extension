import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PageEvent = { source: unknown; origin: string; data: unknown };
let listener: ((event: PageEvent) => void) | undefined;
let start: () => void;
let definition: { matches: string[]; excludeMatches?: string[] } | undefined;
let doc: { prerendering: boolean; addEventListener: ReturnType<typeof vi.fn> };
const postMessage = vi.fn();
const sendMessage = vi.fn();
let page: {
  postMessage: typeof postMessage;
  addEventListener: (type: string, callback: (event: PageEvent) => void) => void;
  removeEventListener: (type: string, callback: (event: PageEvent) => void) => void;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const APP = 'https://app.quicktrade.skin';

function invalidated() {
  return new Error('Extension context invalidated.');
}

/** What Chrome does to a script left behind by an extension reload: `runtime.id` goes away, and every runtime call throws. */
function orphan() {
  const runtime = (browser as unknown as { runtime: { id?: string; getManifest: () => unknown } }).runtime;
  delete runtime.id;
  runtime.getManifest = () => {
    throw invalidated();
  };
  sendMessage.mockImplementation(() => {
    throw invalidated();
  });
}

async function loadContent(origin: string, mode = 'production', pathname = '/sell-mode') {
  vi.stubEnv('MODE', mode);
  vi.stubGlobal('location', { origin, pathname, href: `${origin}${pathname}` });
  await import('../../entrypoints/content');
  start();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  listener = undefined;
  start = () => {
    throw new Error('content entrypoint did not initialize');
  };
  page = {
    postMessage,
    addEventListener: (_type, callback) => {
      listener = callback;
    },
    removeEventListener: (_type, callback) => {
      if (listener === callback) listener = undefined;
    },
  };
  vi.stubGlobal('window', page);
  doc = { prerendering: false, addEventListener: vi.fn() };
  vi.stubGlobal('document', doc);
  definition = undefined;
  vi.stubGlobal('defineContentScript', (contentScript: { matches: string[]; excludeMatches?: string[]; main: () => void }) => {
    definition = contentScript;
    start = contentScript.main;
    return contentScript;
  });
  sendMessage.mockResolvedValue({ ok: true, data: {} });
  vi.stubGlobal('browser', {
    runtime: {
      id: 'extension-id',
      onMessage: {
        addListener: vi.fn(),
      },
      sendMessage,
      getManifest: () => ({ version: '1.0.55' }),
    },
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('content script page boundary', () => {
  it('announces listing_blocks and relays snapshots only from the app page', async () => {
    await loadContent(APP);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ name: 'installed', data: expect.objectContaining({ capabilities: expect.arrayContaining(['listing_blocks']) }) }), APP);
    sendMessage.mockClear();
    const data = { type: 'site', name: 'set_listing_blocks', data: { owner: 'user_A', assetIds: ['41'], expiresAt: { '41': 604800100 }, at: 100 } };
    listener?.({ source: page, origin: 'https://foreign.test', data });
    listener?.({ source: {}, origin: APP, data });
    expect(sendMessage).not.toHaveBeenCalled();
    listener?.({ source: page, origin: APP, data });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'site:set_listing_blocks', data: data.data });
  });

  it.each([APP])('uses the exact page targetOrigin %s for announcements and cookie refusals', async (origin) => {
    await loadContent(origin);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ name: 'installed' }), origin);
    sendMessage.mockResolvedValue({ ok: true, data: { requestId: 'refused', value: null, error: 'cookie_not_allowed' } });
    listener?.({
      source: page,
      origin,
      data: { type: 'site', name: 'get_cookie', data: { requestId: 'refused', url: 'https://steamcommunity.com', name: 'steamLoginSecure' } },
    });
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith({ type: 'extension', name: 'cookie_response', data: { requestId: 'refused', value: null, error: 'cookie_not_allowed' } }, origin);
    expect(postMessage.mock.calls.every((call) => call[1] === origin)).toBe(true);
  });

  it('ignores foreign origins and frames for commands and auth handoffs', async () => {
    await loadContent(APP);
    sendMessage.mockClear();
    for (const data of [
      { type: 'site', name: 'get_cookie' },
      { type: 'qts:auth_handoff', data: { auth: {} } },
    ]) {
      listener?.({ source: page, origin: 'https://foreign.test', data });
      listener?.({ source: {}, origin: APP, data });
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    'https://foreign.test',
    'http://localhost:3000',
    'https://quicktrade.skin',
    'https://evil-quicktrade.skin',
    'https://app.quicktrade.skin.evil.com',
    'http://app.quicktrade.skin',
    'https://quicktrade.skin.evil.com',
    'https://x.app.quicktrade.skin',
  ])('does not initialize on %s in production', async (origin) => {
    await loadContent(origin);
    expect(listener).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('allows localhost only in development and uses its exact port in replies', async () => {
    await loadContent('http://localhost:4123', 'development');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ name: 'installed' }), 'http://localhost:4123');
    expect(postMessage.mock.calls.some((call) => call[1] === '*')).toBe(false);
  });

  it('does not post an in-flight reply after navigating to a disallowed origin', async () => {
    await loadContent(APP);
    postMessage.mockClear();
    listener?.({ source: page, origin: APP, data: { type: 'site', name: 'get_cookie', data: {} } });
    vi.stubGlobal('location', { origin: 'https://foreign.test' });
    await Promise.resolve();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it.each([APP])('is never injected on server routes of %s (JSON API, Swagger UI), including by re-injection', async (origin) => {
    await loadContent(origin, 'production', '/api/docs');
    expect(definition?.matches).toEqual([`${APP}/*`]);
    expect(definition?.excludeMatches).toEqual([`${APP}/api/*`]);
    expect(listener).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('holds bridge traffic in a prerendered page until activation, announcing once', async () => {
    doc.prerendering = true;
    await loadContent(APP);
    const send = (data: unknown) => listener?.({ source: page, origin: APP, data });
    send({ type: 'site', name: 'probe_installed' });
    send({ type: 'site', name: 'probe_installed' });
    send({ type: 'site', name: 'set_platform_catalog', data: { catalog: [] } });
    send({ type: 'qts:auth_handoff', data: { auth: {}, user: null } });
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();

    const [eventName, activate] = doc.addEventListener.mock.calls[0];
    expect(eventName).toBe('prerenderingchange');
    doc.prerendering = false;
    activate();
    await flush();
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(['site:get_permissions', 'site:set_platform_catalog', 'content:auth_handoff']);
    expect(postMessage.mock.calls.filter(([message]) => message.name === 'installed')).toHaveLength(1);

    send({ type: 'site', name: 'probe_installed' });
    await flush();
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'site:get_permissions' });
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });

  it('announces its capabilities and relays platform statuses with the request id (QUICK-202)', async () => {
    await loadContent(APP);
    // `signed_operation_table` follows only once a real public key is bundled (operation-table.test.ts).
    const { OPERATION_TABLE_PUBLIC_KEY } = await import('@/shared/operation-table-key');
    const capabilities = [
      'platform_statuses',
      'connect_tab',
      'toolbar_connect',
      'market_search',
      'market_feed',
      'market_buy',
      'buy_orders',
      'buy_orders_engine',
      'diagnostics_journal',
      'listing_blocks',
      'scheduler_policy',
      'scheduler_schedule',
      'scheduler_sync',
      'active_browser',
      ...(OPERATION_TABLE_PUBLIC_KEY ? ['signed_operation_table'] : []),
    ];
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ name: 'installed', data: expect.objectContaining({ capabilities }) }), APP);
    sendMessage.mockResolvedValue({ ok: true, data: { requestId: 's1', statuses: [] } });
    listener?.({ source: page, origin: APP, data: { type: 'site', name: 'get_platform_statuses', data: { requestId: 's1', platforms: ['cs.money'] } } });
    await flush();
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'site:get_platform_statuses', data: { requestId: 's1', platforms: ['cs.money'] } });
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'extension', name: 'platform_statuses', data: { requestId: 's1', statuses: [] } }, APP);
  });

  it('relays the Market feed commands with their reply names and the background push (QUICK-231)', async () => {
    let onRuntime: ((message: unknown) => void) | undefined;
    vi.stubGlobal('browser', {
      runtime: {
        id: 'extension-id',
        sendMessage,
        getManifest: () => ({ version: '1.0.55' }),
        onMessage: { addListener: (callback: (message: unknown) => void) => (onRuntime = callback) },
      },
    });
    await loadContent(APP);
    const replies: Array<[string, string]> = [
      ['market_feed_start', 'market_feed_state'],
      ['market_feed_stop', 'market_feed_state'],
      ['market_feed_retry', 'market_feed_state'],
      ['get_market_feed', 'market_feed'],
      ['get_market_feed_buffer', 'market_feed_buffer'],
    ];
    for (const [name, reply] of replies) {
      sendMessage.mockResolvedValue({ ok: true, data: { requestId: name } });
      listener?.({ source: page, origin: APP, data: { type: 'site', name, data: { requestId: name } } });
      await flush();
      expect(sendMessage).toHaveBeenLastCalledWith({ type: `site:${name}`, data: { requestId: name } });
      expect(postMessage).toHaveBeenLastCalledWith({ type: 'extension', name: reply, data: { requestId: name } }, APP);
    }
    onRuntime?.({ type: 'bg:market_feed_update', data: { rows: [], gone: [] } });
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'extension', name: 'market_feed_update', data: { rows: [], gone: [] } }, APP);
    postMessage.mockClear();
    onRuntime?.({ type: 'bg:something_else', data: {} });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('relays the account’s buy orders and their answer (QUICK-232)', async () => {
    await loadContent(APP);
    const snapshot = { clerkId: 'user_1', revision: 3, dailyBudgetCents: null, rules: [], updatedAt: null };
    sendMessage.mockResolvedValue({ ok: true, data: { stored: true, revision: 3 } });
    listener?.({ source: page, origin: APP, data: { type: 'site', name: 'set_buy_orders', data: snapshot } });
    await flush();
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'site:set_buy_orders', data: snapshot });
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'extension', name: 'buy_orders_set', data: { stored: true, revision: 3 } }, APP);
    sendMessage.mockResolvedValue({ ok: false, error: 'buy_orders_refused:invalid' });
    listener?.({ source: page, origin: APP, data: { type: 'site', name: 'set_buy_orders', data: {} } });
    await flush();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'extension', name: 'buy_orders_set', data: { error: 'buy_orders_refused:invalid' } }, APP);
  });

  it('reads permissions only on the install heartbeat, never marketplace statuses', async () => {
    await loadContent(APP);
    for (let i = 0; i < 5; i += 1) listener?.({ source: page, origin: APP, data: { type: 'site', name: 'probe_installed' } });
    await flush();
    expect(new Set(sendMessage.mock.calls.map(([message]) => message.type))).toEqual(new Set(['site:get_permissions']));
  });

  it('does not wait for activation in a normal page', async () => {
    await loadContent(APP);
    expect(doc.addEventListener).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'site:get_permissions' });
  });

  describe('after the extension was reloaded or updated under an open tab', () => {
    const probe = { type: 'site', name: 'probe_installed' };
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    it('stops at the next page message: no request, no reply, no warning, and no listener left', async () => {
      await loadContent(APP);
      await flush();
      sendMessage.mockClear();
      postMessage.mockClear();
      orphan();
      listener?.({ source: page, origin: APP, data: probe });
      await flush();
      expect(listener).toBeUndefined();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('is quiet when the reload lands during a permissions read (the announce never rejects)', async () => {
      await loadContent(APP);
      await flush();
      postMessage.mockClear();
      sendMessage.mockImplementation(() => {
        orphan();
        return Promise.reject(invalidated());
      });
      listener?.({ source: page, origin: APP, data: probe });
      await flush();
      expect(postMessage).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(listener).toBeUndefined();
    });

    it.each([
      ['a relayed command', { type: 'site', name: 'get_active_browser', data: {} }],
      ['an auth handoff', { type: 'qts:auth_handoff', data: { auth: {}, user: null } }],
    ])('is quiet when the reload lands during %s', async (_label, data) => {
      await loadContent(APP);
      await flush();
      sendMessage.mockImplementation(() => {
        orphan();
        return Promise.reject(invalidated());
      });
      listener?.({ source: page, origin: APP, data });
      await flush();
      expect(warn).not.toHaveBeenCalled();
      expect(listener).toBeUndefined();
    });

    it('keeps listening and warning when the background fails while the extension is alive', async () => {
      await loadContent(APP);
      await flush();
      postMessage.mockClear();
      sendMessage.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
      listener?.({ source: page, origin: APP, data: { type: 'site', name: 'get_active_browser', data: {} } });
      await flush();
      expect(warn).toHaveBeenCalledWith('[qts content] background relay failed', expect.any(Error));
      expect(listener).toBeDefined();
      listener?.({ source: page, origin: APP, data: probe });
      await flush();
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ name: 'installed', data: expect.objectContaining({ permissions: {} }) }), APP);
    });
  });
});
