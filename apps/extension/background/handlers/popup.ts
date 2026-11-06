import type { PlatformStatus, RuntimeMessage, RuntimeResponse } from '@/shared/messaging';

import { handleLogout } from '../services/auth';

type PopupHandler = (message: RuntimeMessage) => Promise<unknown>;

/**
 * The extension no longer talks to platform APIs directly — it's a pure HTTP
 * proxy now (see `background/proxy.ts`). Platform status, inventory, and sync
 * are owned by the web app, which calls `site:proxy_request` for the data it
 * needs and pushes results into its own state. No popup view sends the status
 * messages any more (the unused StatusView was removed in QUICK-176); they keep
 * answering empty snapshots for backward compatibility.
 */
const POPUP_HANDLERS: { [K in RuntimeMessage['type']]?: PopupHandler } = {
  'popup:get_platforms_status': async (): Promise<PlatformStatus[]> => [],
  'popup:refresh_inventory': async (): Promise<PlatformStatus[]> => [],
  'popup:trigger_sync': async (): Promise<PlatformStatus[]> => [],
  'popup:logout': async () => {
    await handleLogout();
    return null;
  },
};

export async function handlePopupMessage(message: RuntimeMessage): Promise<RuntimeResponse<unknown>> {
  const handler = POPUP_HANDLERS[message.type];
  if (!handler) return { ok: false, error: `unknown message type: ${(message as { type: string }).type}` };
  try {
    const data = await handler(message);
    return { ok: true, data };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
