import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPRICE_TICK_ALARM } from '../../models/constants';
import { migrateLegacyPageDnrRules } from '../dnr-service';
import { primeHaloSkins } from '../haloskins-service';
import { processDueRules } from '../scheduler';

vi.mock('../dnr-service', () => ({ migrateLegacyPageDnrRules: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../haloskins-service', () => ({ primeHaloSkins: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../runtime-router', () => ({ onRuntimeMessage: vi.fn() }));
vi.mock('../scheduler', () => ({ ensureIndex: vi.fn().mockResolvedValue(undefined), processDueRules: vi.fn().mockResolvedValue(undefined) }));
const feed = { resume: vi.fn().mockResolvedValue(undefined), tabRemoved: vi.fn() };
vi.mock('../market-feed/service', () => ({ MARKET_FEED_WATCHDOG_ALARM: 'qts:market-feed-watchdog', marketFeed: () => feed }));
const engine = { tabRemoved: vi.fn() };
vi.mock('../active-browser', () => ({ ACTIVE_BROWSER_ALARM: 'qts-active-browser', onActiveBrowserWorking: vi.fn(), tickActiveBrowser: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../buy-orders/service', () => ({ buyOrderEngine: () => engine, resumeBuyOrderEngine: vi.fn().mockResolvedValue(undefined) }));

type Alarm = { name: string; periodInMinutes?: number };

/** The body passed to defineBackground: the real bundle runs it on every service-worker start. */
let startWorker: () => void = () => {
  throw new Error('background entrypoint did not register');
};
/** Alarms live in the browser, so they survive worker restarts; module state does not matter here. */
let alarmStore: Map<string, Alarm>;
const added = vi.fn();
const removed = vi.fn();
const onAlarm = vi.fn();
const onInstalled = vi.fn();
const onTabRemoved = vi.fn();
const getAlarm = vi.fn(async (name: string) => alarmStore.get(name));
const createAlarm = vi.fn(async (name: string, info: Omit<Alarm, 'name'>) => {
  alarmStore.set(name, { name, ...info });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  vi.stubGlobal('defineBackground', (main: () => void) => {
    startWorker = main;
  });
  await import('../../entrypoints/background');
});

beforeEach(() => {
  vi.clearAllMocks();
  alarmStore = new Map();
  vi.stubGlobal('browser', {
    runtime: { onMessage: { addListener: vi.fn() }, onInstalled: { addListener: onInstalled }, onStartup: { addListener: vi.fn() } },
    storage: { local: { remove: vi.fn() } },
    permissions: { onAdded: { addListener: added }, onRemoved: { addListener: removed } },
    alarms: { get: getAlarm, create: createAlarm, onAlarm: { addListener: onAlarm } },
    tabs: { onRemoved: { addListener: onTabRemoved } },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('background entrypoint', () => {
  it('migrates legacy DNR on worker startup and install/update', async () => {
    startWorker();
    await flush();
    expect(migrateLegacyPageDnrRules).toHaveBeenCalledOnce();
    const installed: () => void = onInstalled.mock.calls[0][0];
    installed();
    expect(migrateLegacyPageDnrRules).toHaveBeenCalledTimes(2);
    startWorker();
    expect(migrateLegacyPageDnrRules).toHaveBeenCalledTimes(3);
  });

  it('primes HaloSkins on startup and permission grant/revoke, with no polling alarm', async () => {
    startWorker();
    await flush();
    expect(primeHaloSkins).toHaveBeenCalledOnce();
    const onAdded: () => void = added.mock.calls[0][0];
    const onRemoved: () => void = removed.mock.calls[0][0];
    onAdded();
    onRemoved();
    expect(primeHaloSkins).toHaveBeenCalledTimes(3);

    // QUICK-305's lease alarm sits beside the reprice tick; no HaloSkins polling alarm.
    expect([...alarmStore.keys()].sort()).toEqual([REPRICE_TICK_ALARM, 'qts-active-browser'].sort());
    const alarm: (event: { name: string }) => void = onAlarm.mock.calls[0][0];
    alarm({ name: 'qts:prime-haloskins' });
    alarm({ name: 'unrelated' });
    expect(primeHaloSkins).toHaveBeenCalledTimes(3);
    expect(processDueRules).toHaveBeenCalledOnce(); // the startup pass only
    alarm({ name: REPRICE_TICK_ALARM });
    expect(processDueRules).toHaveBeenCalledTimes(2);
  });

  it('creates the reprice tick once across worker restarts instead of resetting its schedule', async () => {
    startWorker();
    await flush();
    startWorker();
    await flush();
    // Two periodic alarms (the reprice tick, QUICK-305's lease), each looked up on both starts and created once.
    expect(getAlarm).toHaveBeenCalledTimes(4);
    expect(createAlarm).toHaveBeenCalledTimes(2);
    expect(createAlarm).toHaveBeenCalledWith(REPRICE_TICK_ALARM, { periodInMinutes: 360 });
    expect(createAlarm).toHaveBeenCalledWith('qts-active-browser', { periodInMinutes: 1 });
  });

  it('recreates the tick when its period changed or the lookup fails', async () => {
    alarmStore.set(REPRICE_TICK_ALARM, { name: REPRICE_TICK_ALARM, periodInMinutes: 60 });
    startWorker();
    await flush();
    expect(createAlarm).toHaveBeenCalledWith(REPRICE_TICK_ALARM, { periodInMinutes: 360 });

    createAlarm.mockClear();
    getAlarm.mockRejectedValueOnce(new Error('alarms unavailable'));
    startWorker();
    await flush();
    expect(createAlarm).toHaveBeenCalledWith(REPRICE_TICK_ALARM, { periodInMinutes: 360 });
  });

  it('resumes the Market live feed on start and on its watchdog alarm, and drops a closed tab’s lease (QUICK-231)', async () => {
    startWorker();
    await flush();
    expect(feed.resume).toHaveBeenCalledOnce();
    const alarm: (fired: Alarm) => void = onAlarm.mock.calls[0][0];
    alarm({ name: 'qts:market-feed-watchdog' });
    expect(feed.resume).toHaveBeenCalledTimes(2);
    alarm({ name: REPRICE_TICK_ALARM });
    expect(feed.resume).toHaveBeenCalledTimes(2);
    const removedTab: (tabId: number) => void = onTabRemoved.mock.calls[0][0];
    removedTab(12);
    expect(feed.tabRemoved).toHaveBeenCalledWith(12);
  });

  // No UI of its own (1.6.0): without a pending connect request the toolbar icon opens the site's Platforms page, MV3
  // `action` or Firefox MV2 `browserAction`. The request path is covered in toolbar-connect.test.ts.
  it.each(['action', 'browserAction'])('opens the Platforms page on a click on the toolbar icon (%s)', async (api) => {
    const onClicked = vi.fn();
    const createTab = vi.fn().mockResolvedValue(undefined);
    const stubbed = (globalThis as unknown as { browser: Record<string, unknown> }).browser;
    vi.stubGlobal('browser', { ...stubbed, [api]: { onClicked: { addListener: onClicked } }, tabs: { create: createTab } });
    startWorker();
    await flush();
    expect(onClicked).toHaveBeenCalledOnce();
    const clicked: () => void = onClicked.mock.calls[0][0];
    clicked();
    await flush();
    expect(createTab).toHaveBeenCalledWith({ url: expect.stringMatching(/\/platforms$/) });
  });
});
