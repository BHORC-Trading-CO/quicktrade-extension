// QUICK-202: removing optional access (no user gesture needed). Granting it: toolbar-connect.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConnectService from '../connect-service';

describe('connect service', () => {
  let service: typeof ConnectService;
  const remove = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    remove.mockResolvedValue(true);
    vi.stubGlobal('browser', { permissions: { remove } });
    service = await import('../connect-service');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes only optional access, by the bundled origins', async () => {
    expect(await service.disconnectPlatforms(['cs.money', 'lis-skins.com', 'steamcommunity.com', 'tradeit.gg'])).toEqual(['lis-skins.com', 'tradeit.gg']);
    expect(remove.mock.calls).toEqual([[{ origins: ['https://lis-skins.com/*', 'https://app.lis-skins.com/*'] }], [{ origins: ['https://tradeit.gg/*'] }]]);
  });

  it('reports a platform the browser kept as not removed', async () => {
    remove.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('denied'));
    expect(await service.disconnectPlatforms(['tradeit.gg', 'skinport.com'])).toEqual([]);
  });
});
