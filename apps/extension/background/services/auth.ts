import { StorageKeys } from '@/shared/storage';

export async function handleLogout(): Promise<void> {
  await browser.storage.local.remove([StorageKeys.authToken, StorageKeys.user, 'user_platform_data', StorageKeys.inventorySnapshots]);
}
