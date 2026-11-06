import type { ContentBridgeMessage } from '@qts/contracts';

import { authHandoffRefusedError, validateAuthHandoff } from '@/background/auth-handoff-policy';
import { handleLogout } from '@/background/services/auth';
import type { RuntimeResponse } from '@/shared/messaging';
import { StorageKeys } from '@/shared/storage';

type ContentHandler = (message: ContentBridgeMessage) => Promise<void>;

const CONTENT_HANDLERS: { [K in ContentBridgeMessage['type']]?: ContentHandler } = {
  'content:auth_handoff': async (message) => {
    // Page-supplied identity, read by nothing (QUICK-176): only the validated subset is stored; a refusal leaves storage unchanged.
    const handoff = validateAuthHandoff(message);
    if (typeof handoff === 'string') {
      console.warn('[qts background] auth handoff refused', handoff);
      throw new Error(authHandoffRefusedError(handoff));
    }
    // Signed out: clear all auth/user state.
    if (!handoff.signedIn) {
      await handleLogout();
      return;
    }
    await browser.storage.local.set({
      [StorageKeys.authToken]: handoff.auth,
      ...(handoff.user ? { [StorageKeys.user]: handoff.user } : {}),
    });
    // No summary for this account: never keep the previous account's.
    if (!handoff.user) await browser.storage.local.remove(StorageKeys.user);
  },
};

export async function handleContentMessage(message: ContentBridgeMessage): Promise<RuntimeResponse<null>> {
  const handler = CONTENT_HANDLERS[message.type];
  if (!handler) return { ok: false, error: `unknown content message: ${(message as { type: string }).type}` };
  try {
    await handler(message);
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
