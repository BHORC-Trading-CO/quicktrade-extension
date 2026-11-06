// apps/extension/background/device-id.ts
//
// This browser profile's id: made once and kept in storage.local. The buy-order engine's lease (QUICK-233) and the
// account's working browser (QUICK-305) name this browser by it; the key is the one 1.8.0 made for buy orders.
import { isBuyOrderDeviceId } from '@qts/contracts';

const DEVICE_KEY = 'qts:buy_orders_device';

let deviceIdPromise: Promise<string> | null = null;

export function deviceId(): Promise<string> {
  deviceIdPromise ??= (async () => {
    const stored = (await browser.storage.local.get(DEVICE_KEY))[DEVICE_KEY];
    if (isBuyOrderDeviceId(stored)) return stored.toLowerCase();
    const made = crypto.randomUUID();
    await browser.storage.local.set({ [DEVICE_KEY]: made });
    return made;
  })().catch(() => {
    deviceIdPromise = null;
    return crypto.randomUUID();
  });
  return deviceIdPromise;
}

/** Tests: forget the cached id. */
export function resetDeviceIdForTests(): void {
  deviceIdPromise = null;
}
